import { CandidateCopyController } from './candidate-copy/controller';
import { installElectronCandidateCopy } from './candidate-copy/electron';
import { app, dialog, ipcMain, Menu, protocol, session } from 'electron';
import path from 'node:path';
import { electronPageCommands } from './electron-page-commands';
import { installResources } from './resources';
import { AppWindows } from './windows';
import { BackendHost } from './backend/host';
import { installBackendBridge } from './backend/bridge';
import { installQuitLifecycle } from './backend/quit';
import { installDesktopControls } from './desktop-controls';
import { installContactSessionBridge } from './contacts/bridge';
import { installReplyBridge } from './reply/bridge';
import { installMemoryBridge } from './memory/bridge';
import { installBindingConsentBridge } from './bindings/bridge';
import { SetupController } from './setup/controller';
import { installSetupBridge } from './setup/bridge';
import { StartupDiagnostics } from './startup/diagnostics';
import { installStartupBridge } from './startup/bridge';
import { ImportController } from './imports/controller';
import { installImportBridge } from './imports/bridge';
import { installElectronImportFileSelection } from './imports/electron-file-selection';

app.setName('NotAlone');
const selectedDataPath = app.commandLine.getSwitchValue('user-data-dir');
app.setPath('userData', selectedDataPath && path.isAbsolute(selectedDataPath)
  ? selectedDataPath : path.join(app.getPath('appData'), 'NotAloneDesktop'));
// 后来实例只唤回原窗口，不接受它的 argv、环境或工作目录作为运行配置。
if (!app.requestSingleInstanceLock()) app.exit(0);
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
  installResources(appSession);
  const windows = new AppWindows(appSession);
  const diagnostics = new StartupDiagnostics(app.getPath('userData'));
  const backend = new BackendHost(app.getPath('userData'), (config, canStart) => diagnostics.ensureReady(config, canStart));
  const commands = electronPageCommands(windows);
  const contacts = installContactSessionBridge(commands, backend);
  const imports = new ImportController(backend, contacts);
  installImportBridge(commands, imports);
  installElectronImportFileSelection(windows, imports);
  installMemoryBridge(commands, backend, contacts);
  installBindingConsentBridge(windows, backend, contacts);
  const replies = installReplyBridge(commands, backend, contacts);
  installElectronCandidateCopy(windows, new CandidateCopyController(backend, contacts, replies));
  installSetupBridge(windows, new SetupController(backend));
  installBackendBridge(windows, backend, () => app.quit());
  installStartupBridge(windows, diagnostics, backend);
  app.on('before-quit', () => diagnostics.cancel());
  installQuitLifecycle(backend, windows);
  void backend.connect();
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
  app.on('activate', () => openWindow('manager'));

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
  openWindow('manager');
}).catch(() => {
  dialog.showErrorBox('NotAlone', '应用暂时无法启动，请关闭后重试。');
});
