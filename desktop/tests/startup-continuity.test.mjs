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
  stdin: { contents: "export { createStartupBridge } from './src/preload/startup'; export { StartupReadiness, StartupSettings } from './src/renderer/StartupSettings'; export { BackendConnectionNote } from './src/renderer/backend-status'; export { UpdateBackupCleanupRecovery } from './src/renderer/UpdateBackupDeletionNotice'; export { installStartupBridge } from './src/main/startup/bridge'; export { handlers, opened, dialogResults, dialogCalls } from 'electron';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
  plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }, { name: 'electron-boundary', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'synthetic-electron' }));
    builder.onLoad({ filter: /.*/, namespace: 'synthetic-electron' }, () => ({ contents: `
      export const handlers = new Map(), opened = [], dialogResults = [], dialogCalls = [];
      export const ipcMain = { handle(channel, listener) { handlers.set(channel, listener); } };
      export const dialog = { async showSaveDialog(...args) { dialogCalls.push(args); return dialogResults.shift() ?? { canceled: true }; } };
      export const shell = { async openPath(selected) { opened.push(selected); return ''; } };
    ` }));
  } }],
});
const { createStartupBridge, StartupReadiness, StartupSettings, BackendConnectionNote, UpdateBackupCleanupRecovery, installStartupBridge, handlers, opened, dialogResults, dialogCalls } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

test('启动公开接口只保留原库连接与首次初始化，不提供备份或搬库操作', async () => {
  const calls = [];
  const bridge = createStartupBridge({ invoke: async (...args) => calls.push(args), on() {}, removeListener() {} });
  for (const name of ['backupAndUpdate', 'getDataUpdateState', 'recheckDataUpdate', 'onDataUpdateChanged', 'revealUpdateRecovery']) {
    assert.equal(name in bridge, false, `不应暴露 ${name}`);
  }
  await bridge.retry();
  assert.deepEqual(calls, [['startup:retry']]);
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

test('运行就绪后不再展示环境检查卡，工具缺失也不阻挡普通设置', () => {
  for (const mode of ['external', 'managed']) {
    const html = renderToStaticMarkup(React.createElement(StartupReadiness, {
      state: { mode, phase: 'ready', code: 'ready', revision: 1, helperWarnings: ['cli_unavailable', 'probe_unavailable'] },
    }));
    assert.equal(html, '');
  }
});

test('高级故障排查默认折叠，明确展开后才展示诊断与路径操作', () => {
  const props = {
    state: { mode: 'external', phase: 'ready', code: 'ready', revision: 1, helperWarnings: [] },
    backend: { phase: 'connected', canPrepareConfiguration: true, canSaveStartupPaths: false, canRetryConnection: false },
  };
  const closed = renderToStaticMarkup(React.createElement(StartupSettings, props));
  assert.match(closed, /<summary>故障排查<\/summary>/);
  assert.doesNotMatch(closed, /本机启动路径|机器环境已就绪|停止服务以修改路径/);
  const opened = renderToStaticMarkup(React.createElement(StartupSettings, { ...props, open: true }));
  assert.match(opened, /机器环境已就绪/);
  assert.doesNotMatch(opened, /停止服务以修改路径/);
  assert.match(opened, /disabled=""[^>]*>保存启动路径/);
  assert.equal(renderToStaticMarkup(React.createElement(BackendConnectionNote, { state: props.backend, startup: props.state })), '');
});

test('启动失败显示简明原因、重试与诊断入口，未确认可重试时保持禁用', () => {
  const props = {
    state: { mode: 'external', phase: 'blocked', code: 'runtime_components_unavailable', revision: 1, helperWarnings: [] },
    backend: { phase: 'disconnected', canRetryConnection: true },
    onConfigure() {},
  };
  const html = renderToStaticMarkup(React.createElement(StartupReadiness, props));
  assert.match(html, /App 运行组件缺失或校验未通过/);
  assert.match(html, />重试连接<\/button>/);
  assert.match(html, />查看诊断<\/button>/);
  assert.doesNotMatch(html, /Conda|绝对路径|本机启动路径/);
  const blocked = renderToStaticMarkup(React.createElement(StartupReadiness, {
    ...props, backend: { phase: 'shutdown-failed', canRetryConnection: false },
  }));
  assert.match(blocked, /disabled=""[^>]*>重试连接<\/button>/);
  const recovery = renderToStaticMarkup(React.createElement(BackendConnectionNote, {
    state: { phase: 'shutdown-failed', canRetryShutdown: true }, startup: props.state,
  }));
  assert.match(recovery, /重试停读并退出/);
});

test('配置读取在诊断前失败时仍提供恢复入口，不会一直显示连接中', () => {
  const html = renderToStaticMarkup(React.createElement(StartupReadiness, {
    state: { phase: 'idle', revision: 0, helperWarnings: [] },
    backend: { phase: 'disconnected', errorCode: 'backend_connection_failed', canRetryConnection: true },
    onConfigure() {},
  }));
  assert.match(html, /role="alert">本机服务暂时无法启动/);
  assert.match(html, />重试连接<\/button>/);
  assert.match(html, />查看诊断<\/button>/);
  assert.doesNotMatch(html, /正在连接/);
});

test('旧数据库维护态提供重试与诊断入口，不提供本机设置或备份操作', () => {
  const html = renderToStaticMarkup(React.createElement(StartupReadiness, {
    state: { mode: 'external', phase: 'blocked', code: 'cutover_authorization_required', revision: 1, helperWarnings: [] },
  }));
  assert.doesNotMatch(html, /备份|搬库|本机设置/);
  assert.match(html, /重试连接/);
  assert.match(html, /旧数据库/);
});

test('默认 SQLite 启动进度直接显示，不再出现首次本机设置流程', () => {
  const existing = renderToStaticMarkup(React.createElement(StartupReadiness, {
    state: { mode: 'external', phase: 'preparing', step: 'updating-schema', revision: 1, helperWarnings: [] },
  }));
  assert.match(existing, /正在准备本机资料/);
  assert.doesNotMatch(existing, /备份|搬库|首次设置/);
  const maintenance = renderToStaticMarkup(React.createElement(StartupReadiness, {
    state: { mode: 'external', phase: 'blocked', code: 'database_cutover_required', revision: 1, helperWarnings: [] },
  }));
  assert.doesNotMatch(maintenance, /开始本机设置|取消本次设置/);
  assert.match(maintenance, /维护态|旧数据库/);
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

test('管理页公开IPC必须先预览，取消与写失败可安全重试且不触发连接或模型', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'notalone-diagnostic-ipc-'));
  try {
    handlers.clear(); dialogResults.length = 0; dialogCalls.length = 0;
    let connections = 0;
    const windows = { validateCaller(event, args) {
      if (args.length) throw new Error('参数不可用');
      return { webContents: { getURL: () => `notalone://app/#${event.role}` } };
    }, publish() {} };
    installStartupBridge(windows, { getState: () => ({ phase: 'blocked', code: 'sqlite_storage_failed', helperWarnings: [], revision: 0 }), onStateChanged() {} },
      { getState: () => ({ phase: 'disconnected', canRetryConnection: true }), connect() { connections++; } }, userData);
    const inspect = handlers.get('startup:preview-diagnostics');
    const save = handlers.get('startup:export-diagnostics');
    assert.throws(() => inspect({ role: 'helper' }));
    assert.throws(() => inspect({ role: 'manager' }, 'payload'));
    await assert.rejects(save({ role: 'manager' }, 'unpreviewed'));
    const preview = inspect({ role: 'manager' });
    await assert.rejects(save({ role: 'helper' }, preview.previewId));
    await assert.rejects(save({ role: 'manager' }, preview.previewId, 'extra'));
    assert.equal(dialogCalls.length, 0);
    assert.deepEqual(await save({ role: 'manager' }, preview.previewId), { status: 'cancelled' });
    dialogResults.push({ canceled: false, filePath: path.join(userData, 'missing/report.json') });
    await assert.rejects(save({ role: 'manager' }, preview.previewId), /诊断未能导出/);
    const target = path.join(userData, 'report.json');
    dialogResults.push({ canceled: false, filePath: target });
    assert.deepEqual(await save({ role: 'manager' }, preview.previewId), { status: 'saved' });
    assert.equal(await readFile(target, 'utf8'), preview.json);
    assert.equal(connections, 0);
    assert.equal(dialogCalls.length, 3);
  } finally { await rm(userData, { recursive: true, force: true }); }
});

test('受管及外置模式均先显示预览入口，未预览前没有导出按钮', () => {
  for (const mode of ['managed', 'external']) {
    const html = renderToStaticMarkup(React.createElement(StartupSettings, {
      open: true, state: { phase: 'ready', mode, helperWarnings: [], revision: 1 },
      backend: { phase: 'connected', canSaveStartupPaths: false },
    }));
    assert.match(html, /预览诊断/);
    assert.match(html, /不会自动上传/);
    assert.doesNotMatch(html, /将此预览导出到本机/);
  }
});

test('preload诊断入口只接受具名零参数预览和单个预览凭证，不收任意报告或路径', async () => {
  const calls = [];
  const bridge = createStartupBridge({ invoke: async (...args) => calls.push(args), on() {}, removeListener() {} });
  await assert.rejects(bridge.previewDiagnostics('synthetic extra'));
  await assert.rejects(bridge.exportDiagnostics({ path: '/synthetic', report: 'synthetic' }));
  await assert.rejects(bridge.exportDiagnostics('a'.repeat(65)));
  await assert.rejects(bridge.exportDiagnostics('preview', '/synthetic'));
  assert.deepEqual(calls, []);
  await bridge.previewDiagnostics();
  await bridge.exportDiagnostics('preview');
  assert.deepEqual(calls, [['startup:preview-diagnostics'], ['startup:export-diagnostics', 'preview']]);
});
