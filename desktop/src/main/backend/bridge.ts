import { ipcMain } from 'electron';
import type { AppWindows } from '../windows';
import type { BackendHost } from './host';

export function installBackendBridge(windows: AppWindows, backend: BackendHost, quit: () => void): void {
  ipcMain.handle('backend:get-state', (event, ...args: unknown[]) => {
    windows.validateCaller(event, args);
    return backend.getState();
  });
  ipcMain.handle('backend:retry-connection', (event, ...args: unknown[]) => {
    windows.validateCaller(event, args);
    return backend.connect();
  });
  ipcMain.handle('backend:quit', (event, ...args: unknown[]) => {
    windows.validateCaller(event, args);
    quit();
  });
  backend.onStateChanged((state) => windows.publish('backend:state-changed', state));
}
