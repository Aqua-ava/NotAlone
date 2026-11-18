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
  stdin: { contents: "export { createStartupBridge } from './src/preload/startup'; export { StartupReadiness, StartupSettings } from './src/renderer/StartupSettings'; export { BackendConnectionNote } from './src/renderer/backend-status'; export { UpdateBackupCleanupRecovery } from './src/renderer/UpdateBackupDeletionNotice'; export { installStartupBridge } from './src/main/startup/bridge'; export { electronPageCommands } from './src/main/electron-page-commands'; export { handlers, opened, dialogResults, dialogCalls } from 'electron';", resolveDir: process.cwd() },
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
const { createStartupBridge, StartupReadiness, StartupSettings, BackendConnectionNote, UpdateBackupCleanupRecovery, installStartupBridge, electronPageCommands, handlers, opened, dialogResults, dialogCalls } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

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
  const sqlite = { phase: 'ready', revision: 1, helperWarnings: [], sqlite: { phase: 'ready', schemaVersion: 24, sqliteVersion: '3.53.4', capabilities: ['contacts', 'skills', 'history'] } };
  assert.equal(renderToStaticMarkup(React.createElement(StartupReadiness, { state: sqlite })), '');
  const props = { state: sqlite, backend: { phase: 'connected', canRetryConnection: false } };
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(StartupSettings, props)), /SQLite 存储诊断/);
  const settings = renderToStaticMarkup(React.createElement(StartupSettings, { ...props, open: true }));
  assert.match(settings, /SQLite 存储诊断/);
  assert.match(settings, /结构版本 24/);
  assert.match(settings, /当前业务数据库和本机资料尚未由应用层加密/);
});

test('高级故障排查默认折叠，明确展开后才展示诊断与路径操作', () => {
  const props = {
    state: { mode: 'external', phase: 'ready', code: 'ready', revision: 1, helperWarnings: [] },
    backend: { phase: 'connected', canSaveStartupPaths: false, canRetryConnection: false },
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

test('仅定位本机资料时不冒称存储已核验，服务连接后不保留等待提示', () => {
  const state = { phase: 'ready', revision: 1, helperWarnings: [], sqlite: { phase: 'prepared', capabilities: ['contacts', 'history'] } };
  const render = phase => renderToStaticMarkup(React.createElement(StartupReadiness, {
    state, backend: { phase, canRetryConnection: false }, showStorageDiagnostics: true,
  }));
  const preparing = render('connecting');
  assert.match(preparing, /已找到本机资料，正在由本机服务核验/);
  assert.doesNotMatch(preparing, /role="alert"|检查未通过|存储已就绪|已开放|结构版本/);
  const connected = render('connected');
  assert.match(connected, /本机服务已连接，资料核验已完成/);
  assert.doesNotMatch(connected, /role="alert"|正在由本机服务核验|结构版本/);
});

test('存储诊断在连接中或停读后不宣称功能开放，恢复连接后才显示可用', () => {
  for (const storagePhase of ['prepared', 'ready']) {
    const state={phase:'ready',revision:1,helperWarnings:[],sqlite:{phase:storagePhase,schemaVersion:24,sqliteVersion:'3.53.4',capabilities:['contacts','history']}};
    const render=phase=>renderToStaticMarkup(React.createElement(StartupReadiness,{state,backend:{phase,canRetryConnection:false},showStorageDiagnostics:true}));
    for (const [phase,expected] of [
      ['connecting','正在由本机服务核验'],['disconnected','本机服务当前未连接'],
      ['stopping','正在停止本次后台读取'],['stopped','本次后台读取已停止'],['shutdown-failed','后台停读尚未获确认'],
    ]) {
      const html=render(phase);assert.ok(html.includes(expected),`${storagePhase}/${phase}应说明实际连接状态`);
      assert.doesNotMatch(html,/存储已就绪|资料核验已完成|已开放联系人/);
    }
    const connected=render('connected');assert.match(connected,/存储已就绪|资料核验已完成/);
    assert.doesNotMatch(connected,/当前未连接|正在停止|已停止|尚未获确认/);
  }
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
  assert.equal(blocked, '', '停读失败由连接状态卡提供恢复入口，不显示启动重试');
  const recovery = renderToStaticMarkup(React.createElement(BackendConnectionNote, {
    state: { phase: 'shutdown-failed', canRetryShutdown: true }, startup: props.state,
  }));
  assert.match(recovery, /重试停读并退出/);
});

test('启动诊断未就绪且连接已断开时仍保留原目标停读恢复入口', () => {
  for (const phase of ['checking', 'blocked']) {
    const startup = { phase, revision: 2, helperWarnings: [] };
    const state = { phase: 'disconnected', canRetryConnection: false, canRetryShutdown: true };
    const html = renderToStaticMarkup(React.createElement(BackendConnectionNote, { state, startup }));
    assert.match(html, />重试停读并退出<\/button>/, `${phase}不得隐藏原目标停读恢复入口`);
    assert.doesNotMatch(html, />重试连接<\/button>/);
    assert.equal(renderToStaticMarkup(React.createElement(BackendConnectionNote, {
      state: { ...state, canRetryShutdown: false }, startup,
    })), '', '没有停读恢复能力时继续复用启动诊断提示');
  }
});

test('存储就绪而后台仍在启动时持续显示连接中，不误报失联', () => {
  const backend = { phase: 'connecting', revision: 1, canRetryConnection: false };
  for (const phase of ['checking', 'ready']) {
    const startup = { phase, revision: 1, helperWarnings: [] };
    const html = renderToStaticMarkup(React.createElement(React.Fragment, null,
      React.createElement(BackendConnectionNote, { state: backend, startup, onDiagnose() {} }),
      React.createElement(StartupReadiness, { state: startup, backend })));
    assert.match(html, /正在连接本机服务/);
    assert.doesNotMatch(html, /尚未连接|连接失败|等待重新连接|>重试连接<\/button>/);
  }
});

test('连接已经完成或开始停读后不再显示启动提示，停读失败只保留停读恢复', () => {
  for (const startupPhase of ['checking', 'ready']) {
    for (const [phase, expected] of [
      ['connected', ''], ['stopping', '正在停止本次后台读取'],
      ['stopped', '本次后台读取已停止'], ['shutdown-failed', '后端关闭未获确认'],
    ]) {
      const startup = { phase: startupPhase, revision: 2, helperWarnings: [] };
      const backend = { phase, canRetryConnection: false, canRetryShutdown: phase === 'shutdown-failed' };
      const html = renderToStaticMarkup(React.createElement(React.Fragment, null,
        React.createElement(BackendConnectionNote, { state: backend, startup, onDiagnose() {} }),
        React.createElement(StartupReadiness, { state: startup, backend })));
      assert.ok(html.includes(expected));
      assert.doesNotMatch(html, /正在启动 NotAlone|正在连接本机服务|尚未连接|>重试连接<\/button>/);
      if (phase === 'connected') assert.equal(html, '');
      if (phase === 'shutdown-failed') assert.match(html, /重试停读并退出/);
    }
  }
});

test('本机服务启动失败按阶段显示安全说明并保留重试和诊断入口',()=>{
  const phrases={runtime:'运行组件未能启动',configuration:'启动配置未通过检查',storage:'数据库未能打开或通过检查',modules:'业务模块初始化失败',handshake:'连接准备未完成'};
  for(const [stage,phrase] of Object.entries(phrases)){
    const html=renderToStaticMarkup(React.createElement(BackendConnectionNote,{
      state:{phase:'disconnected',errorCode:`backend_startup_${stage}_failed`,canRetryConnection:true},
      startup:{phase:'ready'},onDiagnose() {},
    }));
    assert.ok(html.includes(phrase));
    assert.match(html,/>重试连接<\/button>/);assert.match(html,/>查看诊断<\/button>/);
  }
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
      return { webContents: { getURL: () => `notalone://app/index.html#${event.role}` } };
    }, publish() {} };
    const unexpected = () => { throw new Error('历史恢复入口不得启动服务或写配置'); };
    installStartupBridge(windows, electronPageCommands(windows), { onStateChanged() {} }, { connect: unexpected, saveStartupConfiguration: unexpected }, userData);
    for (const channel of ['startup:backup-and-update', 'startup:get-data-update-state', 'startup:recheck-data-update', 'startup:reveal-update-recovery']) {
      assert.equal(handlers.has(channel), false);
    }
    const revealBackup = handlers.get('startup:reveal-update-backup');
    await assert.rejects(async () => revealBackup({ role: 'manager' }));
    assert.deepEqual(await readdir(userData), []);
    const backupDirectory = path.join(userData, 'updates');
    await mkdir(backupDirectory);
    await writeFile(path.join(userData, 'backend-launch.json'), '{"synthetic":"original"}');
    await revealBackup({ role: 'manager' });
    assert.deepEqual(opened, [backupDirectory]);
    assert.equal(await readFile(path.join(userData, 'backend-launch.json'), 'utf8'), '{"synthetic":"original"}');
    assert.deepEqual(await readdir(backupDirectory), []);
    await assert.rejects(async () => revealBackup({ role: 'helper' }));
    await assert.rejects(async () => revealBackup({ role: 'manager' }, '/synthetic/other-path'));
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
      return { webContents: { getURL: () => `notalone://app/index.html#${event.role}` } };
    }, publish() {} };
    installStartupBridge(windows, electronPageCommands(windows), { getState: () => ({ phase: 'blocked', code: 'sqlite_storage_failed', helperWarnings: [], revision: 0 }), onStateChanged() {} },
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
