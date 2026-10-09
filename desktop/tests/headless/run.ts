import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { chromium, type BrowserServer, type Browser } from '@playwright/test';
import { servePageAssets } from './page-host';
import { memoryReading, draftRewrite } from './cases';
import { draftRewriteAcceptance } from './rewrite-acceptance';
import { pendingCleanup } from './cleanup';

const execute = promisify(execFile);
if (!process.send || !/^[a-f0-9]{64}$/.test(process.env.NOTALONE_PAGE_RUN_NONCE ?? '')) {
  throw new Error('page_test_unapproved: 只能由 test:pages 的自有子进程执行。');
}
const cases = JSON.parse(process.env.NOTALONE_PAGE_CASES ?? 'null') as string[];
if (!Array.isArray(cases) || !cases.length || cases.length > 2 || !cases.every((name) => ['memory-reading', 'draft-rewrite', 'draft-rewrite-acceptance'].includes(name))) {
  throw new Error('page_test_arguments: 页面范围不可核验。');
}
let browser: Browser | undefined;
let server: BrowserServer | undefined;
let assets: Awaited<ReturnType<typeof servePageAssets>> | undefined;
let failed = false;
let cleanupConfirmed = false;
let sampleTask: Promise<void> | undefined;
const peaks = { browserKiB: 0, nodeKiB: 0, backendKiB: 0 };
const quiet = { samples: 0, activeSamples: 0, maxOnscreenWindows: 0, maxRegisteredApps: 0, activationPolicies: [] as number[] };
function sample(): Promise<void> {
  if (sampleTask) return sampleTask;
  sampleTask = readMetrics().finally(() => { sampleTask = undefined; });
  return sampleTask;
}
async function readMetrics() {
  // 全局只取父子PID关系，再对本轮子树采集RSS/进程名，避免读取其他App的这些字段。
  const { stdout: relationships } = await execute('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 1000 });
  const tree = relationships.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s*$/.exec(line)).filter(Boolean)
    .map((entry) => ({ pid: Number(entry![1]), parent: Number(entry![2]) }));
  const descendants = (pid: number) => {
    const selected = new Set([pid]);
    let changed = true;
    while (changed) { changed = false; for (const item of tree) if (selected.has(item.parent) && !selected.has(item.pid)) { selected.add(item.pid); changed = true; } }
    return selected;
  };
  const child = server?.process();
  const browserAlive = () => Boolean(child?.pid && child.exitCode === null && child.signalCode === null
    && tree.some((item) => item.pid === child.pid && item.parent === process.pid));
  const browserPids = browserAlive() ? descendants(child!.pid!) : new Set<number>();
  const owned = descendants(process.pid);
  const { stdout } = await execute('/bin/ps', ['-p', [...owned].join(','), '-o', 'pid=,ppid=,rss=,comm='], { timeout: 1000 });
  const processes = stdout.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map((entry) => ({ pid: Number(entry![1]), parent: Number(entry![2]), rss: Number(entry![3]), name: entry![4] }))
    .filter((item) => tree.some((known) => known.pid === item.pid && known.parent === item.parent));
  const total = (select: (item: typeof processes[number]) => boolean) => processes.filter(select).reduce((sum, item) => sum + item.rss, 0);
  peaks.browserKiB = Math.max(peaks.browserKiB, total((item) => browserPids.has(item.pid)));
  peaks.nodeKiB = Math.max(peaks.nodeKiB, total((item) => item.pid === process.pid));
  peaks.backendKiB = Math.max(peaks.backendKiB, total((item) => owned.has(item.pid) && !browserPids.has(item.pid) && /python/i.test(item.name)));
  if (browserPids.size && browserAlive()) {
    const observed = await execute('artifacts/headless-runtime/quiet-observation', [...browserPids].map(String), { timeout: 1500 });
    const state = JSON.parse(observed.stdout) as { active: boolean; onscreenWindows: number; registeredApps: number; activationPolicies: number[] };
    quiet.samples++;
    quiet.activeSamples += state.active ? 1 : 0;
    quiet.maxOnscreenWindows = Math.max(quiet.maxOnscreenWindows, state.onscreenWindows);
    quiet.maxRegisteredApps = Math.max(quiet.maxRegisteredApps, state.registeredApps);
    quiet.activationPolicies = [...new Set([...quiet.activationPolicies, ...state.activationPolicies])];
    if (state.active || state.onscreenWindows) failed = true;
  }
}
const stop = () => { failed = true; void browser?.close(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
const timer = setInterval(() => void sample().catch(() => { failed = true; }), 700);
const completed: string[] = [];
try {
  await mkdir('artifacts/headless-pages', { recursive: true });
  assets = await servePageAssets();
  server = await chromium.launchServer({ channel: 'chrome', headless: true, host: '127.0.0.1' });
  browser = await chromium.connect(server.wsEndpoint());
  await sample();
  for (const name of cases) {
    if (failed) throw new Error('page_test_interrupted: 本轮已停止。');
    process.stdout.write(`page_test_case: ${name}\n`);
    await (name === 'memory-reading' ? memoryReading : name === 'draft-rewrite-acceptance' ? draftRewriteAcceptance : draftRewrite)(browser, assets.origin);
    completed.push(name);
    process.stdout.write(`page_test_passed: ${name}\n`);
  }
  await sample();
  if (failed || !quiet.samples) throw new Error('page_test_observation: 资源或浏览器静默观测未通过。');
} catch (error) {
  failed = true;
  process.stderr.write(`page_test_failed: ${error instanceof Error ? error.message : '页面验证失败'}\n`);
} finally {
  clearInterval(timer);
  await sampleTask?.catch(() => { failed = true; });
  try {
    await browser?.close(); await server?.close(); await assets?.close();
    if (server && server.process().exitCode === null && server.process().signalCode === null) throw new Error('本轮浏览器退出未确认。');
    if (pendingCleanup.size) throw new Error('本轮页面或合成后端收尾未确认。');
    cleanupConfirmed = true;
  } catch { process.stderr.write('page_test_cleanup_unconfirmed: 自有资源收尾未确认。\n'); failed = true; }
  process.off('SIGTERM', stop); process.off('SIGINT', stop);
  const report = { cases: completed, peaksKiB: peaks, quiet, rssMeaning: '自有子树RSS之和的采样峰值，共享页可能重复计；不是物理内存或永久上限', cleanupConfirmed, browserCount: server ? 1 : 0,
    electronRun: false, nativeAcceptance: false };
  await writeFile('artifacts/headless-pages/resources.json', JSON.stringify(report, null, 2));
  process.stdout.write(`page_test_resources: ${JSON.stringify(report)}\n`);
  process.send!({ nonce: process.env.NOTALONE_PAGE_RUN_NONCE, cleanupConfirmed });
  process.disconnect!();
  process.exitCode = failed ? 1 : 0;
}
