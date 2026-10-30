import {installSqliteMemoryManagementBridge} from './memory/sqlite-management';
import { installMessageMediaBridge } from './media/bridge';
import { UsageController } from './usage/controller';
import { installUsageBridge } from './usage/bridge';
import { WechatSetupController } from './setup/wechat-controller';
import { installWechatSetupBridge } from './setup/wechat-bridge';
import { installForegroundBridge } from './foreground/bridge';
import { coordinateOwnerContextChanges, coordinateSourceContextChanges } from './reply/owner-context-changes';
import { NativeHeaderChangeSource } from './foreground/native-change-source';
import { openHeaderChangeDiagnostics } from './foreground/header-change-diagnostics';
import { resolveHeaderChangeSourcePath } from './backend/bundled-helpers';
import { CandidateCopyController } from './candidate-copy/controller';
import { installElectronCandidateCopy } from './candidate-copy/electron';
import { app, dialog, ipcMain, Menu, protocol, session, shell } from 'electron';
import { ScreenPermissionController } from './screen-permission/controller';
import { inspectConfiguredScreenPermission } from './screen-permission/configured';
import { installScreenPermissionBridge } from './screen-permission/bridge';
import path from 'node:path';
import { electronPageCommands } from './electron-page-commands';
import { installResources } from './resources';
import { readDevelopmentServer } from './development';
import { AppWindows } from './windows';
import { BackendHost } from './backend/host';
import { installBackendBridge } from './backend/bridge';
import { installQuitLifecycle } from './backend/quit';
import { interruptAssistantGeneration, recoverAssistantGenerationReceipt } from './reply/assistant-generation-interruption';
import { installDesktopControls, installWindowActivation } from './desktop-controls';
import { installContactSessionBridge } from './contacts/bridge';
import { installReplyBridge } from './reply/bridge';
import { installSqliteDiscussionBridge } from './reply/sqlite-discussion-bridge';
import { installCandidateProvenanceBridge } from './candidate-provenance/bridge';
import { installExpressionPreferenceBridge } from './expression-preferences/bridge';
import { expressionPreferenceDeletion } from './expression-preferences/deletion';
import { installSkillLearningBridge } from './skill-learning/bridge';
import { coordinateSkillLearningDeletion, coordinateSkillLearningSourceDeletion } from './skill-learning/deletion';
import { installMemoryBridge } from './memory/bridge';
import { installFixedMemoryProcessingBridge } from './memory/fixed-processing';
import { installSourceDeletionBridge } from './sources/bridge';
import { installBindingConsentBridge } from './bindings/bridge';
import { installSyncControlBridge } from './sync/bridge';
import { installHistoryClearBridge } from './history-clear/bridge';
import { SyncPriorityController } from './sync/priority';
import { SetupController } from './setup/controller';
import { installSetupBridge } from './setup/bridge';
import { StartupDiagnostics } from './startup/diagnostics';
import { installStartupBridge } from './startup/bridge';
import { configureDevelopmentProject, loadBackendConfiguration } from './backend/config';
import { installBackgroundTaskBridge } from './background-tasks/bridge';
import { QuarantineLibrary } from '../../../backend-ts/src/history/quarantine-library.ts';
import { QuarantineController } from './quarantine/controller';
import { installQuarantineBridge } from './quarantine/bridge';
import { presentQuarantine } from './quarantine/window';

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
  const windows = new AppWindows(appSession);
  const resourcesDirectory = app.isPackaged ? process.resourcesPath : undefined;
  const diagnostics = new StartupDiagnostics(app.getPath('userData'), resourcesDirectory, development?.projectDirectory);
  const backend = new BackendHost(app.getPath('userData'), (config, canStart) => diagnostics.ensureReady(config, canStart), resourcesDirectory);
  installUsageBridge(windows, new UsageController(backend));
  const commands = electronPageCommands(windows);
  const quarantine = new QuarantineController(new QuarantineLibrary(path.join(app.getPath('appData'), 'NotAlone-Quarantine')),presentQuarantine);
  installQuarantineBridge(commands, quarantine);
  const contacts = installContactSessionBridge(commands, backend);
  const media = installMessageMediaBridge(commands, backend, contacts);
  const foreground = installForegroundBridge(commands, backend, contacts);
  const screenPermission = new ScreenPermissionController({
    inspect: (request, signal) => inspectConfiguredScreenPermission(
      app.getPath('userData'), resourcesDirectory, request, signal),
    openSettings: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'),
    onGranted: () => foreground.observeBeforeShow(),
  });
  installScreenPermissionBridge(commands, screenPermission);
  foreground.onStateChanged((state) => {
    if (state.reason === 'screen_capture_permission_missing') screenPermission.noteMissing();
  });
  app.on('before-quit', () => screenPermission.dispose());
  const headerChangeDiagnostics = openHeaderChangeDiagnostics(process.env);
  const headerChanges = new NativeHeaderChangeSource(async () =>
    resolveHeaderChangeSourcePath(resourcesDirectory, development?.projectDirectory), headerChangeDiagnostics);
  app.on('will-quit', () => headerChangeDiagnostics?.close());
  foreground.attachChangeSource(headerChanges);
  foreground.observeMeasurements(value => headerChanges.recordObservation(value));
  windows.setHelperObservation({ beforeShow: () => foreground.observeBeforeShow(),
    onLifecycle: (event) => { foreground.notifyHelperLifecycle(event); replies.notifyHelperLifecycle(event); } });
  app.on('will-quit', () => foreground.dispose());
  const memory = installMemoryBridge(commands, backend, contacts);
  const fixedMemoryProcessing = installFixedMemoryProcessingBridge(commands, backend);
  const sqliteMemoryManagement = installSqliteMemoryManagementBridge(commands, backend, contacts);
  let memoryScopeRevision = contacts.getState().scopeRevision;
  contacts.onStateChanged(state => {
    if (state.scopeRevision !== memoryScopeRevision) {
      memoryScopeRevision = state.scopeRevision; fixedMemoryProcessing.synchronize(); sqliteMemoryManagement.synchronize();
    }
  });
  installBackgroundTaskBridge(commands, backend, contacts);
  const traces = installTraceBridge(commands, backend, contacts);
  memory.onRecordDeletion((phase) => traces.recordDeletionChanged(phase));
  const beginReadingScopeChange = () => {
    const finishForeground = foreground.beginReadingScopeChange();
    contacts.invalidateReadingScope();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      contacts.invalidateReadingScope();
      finishForeground();
    };
  };
  installBindingConsentBridge(commands, backend, contacts, beginReadingScopeChange);
  const sync = installSyncControlBridge(commands, backend, contacts, beginReadingScopeChange);
  const historyClear = installHistoryClearBridge(commands, backend, contacts);
  const syncPriority = new SyncPriorityController(backend, contacts, sync);
  app.on('before-quit', () => { sync.dispose(); historyClear.dispose(); void syncPriority.dispose(); });
  sync.onStateChanged((state) => foreground.setSyncControlState(state));
  foreground.setSyncControlState(sync.getState());
  const replies = installReplyBridge(commands, backend, contacts, () => foreground.getGenerationBlock());
  const sqliteDiscussion = installSqliteDiscussionBridge(commands, backend, contacts,()=>foreground.getGenerationBlock()===null);
  coordinateOwnerContextChanges(memory, replies);
  memory.onOwnerContextChanged((phase) => { if (phase === 'started') sqliteDiscussion.synchronize(true); });
  memory.onRecordDeletion((phase) => { if (phase === 'started') sqliteDiscussion.synchronize(true); });
  replies.onSessionDeletion((phase) => { if (phase === 'started') sqliteDiscussion.synchronize(true); });
  const candidateProvenance = installCandidateProvenanceBridge(commands, backend, contacts, replies);
  const skillLearning = installSkillLearningBridge(commands, backend, contacts,()=>sqliteDiscussion.synchronize(true));
  const preferenceDeletion = coordinateSkillLearningDeletion(skillLearning, memory, replies,
    expressionPreferenceDeletion(traces, replies, candidateProvenance));
  const preferences = installExpressionPreferenceBridge(commands, backend, contacts, {
    started: () => { sqliteDiscussion.synchronize(true); preferenceDeletion.started(); },
    settled: () => preferenceDeletion.settled(),
  });
  let candidateGenerationBlock=foreground.getGenerationBlock();
  foreground.onStateChanged(() => { replies.refreshGenerationEligibility(); const next=foreground.getGenerationBlock();
    if(next!==candidateGenerationBlock){candidateGenerationBlock=next;sqliteDiscussion.synchronize(true);} });
  const sources = installSourceDeletionBridge(commands, backend, contacts, async (contactId) => {
    traces.invalidateSource();
    skillLearning.invalidate();
    candidateProvenance.invalidateSource();
    const checking = replies.revalidateDeletedSource(contactId);
    const memoryChecking = memory.revalidateDeletedSource(contactId);
    const preferenceChecking = preferences.invalidateSource(contactId);
    await Promise.all([checking, memoryChecking, preferenceChecking]);
  });
  coordinateSourceContextChanges(sources, replies);
  coordinateSkillLearningSourceDeletion(skillLearning, sources);
  sources.onDeletion((phase) => {
    memory.sourceDeletionChanged(phase);
    if (phase === 'started') { media.invalidate(); sqliteDiscussion.synchronize(true); fixedMemoryProcessing.synchronize(); sqliteMemoryManagement.synchronize(); }
  });
  installElectronCandidateCopy(windows, new CandidateCopyController(backend, contacts, replies,
    (selection, text) => candidateProvenance.recordCopied(selection, text)));
  backend.setConnectionChangePreparation(async () => {
    fixedMemoryProcessing.synchronize(); sqliteMemoryManagement.synchronize();
    sqliteDiscussion.synchronize(true);
    await media.invalidateAndDrain(); await replies.prepareGenerationConnectionChange();
  });
  installSetupBridge(windows, new SetupController(backend));
  installWechatSetupBridge(commands, new WechatSetupController(backend));
  installBackendBridge(windows, backend, () => app.quit());
  installStartupBridge(windows, diagnostics, backend, app.getPath('userData'));
  app.on('before-quit', () => { fixedMemoryProcessing.synchronize(); sqliteMemoryManagement.synchronize(); sqliteDiscussion.synchronize(true); foreground.stopContinuous(); diagnostics.cancel(); });
  app.on('will-quit', () => sqliteDiscussion.close());
  installQuitLifecycle(backend, windows, async () => {
    await quarantine.close();
    await media.prepareClosing();
    await syncPriority.dispose();
    await headerChanges.shutdown();
    await replies.beginGenerationClosing(
      async (receipt) => { await interruptAssistantGeneration(backend, receipt); },
      (identity) => recoverAssistantGenerationReceipt(backend, identity));
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
    if (development) process.send?.({ type: 'notalone-dev-ready' });
    const config = await loadBackendConfiguration(app.getPath('userData'), resourcesDirectory).catch(() => undefined);
    if (config?.source === 'external') await screenPermission.startup();
  }).catch(() => {
    if (!quitting) dialog.showErrorBox('NotAlone', '窗口暂时无法打开，请从“窗口”菜单重试。');
  });
}).catch(() => {
  dialog.showErrorBox('NotAlone', '应用暂时无法启动，请关闭后重试。');
});
import { installTraceBridge } from './traces/bridge';
