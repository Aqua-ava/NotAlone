import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, readFile, realpath, rm, chmod, writeFile, readdir, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { UnifiedDiagnosticLog } from '../../backend-ts/src/diagnostics/unified-log.mjs';
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-diagnostic-bridge-'))); await chmod(directory, 0o700); after(() => rm(directory, { recursive: true, force: true }));
const backendRequire = createRequire(path.resolve('../backend-ts/package.json'));
const built = await build({ stdin: { contents: `export { installDiagnosticLogBridge, exportDiagnosticBundle } from './src/main/diagnostics/bridge'; export { createDiagnosticLogBridge } from './src/preload/diagnostics';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'installed-pino', setup(plugin) { plugin.onResolve({ filter: /^pino$/ }, () => ({ path: backendRequire.resolve('pino'), external: true })); } }] });
await writeFile(path.join(directory, 'subject.cjs'), built.outputFiles[0].text, { mode: 0o600 });
const { installDiagnosticLogBridge, exportDiagnosticBundle, createDiagnosticLogBridge } = await import(path.join(directory, 'subject.cjs'));
test('设置只注册管理页具名操作，主进程与preload拒绝额外参数和非布尔开关', async () => {
  const log = new UnifiedDiagnosticLog(directory, { proc: 'main', development: true }), handlers = new Map(), calls = [];
  installDiagnosticLogBridge({ handle(channel, handler, role) { assert.equal(role, 'manager'); handlers.set(channel, handler); } }, directory, log, async () => undefined);
  assert.deepEqual([...handlers.keys()], ['diagnostics:get-state', 'diagnostics:set-enabled', 'diagnostics:clear', 'diagnostics:export']);
  const bridge = createDiagnosticLogBridge({ invoke: async (channel, ...args) => { calls.push(channel); return handlers.get(channel)(...args); } });
  assert.equal((await bridge.getState()).enabled, true); assert.equal((await bridge.setEnabled(false)).enabled, false); assert.equal((await bridge.setEnabled(true)).enabled, true);
  await assert.rejects(bridge.setEnabled('false')); await assert.rejects(bridge.getState('arbitrary')); await assert.rejects(bridge.clear('arbitrary')); await assert.rejects(bridge.exportBundle('arbitrary'));
  const before = calls.length;
  for (const [channel, handler] of handlers) {
    if (channel === 'diagnostics:set-enabled') { await assert.rejects(handler('true')); await assert.rejects(handler(true, 'extra')); }
    else await assert.rejects(async () => handler('extra'));
  }
  assert.equal(calls.length, before); await log.close();
});
test('诊断包逐条重验白名单，不输出敏感输入，拒绝导出符号链接', async () => {
  const log = new UnifiedDiagnosticLog(directory, { proc: 'main', development: true });
  log.diagnose({ event: 'request.slow', module: 'memory.management', durationMs: 1001 }); log.diagnose({ event: 'diagnostics.error', module: 'startup', reasonCode: 'failed', stack: 'SENSITIVE_CANARY' }); await log.flush();
  const files = await readdir(path.join(directory, 'logs')); await writeFile(path.join(directory, 'logs', files[0]), JSON.stringify({ event: 'request.slow', module: 'memory.management', level: 'warn', proc: 'main', time: new Date().toISOString(), message: 'SENSITIVE_CANARY' }) + '\n', { flag: 'a' });
  const target = path.join(directory, 'bundle.json');
  assert.deepEqual(await exportDiagnosticBundle(directory, log, async () => undefined), { status: 'cancelled' });
  assert.deepEqual(await exportDiagnosticBundle(directory, log, async () => target), { status: 'saved' });
  const text = await readFile(target, 'utf8'), bundle = JSON.parse(text);
  assert.equal(bundle.formatVersion, 1); assert.equal(bundle.automaticUpload, false); assert.equal(bundle.records.length, 1); assert.ok(!text.includes('SENSITIVE_CANARY')); assert.equal((await lstat(target)).mode & 0o777, 0o600);
  const link = path.join(directory, 'bundle-link.json'); await symlink(target, link); await assert.rejects(exportDiagnosticBundle(directory, log, async () => link)); assert.equal(await readFile(target, 'utf8'), text);
  await log.close();
});
