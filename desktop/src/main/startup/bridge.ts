import { ipcMain, shell } from 'electron';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { AppWindows } from '../windows';
import type { BackendHost } from '../backend/host';
import type { StartupDiagnostics } from './diagnostics';

export function installStartupBridge(windows: AppWindows, diagnostics: StartupDiagnostics, backend: BackendHost, userData: string): void {
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
  ipcMain.handle('startup:prepare-configuration', (event, ...args: unknown[]) => {
    const caller = windows.validateCaller(event, args);
    if (!caller.webContents.getURL().endsWith('#manager')) throw new Error('启动配置不可用');
    return backend.prepareConfiguration();
  });
  ipcMain.handle('startup:begin-local-setup', async (event, ...args: unknown[]) => {
    const caller = windows.validateCaller(event, args);
    if (!caller.webContents.getURL().endsWith('#manager')) throw new Error('本机设置不可用');
    await backend.saveStartupConfiguration((canSave) => diagnostics.prepareLocalSetup(canSave));
    await backend.connect();
  });
  ipcMain.handle('startup:cancel-local-setup', async (event, ...args: unknown[]) => {
    const caller = windows.validateCaller(event, args);
    if (!caller.webContents.getURL().endsWith('#manager')) throw new Error('本机设置不可用');
    diagnostics.cancelLocalSetup();
    try {
      const confirmed = await backend.prepareConfiguration();
      diagnostics.completeLocalCancellation(confirmed);
      return confirmed;
    } catch (error) { diagnostics.completeLocalCancellation(false); throw error; }
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
