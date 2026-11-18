import { dialog, ipcMain, shell } from 'electron';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { AppWindows } from '../windows';
import type { BackendHost } from '../backend/host';
import type { StartupDiagnostics } from './diagnostics';
import { DiagnosticExportController } from './diagnostic-export';

export function installStartupBridge(windows: AppWindows, diagnostics: StartupDiagnostics, backend: BackendHost, userData: string): void {
  const diagnosticExport = new DiagnosticExportController(() => diagnostics.getState(), () => backend.getState());
  const requireManager = (event: Parameters<AppWindows['validateCaller']>[0], args: unknown[]) => {
    const caller = windows.validateCaller(event, args);
    if (!caller.webContents.getURL().endsWith('#manager')) throw new Error('诊断导出不可用');
    return caller;
  };
  ipcMain.handle('startup:preview-diagnostics', (event, ...args: unknown[]) => {
    requireManager(event, args);
    return diagnosticExport.preview();
  });
  ipcMain.handle('startup:export-diagnostics', async (event, ...args: unknown[]) => {
    const caller = requireManager(event, []);
    if (args.length !== 1) throw new Error('请先预览诊断');
    return diagnosticExport.export(args[0], async () => {
      const result = await dialog.showSaveDialog(caller, { title: '将已预览诊断保存到本机',
        defaultPath: 'NotAlone-diagnostics.json', filters: [{ name: '诊断 JSON', extensions: ['json'] }],
        properties: ['showOverwriteConfirmation'] });
      return result.canceled ? undefined : result.filePath;
    });
  });
  ipcMain.handle('startup:get-state', (event, ...args: unknown[]) => {
    windows.validateCaller(event, args);
    return diagnostics.getState();
  });
  ipcMain.handle('startup:get-paths', (event, ...args: unknown[]) => {
    const caller = windows.validateCaller(event, args);
    if (!caller.webContents.getURL().endsWith('#manager')) throw new Error('启动配置不可用');
    return diagnostics.getPaths();
  });
  ipcMain.handle('startup:save-paths', async (event, ...args: unknown[]) => {
    const caller = windows.validateCaller(event, []);
    if (!caller.webContents.getURL().endsWith('#manager') || args.length !== 1) throw new Error('启动配置暂时不可修改');
    await backend.saveStartupConfiguration((canSave) => diagnostics.savePaths(args[0], canSave));
  });
  ipcMain.handle('startup:retry', (event, ...args: unknown[]) => {
    windows.validateCaller(event, args);
    return backend.connect();
  });
  diagnostics.onStateChanged((state) => windows.publish('startup:state-changed', state));
  const manager = (event: Parameters<AppWindows['validateCaller']>[0], args: unknown[]) => {
    const caller = windows.validateCaller(event, args);
    if (!caller.webContents.getURL().endsWith('#manager')) throw new Error('历史副本清理恢复不可用');
  };
  const backupDirectory = path.join(userData, 'updates');
  const historicalDirectory = async () => {
    const directory = await lstat(backupDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('历史副本目录暂时无法打开');
  };
  ipcMain.handle('startup:reveal-update-backup', async (event, ...args: unknown[]) => {
    manager(event, args);
    await historicalDirectory();
    const result = await shell.openPath(backupDirectory);
    if (result) throw new Error('备份位置暂时无法打开');
  });
}
