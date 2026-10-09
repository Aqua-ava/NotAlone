import { ipcMain } from 'electron';
import type { AppWindows } from '../windows';
import type { SetupController } from './controller';

export function installSetupBridge(windows: AppWindows, setup: SetupController): void {
  ipcMain.handle('setup:get-state', (event, ...args: unknown[]) => {
    windows.validateCaller(event, args); return setup.getState();
  });
  ipcMain.handle('setup:refresh', (event, ...args: unknown[]) => {
    windows.validateCaller(event, args); return setup.refresh();
  });
  ipcMain.handle('setup:initialize-owner', (event, ...args: unknown[]) => {
    const window = windows.validateCaller(event, []);
    const value = args[0];
    if (!window.webContents.getURL().endsWith('#manager') || args.length !== 1 || typeof value !== 'string'
      || !value.trim() || value.length > 100 || /[\u0000-\u001f]/.test(value)) throw new Error('首次配置操作不可用');
    return setup.initializeOwner(value.trim());
  });
  ipcMain.handle('setup:retry-restart', (event, ...args: unknown[]) => {
    const window = windows.validateCaller(event, args);
    if (!window.webContents.getURL().endsWith('#manager')) throw new Error('首次配置操作不可用');
    return setup.retryRestart();
  });
  ipcMain.handle('setup:reload-controlled-configuration', (event, ...args: unknown[]) => {
    const window = windows.validateCaller(event, args);
    if (!window.webContents.getURL().endsWith('#manager')) throw new Error('首次配置操作不可用');
    return setup.reloadControlledConfiguration();
  });
  ipcMain.handle('setup:save-deepseek-key', (event, ...args: unknown[]) => {
    const window = windows.validateCaller(event, []);
    const value = args[0];
    if (!window.webContents.getURL().endsWith('#manager') || args.length !== 1 || typeof value !== 'string'
      || !/^[A-Za-z0-9_-]{1,4096}$/.test(value)) throw new Error('首次配置操作不可用');
    return setup.saveDeepSeekKey(value);
  });
  setup.onStateChanged((state) => windows.publish('setup:state-changed', state));
}
