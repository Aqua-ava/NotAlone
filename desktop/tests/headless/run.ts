import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { chromium, type BrowserServer, type Browser } from '@playwright/test';
import { servePageAssets } from './page-host';
import { memoryReading, draftRewrite } from './cases';
import { draftRewriteAcceptance, draftRewriteSession } from './rewrite-acceptance';
import { directedReply } from './directed-reply';
import { candidateCopy } from './candidate-copy';
import { sourceDeletionAcceptance, sourceDeletionMultiSourceAcceptance, sourceDeletionUnrelatedAcceptance, sourceDeletionEvidenceFailureAcceptance, sourceDeletionCrossContactAcceptance, sourceDeletionRepliesAcceptance, sourceDeletionVerificationAcceptance, sourceDeletionUnknownAcceptance, sourceDeletionArgumentsAcceptance } from './source-deletion';
import { messageEvents } from './message-events';
import { foregroundPaused, foregroundManual } from './foreground-cases';
import { importSubmitAcceptance, importStaleAcceptance, importBootstrap, importBootstrapPrepareFailure } from './import-acceptance';
import { bindingConsent, bindingStale } from './binding-cases';
import { syncSwitch, syncBackfillRetry } from './sync-cases';
import { replyEvidence } from './evidence-cases';
import { memoryReadingFull, memoryStaleFull } from './memory-cases';
import { memoryEditingFull, memoryEditingStale, memoryEditingArguments, memoryEditingFailures, memoryEditingCandidateDiscard, memoryEditingCandidateConfirmation, memoryEditingRemoval, memoryEditingContactCorrection, memoryEditingAddition, memoryEditingOwner } from './memory-editing';
import { pendingCleanup } from './cleanup';

const execute = promisify(execFile);
if (!process.send || !/^[a-f0-9]{64}$/.test(process.env.NOTALONE_PAGE_RUN_NONCE ?? '')) {
  throw new Error('page_test_unapproved: 只能由 test:pages 的自有子进程执行。');
}
const cases = JSON.parse(process.env.NOTALONE_PAGE_CASES ?? 'null') as string[];
if (!Array.isArray(cases) || !cases.length || cases.length > 2 || !cases.every((name) => ['memory-reading', 'memory-reading-full', 'memory-stale-full', 'draft-rewrite', 'draft-rewrite-acceptance', 'draft-rewrite-session', 'directed-reply', 'candidate-copy', 'message-events', 'foreground-paused', 'foreground-manual', 'source-deletion-multi-source', 'source-deletion-unrelated', 'source-deletion-evidence-failure', 'source-deletion-cross-contact', 'source-deletion-replies', 'source-deletion-basic', 'source-deletion-verification', 'source-deletion-unknown', 'source-deletion-arguments', 'import-submit-acceptance', 'import-stale-acceptance', 'import-bootstrap', 'import-bootstrap-prepare-failure', 'binding-consent', 'binding-stale', 'sync-switch', 'sync-backfill-retry', 'reply-evidence', 'memory-editing-owner', 'memory-editing-addition', 'memory-editing-contact-correction', 'memory-editing-removal', 'memory-editing-confirm', 'memory-editing-discard', 'memory-editing-failures', 'memory-editing-arguments', 'memory-editing-stale', 'memory-editing-full'].includes(name))) {
  throw new Error('page_test_arguments: 页面范围不可核验。');
}
let browser: Browser | undefined;
let server: BrowserServer | undefined;
let assets: Awaited<ReturnType<typeof servePageAssets>> | undefined;
let failed = false;
let cleanupConfirmed = false;
let sampleTask: Promise<void> | undefined;
const ownedIdentities = new Map<number, { pid: number; parent: number; group: number }>();
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
  const { stdout: identities } = await execute('/bin/ps', ['-p', [...owned].join(','), '-o', 'pid=,ppid=,pgid='], { timeout: 1000 });
  for (const line of identities.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match && tree.some((item) => item.pid === Number(match[1]) && item.parent === Number(match[2]))) {
      ownedIdentities.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]) });
    }
  }
  await writeFile('artifacts/headless-pages/owned-identities.json', JSON.stringify({
    runnerPid: process.pid, browserPid: child?.pid ?? null, project: process.cwd(), cases,
    identities: [...ownedIdentities.values()],
  }, null, 2));
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
    await (name === 'foreground-paused' ? foregroundPaused : name === 'foreground-manual' ? foregroundManual : name === 'sync-switch' ? syncSwitch : name === 'sync-backfill-retry' ? syncBackfillRetry : name === 'message-events' ? messageEvents : name === 'source-deletion-multi-source' ? sourceDeletionMultiSourceAcceptance : name === 'source-deletion-unrelated' ? sourceDeletionUnrelatedAcceptance : name === 'source-deletion-evidence-failure' ? sourceDeletionEvidenceFailureAcceptance : name === 'source-deletion-cross-contact' ? sourceDeletionCrossContactAcceptance : name === 'source-deletion-replies' ? sourceDeletionRepliesAcceptance : name === 'source-deletion-unknown' ? sourceDeletionUnknownAcceptance : name === 'source-deletion-arguments' ? sourceDeletionArgumentsAcceptance : name === 'source-deletion-verification' ? sourceDeletionVerificationAcceptance : name === 'source-deletion-basic' ? sourceDeletionAcceptance : name === 'candidate-copy' ? candidateCopy : name === 'import-submit-acceptance' ? importSubmitAcceptance : name === 'import-stale-acceptance' ? importStaleAcceptance : name === 'import-bootstrap' ? importBootstrap : name === 'import-bootstrap-prepare-failure' ? importBootstrapPrepareFailure : name === 'binding-consent' ? bindingConsent : name === 'binding-stale' ? bindingStale : name === 'reply-evidence' ? replyEvidence : name === 'directed-reply' ? directedReply : name === 'memory-editing-full' ? memoryEditingFull : name === 'memory-editing-stale' ? memoryEditingStale : name === 'memory-editing-arguments' ? memoryEditingArguments : name === 'memory-editing-failures' ? memoryEditingFailures : name === 'memory-editing-discard' ? memoryEditingCandidateDiscard : name === 'memory-editing-confirm' ? memoryEditingCandidateConfirmation : name === 'memory-editing-removal' ? memoryEditingRemoval : name === 'memory-editing-contact-correction' ? memoryEditingContactCorrection : name === 'memory-editing-addition' ? memoryEditingAddition : name === 'memory-editing-owner' ? memoryEditingOwner : name === 'memory-reading' ? memoryReading : name === 'memory-reading-full' ? memoryReadingFull : name === 'memory-stale-full' ? memoryStaleFull
      : name === 'draft-rewrite-acceptance' ? draftRewriteAcceptance : name === 'draft-rewrite-session' ? draftRewriteSession : draftRewrite)(browser, assets.origin);
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
