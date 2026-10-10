import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { build, stop as stopBuild } from 'esbuild';
import { acquireLease, leaseStatus, ownedGroupGone } from './app-test-lease.mjs';
import { withoutExternalTracing } from './test-environment.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function parse(args) {
  if (args[0] === '--probe') {
    const id = args[1];
    if (!/^[a-f\d-]{36}$/.test(id ?? '')) throw new Error('page_test_arguments: 探针标识不可核验');
    if (args.length === 3 && args[2] === '--status') return { mode: 'status', id };
    let hold = 0; let timeout; let uncertain = false;
    args.splice(0, 2);
    while (args.length) {
      const key = args.shift();
      if (key === '--hold-ms') hold = Number(args.shift());
      else if (key === '--timeout-seconds') timeout = Number(args.shift());
      else if (key === '--unconfirmed') uncertain = true;
      else throw new Error('page_test_arguments: 探针参数不可核验');
    }
    if (!Number.isInteger(hold) || hold < 0 || hold > 30_000 || !Number.isInteger(timeout) || timeout < 1 || timeout > 60) throw new Error('page_test_arguments: 探针须有有限时段');
    return { mode: 'probe', id, hold, timeout, uncertain };
  }
  const names = []; let timeout;
  while (args.length) {
    const key = args.shift();
    if (key === '--case' && ['reply-strategy-transition', 'reply-strategy-options', 'reply-strategy-dialogue', 'reply-strategy-invalidation', 'authentic-expression-recovery', 'assistant-session-recovery', 'assistant-session-recovery-guards', 'style-reference', 'style-copy-limits', 'style-copy-origin', 'style-samples', 'fidelity-intent', 'fidelity-content', 'assistant-session-persistence', 'conversation-strategy-entry', 'memory-traces-record-deletion', 'memory-traces-full', 'memory-traces-lifecycle', 'memory-traces', 'memory-reading', 'memory-reading-full', 'memory-stale-full', 'draft-rewrite', 'draft-rewrite-acceptance', 'draft-rewrite-session', 'directed-reply', 'candidate-copy', 'message-events', 'foreground-paused', 'foreground-verified', 'foreground-manual', 'foreground-confirmation-safety', 'source-deletion-full', 'source-deletion-stale-request', 'source-deletion-multi-source', 'source-deletion-unrelated', 'source-deletion-evidence-failure', 'source-deletion-cross-contact', 'source-deletion-replies', 'source-deletion-basic', 'source-deletion-verification', 'source-deletion-unknown', 'source-deletion-arguments', 'import-submit-acceptance', 'import-stale-acceptance', 'import-bootstrap', 'import-bootstrap-prepare-failure', 'binding-consent', 'binding-stale', 'sync-switch', 'sync-backfill-retry', 'sync-arguments', 'sync-control-full', 'reply-evidence', 'memory-editing-owner', 'memory-editing-addition', 'memory-editing-contact-correction', 'memory-editing-removal', 'memory-editing-confirm', 'memory-editing-discard', 'memory-editing-failures', 'memory-editing-arguments', 'memory-editing-stale', 'memory-editing-full'].includes(args[0])) names.push(args.shift());
    else if (key === '--timeout-seconds' && /^\d+$/.test(args[0] ?? '')) timeout = Number(args.shift());
    else throw new Error('page_test_arguments: 需要明确页面范围与有限截止时间');
  }
  if (!names.length || names.length > 2 || new Set(names).size !== names.length || !Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
    throw new Error('page_test_arguments: 页面范围最多两组且不重复，时限为1至300秒');
  }
  return { names, timeout };
}
async function run(options) {
  if (options.mode !== 'probe' && (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX)) throw new Error('page_test_environment: 请先激活 Conda NotAlone');
  if (options.mode !== 'probe') await access('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', constants.X_OK)
    .catch(() => { throw new Error('page_test_browser_unavailable: 本机Chrome不可用；不会下载浏览器'); });
  const until = Date.now() + options.timeout * 1000;
  const lease = await acquireLease({ mode: 'headless', id: options.id, until, desktop, coordinator: 'page-checks' });
  let child; let code = 0; let confirmed = false; let forceTimer; let runtimeAttempted = false;
  const children = [];
  const nonce = randomBytes(32).toString('hex');
  const stop = (status) => {
    code ||= status;
    if (child?.exitCode === null && child.signalCode === null) {
      const owned = child;
      owned.kill('SIGTERM');
      forceTimer ??= setTimeout(() => {
        if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGKILL');
      }, 20_000);
    }
  };
  const interrupt = () => stop(130); const terminate = () => stop(143);
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const deadline = setTimeout(() => stop(124), options.timeout * 1000);
  const executeBuild = (command = process.execPath, args = ['scripts/build.mjs']) => new Promise((resolve) => {
    child = spawn(command, args, { cwd: desktop, detached: true, stdio: 'inherit', env: withoutExternalTracing(process.env) });
    children.push(child);
    child.once('error', () => resolve(2)); child.once('close', (status) => resolve(status ?? 2));
  });
  const executeRunner = (probe) => new Promise((resolve) => {
    runtimeAttempted = true;
    const environment = withoutExternalTracing(Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NOTALONE_') && !key.startsWith('DEEPSEEK_'))));
    child = fork(path.join(desktop, probe ? 'tests/headless/probe-child.mjs' : 'artifacts/headless-runtime/run.mjs'),
      probe ? [String(options.hold), String(options.uncertain)] : [], { cwd: desktop, detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: { ...environment, NOTALONE_DISABLE_DOTENV: '1', NOTALONE_PAGE_RUN_NONCE: nonce, NOTALONE_PAGE_CASES: JSON.stringify(options.names) } });
    children.push(child);
    child.on('message', (message) => {
      if (message?.nonce !== nonce) return;
      if (message.cleanupConfirmed === true) confirmed = true;
      if (message.ready === true) process.stdout.write('page_test_probe_ready: 合成孩子就绪；无浏览器、Electron 未运行。\n');
    });
    child.once('error', () => resolve(2)); child.once('close', (status) => resolve(status ?? 2));
  });
  try {
    if (options.mode === 'probe') { const status = await executeRunner(true); code ||= status; return code; }
    process.stdout.write('验证范围：单个无头Chrome、生产页面与隔离HTTP/PG；Electron 未运行，原生验收未完成。\n');
    const buildStatus = await executeBuild(); code ||= buildStatus;
    if (!code && Date.now() < until) {
      await mkdir(path.join(desktop, 'artifacts/headless-runtime'), { recursive: true });
      const helperStatus = await executeBuild('/usr/bin/xcrun', ['swiftc', 'tests/headless/quiet-observation.swift', '-o', 'artifacts/headless-runtime/quiet-observation']); code ||= helperStatus;
      await build({ entryPoints: [path.join(desktop, 'tests/headless/renderer.ts')], outfile: path.join(desktop, 'artifacts/headless-runtime/renderer.js'), bundle: true, platform: 'browser', format: 'iife' });
      await build({ entryPoints: [path.join(desktop, 'tests/headless/run.ts')], outfile: path.join(desktop, 'artifacts/headless-runtime/run.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external' });
      if (Date.now() >= until || code) { code ||= 124; confirmed = true; }
      else { const status = await executeRunner(false); code ||= status; }
    } else confirmed = true;
    return code;
  } finally {
    clearTimeout(deadline); clearTimeout(forceTimer); process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    stopBuild();
    if ((confirmed || !runtimeAttempted) && children.every(ownedGroupGone)) await lease.release();
    else { process.stderr.write('page_test_cleanup_unconfirmed: 保留本轮租约，禁止下一轮；不杀未知进程。\n'); process.exitCode = 2; }
  }
}
try {
  if (args.length === 1 && args[0] === '--status') {
    process.stdout.write(`${JSON.stringify(await leaseStatus(undefined, 'headless'))}\n验证范围：无头页面租约；Electron 未运行。\n`);
  } else {
    const options = parse(args);
    if (options.mode === 'status') process.stdout.write(`${JSON.stringify(await leaseStatus(options.id, 'headless'))}\nElectron 未运行。\n`);
    else { const status = await run(options); process.exitCode ||= status; }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
