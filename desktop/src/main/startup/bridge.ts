import { ipcMain } from 'electron';
import type { AppWindows } from '../windows';
import type { BackendHost } from '../backend/host';
import type { StartupDiagnostics } from './diagnostics';

export function installStartupBridge(windows: AppWindows, diagnostics: StartupDiagnostics, backend: BackendHost): void {
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
  diagnostics.onStateChanged((state) => windows.publish('startup:state-changed', state));
}
