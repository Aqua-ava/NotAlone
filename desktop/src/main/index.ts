import { configureDiagnosticLog,currentDiagnosticTrace,newTraceId,withDiagnosticTrace } from '../../../backend-ts/src/diagnostics/unified';
import { installDiagnosticLogBridge } from './diagnostics/bridge';
import {installSqliteMemoryManagementBridge} from './memory/sqlite-management';
import { DesktopDataLifecycle } from './data-lifecycle';
import { installMessageMediaBridge } from './media/bridge';
import { UsageController } from './usage/controller';
import { installUsageBridge } from './usage/bridge';
import { WechatSetupController } from './setup/wechat-controller';
import { installWechatSetupBridge } from './setup/wechat-bridge';
import { installForegroundBridge } from './foreground/bridge';
import { coordinateSourceContextChanges } from './reply/owner-context-changes';
import { NativeHeaderChangeSource } from './foreground/native-change-source';
import { createHeaderChangeDiagnosticSink,openHeaderChangeDiagnostics } from './foreground/header-change-diagnostics';
import { resolveHeaderChangeSourcePath } from './backend/bundled-helpers';
import { app, dialog, ipcMain, Menu, protocol, session, shell } from 'electron';
import { ScreenPermissionController } from './screen-permission/controller';
import { inspectConfiguredScreenPermission } from './screen-permission/configured';
import { installScreenPermissionBridge } from './screen-permission/bridge';
import path from 'node:path';
import { electronPageCommands } from './electron-page-commands';
import { installResources } from './resources';
import { notifyDevelopmentReady, readDevelopmentServer } from './development';
import { AppWindows } from './windows';
import { BackendHost } from './backend/host';
import { installBackendBridge } from './backend/bridge';
import { installQuitLifecycle } from './backend/quit';
import { installDesktopControls, installWindowActivation } from './desktop-controls';
import { installContactSessionBridge } from './contacts/bridge';
import { ContactDeletionQuiet } from './contacts/deletion-quiet';
import { installReplyBridge } from './reply/bridge';
import { installSqliteDiscussionBridge } from './reply/sqlite-discussion-bridge';
import { installSkillLearningBridge } from './skill-learning/bridge';
import { installFixedMemoryProcessingBridge } from './memory/fixed-processing';
import { installSourceDeletionBridge } from './sources/bridge';
import { installBindingConsentBridge } from './bindings/bridge';
import { installSyncControlBridge } from './sync/bridge';
import { installHistoryClearBridge } from './history-clear/bridge';
import { installContactDeletionBridge } from './contact-deletion/bridge';
import { installContactHistoryBridge } from './contact-history/bridge';
import { SetupController } from './setup/controller';
import { installSetupBridge } from './setup/bridge';
import { StartupDiagnostics } from './startup/diagnostics';
import { installStartupBridge } from './startup/bridge';
import { configureDevelopmentProject, loadBackendConfiguration } from './backend/config';
import { QuarantineLibrary } from '../../../backend-ts/src/history/quarantine-library.ts';
import { QuarantineController } from './quarantine/controller';
import { installQuarantineBridge } from './quarantine/bridge';
import { presentQuarantine } from './quarantine/window';
import { resolveQuarantineRoot } from './quarantine/paths';

app.setName('NotAlone');
const selectedDataPath = app.commandLine.getSwitchValue('user-data-dir');
app.setPath('userData', selectedDataPath && path.isAbsolute(selectedDataPath)
  ? selectedDataPath : path.join(app.getPath('appData'), 'NotAloneDesktop'));
// 后来实例只唤回原窗口，不接受它的 argv、环境或工作目录作为运行配置。
if (!app.requestSingleInstanceLock()) app.exit(0);
const development = readDevelopmentServer(app.isPackaged, process.argv, process.env.NOTALONE_DEV_SERVER);
if (development) {
  configureDevelopmentProject(development.projectDirectory);
  // 开发重启与父进程退场仍走正式的认证停读及生成结算流程。
  process.on('message', message => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'notalone-dev-quit') app.quit();
  });
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());
  process.on('disconnect', () => app.quit());
}
let restoreManager: (() => void) | undefined;
app.on('second-instance', () => restoreManager?.());
protocol.registerSchemesAsPrivileged([
  { scheme: 'notalone', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
// 替换资源失败的窗口时仍保留菜单入口，只有明确退出才结束 App。
app.on('window-all-closed', () => {});

void app.whenReady().then(async () => {
  // 本次界面会话只在内存中，不跨重启保存草稿或网页存储。
  const appSession = session.fromPartition('notalone-app');
  installResources(appSession, development);
  // preload 只按主进程声明的开发态暴露批量修复入口；打包宿主返回 packaged，不注册批量 IPC。
  ipcMain.on('notalone:host-mode', (event) => { event.returnValue = development ? 'development' : 'packaged'; });
  const windows = new AppWindows(appSession);
  const resourcesDirectory = app.isPackaged ? process.resourcesPath : undefined;
  const diagnostics = new StartupDiagnostics(app.getPath('userData'), resourcesDirectory, development?.projectDirectory);
  const backend = new BackendHost(app.getPath('userData'), (config, canStart) => diagnostics.ensureReady(config, canStart), resourcesDirectory);
  if(development){
    const startedAt=performance.now();let previousPhase:string|undefined;
    const logPhase=(state:ReturnType<BackendHost['getState']>)=>{
      if(state.phase===previousPhase)return;previousPhase=state.phase;
      console.info('[notalone-dev-backend]',JSON.stringify({phase:state.phase,elapsedMs:Math.round(performance.now()-startedAt),at:new Date().toISOString()}));
    };
    logPhase(backend.getState());app.once('will-quit',backend.onStateChanged(logPhase));
  }
  installUsageBridge(windows, new UsageController(backend));
  const commands = electronPageCommands(windows);
  const diagnosticRoot = app.getPath('userData');
  const diagnosticLog = configureDiagnosticLog(diagnosticRoot, { proc: 'main', development: !!development });
  process.env.NOTALONE_DIAGNOSTIC_ROOT = diagnosticRoot;
  process.env.NOTALONE_DIAGNOSTIC_LEVEL = development ? 'debug' : 'info';
  installDiagnosticLogBridge(commands, diagnosticRoot, diagnosticLog, async () => {
    const result = await dialog.showSaveDialog({ title: '导出诊断包到本机', defaultPath: 'NotAlone-diagnostics.json',
      filters: [{ name: '诊断 JSON', extensions: ['json'] }], properties: ['showOverwriteConfirmation'] });
    return result.canceled ? undefined : result.filePath;
  });
  app.once('will-quit', () => { void diagnosticLog.close(); });
  const quarantine = new QuarantineController(new QuarantineLibrary(resolveQuarantineRoot(
    app.getPath('appData'), app.getPath('userData'), selectedDataPath)),presentQuarantine);
  installQuarantineBridge(commands, quarantine);
  // 联系人删除窗口先于所有读取方创建：联系人目录、授权目录与同步状态读取在窗口内照常尝试，
  // 失败静默保留旧状态，窗口结束时各自补读一次。
  const contactDeletionQuiet = new ContactDeletionQuiet();
  const contacts = installContactSessionBridge(commands, backend, contactDeletionQuiet);
  const media = installMessageMediaBridge(commands, backend, contacts);
  const foreground = installForegroundBridge(commands, backend, contacts);
  const screenPermission = new ScreenPermissionController({
    inspect: (request, signal) => inspectConfiguredScreenPermission(
      app.getPath('userData'), resourcesDirectory, request, signal),
    openSettings: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'),
    onGranted: () => foreground.screenPermissionRestored(),
  });
  installScreenPermissionBridge(commands, screenPermission);
  foreground.onStateChanged((state) => {
    if (state.reason === 'screen_capture_permission_missing') screenPermission.noteMissing();
  });
  app.on('before-quit', () => screenPermission.dispose());
  const headerChangeDiagnostics = createHeaderChangeDiagnosticSink(openHeaderChangeDiagnostics(process.env));
  const headerChanges = new NativeHeaderChangeSource(async () =>
    resolveHeaderChangeSourcePath(resourcesDirectory, development?.projectDirectory), headerChangeDiagnostics);
  app.on('will-quit', () => headerChangeDiagnostics?.close());
  foreground.attachChangeSource(headerChanges);
  foreground.observeMeasurements(value => headerChanges.recordObservation(value));
  windows.setHelperObservation({ beforeShow: () => foreground.observeBeforeShow(),
    onLifecycle: (event) => { foreground.notifyHelperLifecycle(event); replies.notifyHelperLifecycle(event); } });
  app.on('will-quit', () => foreground.dispose());
  const fixedMemoryProcessing = installFixedMemoryProcessingBridge(commands, backend, contacts);
  const sqliteMemoryManagement = installSqliteMemoryManagementBridge(commands, backend, contacts);
  let memoryScopeRevision = contacts.getState().scopeRevision;
  contacts.onStateChanged(state => {
    if (state.scopeRevision !== memoryScopeRevision) {
      memoryScopeRevision = state.scopeRevision; fixedMemoryProcessing.synchronize(); sqliteMemoryManagement.synchronize('memory_scope_listener','scope_changed');
    }
  });
  const traces = installTraceBridge(commands, backend, contacts);
  const beginReadingScopeChange = () => {
    const traceId=currentDiagnosticTrace()??newTraceId();
    const finishForeground = withDiagnosticTrace(traceId,()=>foreground.beginReadingScopeChange());
    withDiagnosticTrace(traceId,()=>contacts.invalidateReadingScope('reading_scope_begin'));
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      withDiagnosticTrace(traceId,()=>{contacts.invalidateReadingScope('reading_scope_end');finishForeground();});
    };
  };
  // 删除控制器先于授权与同步控制器构造：重连时先打开窗口，后续读取才会按窗口规则保留旧状态并补读。
  let dataLifecycle: DesktopDataLifecycle;
  const contactDeletion = installContactDeletionBridge(commands, backend, contacts, beginReadingScopeChange, (contactId) => {
    if (dataLifecycle && contacts.getState().selectedContactId === contactId) dataLifecycle.withdraw('contact-deletion');
  }, contactDeletionQuiet);
  app.on('before-quit', () => contactDeletion.dispose());
  const bindings = installBindingConsentBridge(commands, backend, contacts, beginReadingScopeChange, contactDeletionQuiet);
  const sync = installSyncControlBridge(commands, backend, contacts, beginReadingScopeChange, contactDeletionQuiet);
  const contactHistory = installContactHistoryBridge(commands, backend, contacts);
  const historyClear = installHistoryClearBridge(commands, backend, contacts);
  app.on('before-quit', () => { bindings.dispose(); sync.dispose(); historyClear.dispose(); contactHistory.dispose(); });
  sync.onStateChanged((state) => foreground.setSyncControlState(state));
  foreground.setSyncControlState(sync.getState());
  const replies = installReplyBridge(commands, backend, contacts, () => foreground.getGenerationBlock());
  const sqliteDiscussion = installSqliteDiscussionBridge(commands, backend, contacts,()=>foreground.getGenerationBlock()===null);
  replies.onSessionDeletion((phase) => { if (phase === 'started') sqliteDiscussion.synchronize(true); });
  installSkillLearningBridge(commands, backend,()=>sqliteDiscussion.synchronize(true));
  dataLifecycle = new DesktopDataLifecycle({history: contactHistory, media, traces,
    processing: fixedMemoryProcessing, management: sqliteMemoryManagement, discussion: sqliteDiscussion, replies});
  let settleHistoryClear: (() => Promise<void>) | undefined;
  let resyncWasComplete = false;
  historyClear.onStateChanged(state => {
    const clearing = state.busy === 'clear';
    if (clearing && !settleHistoryClear && state.contactId) settleHistoryClear = dataLifecycle.beginHistoryClear(state.contactId);
    if (!clearing && settleHistoryClear) {
      const settle = settleHistoryClear; settleHistoryClear = undefined;
      void settle().catch(() => {});
    }
    const completed = state.resync?.completed === true;
    if (completed && !resyncWasComplete && !clearing) void contactHistory.refreshCurrent();
    resyncWasComplete = completed;
  });
  let candidateGenerationBlock=foreground.getGenerationBlock();
  foreground.onStateChanged(() => { replies.refreshGenerationEligibility(); const next=foreground.getGenerationBlock();
    if(next!==candidateGenerationBlock){candidateGenerationBlock=next;sqliteDiscussion.synchronize(true);} });
  const sources = installSourceDeletionBridge(commands, backend, contacts, contactId => dataLifecycle.sourceChanged(contactId));
  coordinateSourceContextChanges(sources, replies);
  sources.onDeletion((phase) => {
    if (phase === 'started') dataLifecycle.withdraw('source-deletion');
  });
  backend.setConnectionChangePreparation(() => dataLifecycle.connectionChanging());
  installSetupBridge(windows, new SetupController(backend));
  installWechatSetupBridge(commands, new WechatSetupController(backend));
  installBackendBridge(windows, backend, () => app.quit());
  installStartupBridge(windows, diagnostics, backend, app.getPath('userData'));
  app.on('before-quit', () => { fixedMemoryProcessing.synchronize(); sqliteMemoryManagement.synchronize('application_quit','application_quit'); sqliteDiscussion.synchronize(true); foreground.stopContinuous(); diagnostics.cancel(); });
  app.on('will-quit', () => sqliteDiscussion.close());
  installQuitLifecycle(backend, windows, async () => {
    await quarantine.close();
    await media.prepareClosing();
    await headerChanges.shutdown();
  });
  foreground.startContinuous();
  void backend.connect().catch(() => {});
  const desktopControls = installDesktopControls(windows);
  app.on('will-quit', () => desktopControls.dispose());
  let quitting = false;
  const openWindow = (role: 'manager' | 'helper') => {
    void windows.open(role).catch(() => {
      if (!quitting) dialog.showErrorBox('NotAlone', '窗口暂时无法打开，请从“窗口”菜单重试。');
    });
  };
  restoreManager = () => openWindow('manager');
  app.on('will-quit', () => { quitting = true; });
  installWindowActivation(() => openWindow('manager'));

  ipcMain.handle('window:open-manager', (event, ...args: unknown[]) => {
    windows.validateCaller(event, args);
    return windows.open('manager');
  });
  ipcMain.handle('window:open-helper', (event, ...args: unknown[]) => {
    windows.validateCaller(event, args);
    return windows.open('helper');
  });
  ipcMain.handle('window:hide', (event, ...args: unknown[]) => {
    windows.validateCaller(event, args).hide();
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'NotAlone', submenu: [
      { label: '关于 NotAlone', role: 'about' },
      { type: 'separator' },
      { label: '隐藏 NotAlone', role: 'hide' },
      { label: '显示全部', role: 'unhide' },
      { type: 'separator' },
      { label: '退出 NotAlone', accelerator: 'Command+Q', click: () => app.quit() },
    ] },
    { label: '编辑', submenu: [
      { label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' },
      { type: 'separator' },
      { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' },
      { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' },
    ] },
    { label: '窗口', submenu: [
      { label: '管理后台', click: () => openWindow('manager') },
      { label: '输入小窗', click: () => openWindow('helper') },
      { type: 'separator' },
      { label: '最小化', role: 'minimize' },
      { label: '关闭窗口', role: 'close' },
    ] },
  ]));
  void windows.open('manager', { background: development?.background }).then(async () => {
    if (development) notifyDevelopmentReady(() => app.quit());
    const config = await loadBackendConfiguration(app.getPath('userData'), resourcesDirectory).catch(() => undefined);
    if (config?.source === 'external') await screenPermission.startup();
  }).catch(() => {
    if (!quitting) dialog.showErrorBox('NotAlone', '窗口暂时无法打开，请从“窗口”菜单重试。');
  });
}).catch(() => {
  dialog.showErrorBox('NotAlone', '应用暂时无法启动，请关闭后重试。');
});
import { installTraceBridge } from './traces/bridge';
