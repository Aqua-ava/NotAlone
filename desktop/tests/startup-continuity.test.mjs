import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

const require = createRequire(path.resolve('package.json'));
const result = await build({
  stdin: { contents: "export { createStartupBridge } from './src/preload/startup'; export { StartupReadiness } from './src/renderer/StartupSettings'; export { UpdateBackupCleanupRecovery } from './src/renderer/UpdateBackupDeletionNotice'; export { installStartupBridge } from './src/main/startup/bridge'; export { handlers, opened } from 'electron';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
  plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }, { name: 'electron-boundary', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'synthetic-electron' }));
    builder.onLoad({ filter: /.*/, namespace: 'synthetic-electron' }, () => ({ contents: `
      export const handlers = new Map(), opened = [];
      export const ipcMain = { handle(channel, listener) { handlers.set(channel, listener); } };
      export const shell = { async openPath(selected) { opened.push(selected); return ''; } };
    ` }));
  } }],
});
const { createStartupBridge, StartupReadiness, UpdateBackupCleanupRecovery, installStartupBridge, handlers, opened } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

test('启动公开接口只保留原库连接与首次初始化，不提供备份或搬库操作', async () => {
  const calls = [];
  const bridge = createStartupBridge({ invoke: async (...args) => calls.push(args), on() {}, removeListener() {} });
  for (const name of ['backupAndUpdate', 'getDataUpdateState', 'recheckDataUpdate', 'onDataUpdateChanged', 'revealUpdateRecovery']) {
    assert.equal(name in bridge, false, `不应暴露 ${name}`);
  }
  await bridge.retry();
  await bridge.beginLocalSetup();
  assert.deepEqual(calls, [['startup:retry'], ['startup:begin-local-setup']]);
});

test('历史副本清理恢复说明直接显示，无需预先生成说明文件', () => {
  const html = renderToStaticMarkup(React.createElement(UpdateBackupCleanupRecovery));
  assert.match(html, /<details><summary>查看备份清理恢复说明<\/summary>/);
  assert.match(html, /未知|归属不明/);
  assert.match(html, /未完成/);
  assert.match(html, /Finder/);
  assert.match(html, /重试/);
  assert.match(html, /不要.*覆盖当前数据库/);
});

test('已有本机库结构尚待补齐时提供原库重试，不要求备份或另迁数据库', () => {
  const html = renderToStaticMarkup(React.createElement(StartupReadiness, {
    state: { mode: 'managed', phase: 'blocked', code: 'migration_pending', revision: 1, helperWarnings: [] },
  }));
  assert.doesNotMatch(html, /备份|搬库/);
  assert.match(html, /重试本机设置/);
});

test('外置库的结构补齐进度直接显示，首次安装保留本机设置入口', () => {
  const existing = renderToStaticMarkup(React.createElement(StartupReadiness, {
    state: { mode: 'external', phase: 'preparing', step: 'updating-schema', revision: 1, helperWarnings: [] },
  }));
  assert.match(existing, /正在补齐本机数据库结构/);
  assert.doesNotMatch(existing, /备份|搬库|首次设置/);
  const firstRun = renderToStaticMarkup(React.createElement(StartupReadiness, {
    state: { mode: 'managed', phase: 'first-run', code: 'local_setup_required', revision: 1, helperWarnings: [] },
  }));
  assert.match(firstRun, /开始本机设置/);
  assert.doesNotMatch(firstRun, /备份|搬库|兼容更新/);
});

test('历史副本恢复入口只打开既有固定位置，不创建备份、目录或覆盖启动配置', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'notalone-historical-cleanup-'));
  try {
    handlers.clear(); opened.length = 0;
    const windows = { validateCaller(event, args) {
      if (args.length) throw new Error('参数不可用');
      return { webContents: { getURL: () => `notalone://app/#${event.role}` } };
    }, publish() {} };
    const unexpected = () => { throw new Error('历史恢复入口不得启动服务或写配置'); };
    installStartupBridge(windows, { onStateChanged() {} }, { connect: unexpected, saveStartupConfiguration: unexpected }, userData);
    for (const channel of ['startup:backup-and-update', 'startup:get-data-update-state', 'startup:recheck-data-update', 'startup:reveal-update-recovery']) {
      assert.equal(handlers.has(channel), false);
    }
    const revealBackup = handlers.get('startup:reveal-update-backup');
    await assert.rejects(revealBackup({ role: 'manager' }));
    assert.deepEqual(await readdir(userData), []);
    const backupDirectory = path.join(userData, 'updates');
    await mkdir(backupDirectory);
    await writeFile(path.join(userData, 'backend-launch.json'), '{"synthetic":"original"}');
    await revealBackup({ role: 'manager' });
    assert.deepEqual(opened, [backupDirectory]);
    assert.equal(await readFile(path.join(userData, 'backend-launch.json'), 'utf8'), '{"synthetic":"original"}');
    assert.deepEqual(await readdir(backupDirectory), []);
    await assert.rejects(revealBackup({ role: 'helper' }));
    await assert.rejects(revealBackup({ role: 'manager' }, '/synthetic/other-path'));
    assert.equal(opened.length, 1);
  } finally { await rm(userData, { recursive: true, force: true }); }
});
