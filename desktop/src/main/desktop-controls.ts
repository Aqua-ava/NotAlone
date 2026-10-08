import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { HelperShortcut } from './shortcuts';
import { DesktopSettingsFile } from './desktop-settings';
import type { AppWindows } from './windows';
import type { DesktopSettings } from '../shared/desktop-bridge';

export function installDesktopControls(windows: AppWindows): HelperShortcut {
  const shortcut = new HelperShortcut(new DesktopSettingsFile(app.getPath('userData')), () => windows.toggleHelper(), () => {
    dialog.showErrorBox('NotAlone', '窗口暂时无法打开，请从“窗口”菜单重试。');
  });
  const settings = (): DesktopSettings => ({ ...shortcut.getSettings(), helperPinned: windows.isHelperPinned() });
  const publish = () => {
    const value = settings();
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('desktop:settings-changed', value);
    return value;
  };
  ipcMain.handle('desktop:get-settings', (event, ...args: unknown[]) => {
    windows.validateCaller(event, args);
    return settings();
  });
  ipcMain.handle('desktop:set-shortcut', (event, ...args: unknown[]) => {
    windows.validateCaller(event, []);
    if (args.length !== 1 || typeof args[0] !== 'string') throw new Error('桌面操作不可用');
    const result = shortcut.change(args[0]);
    return { settings: publish(), error: result.error };
  });
  ipcMain.handle('desktop:set-helper-pinned', (event, ...args: unknown[]) => {
    windows.validateCaller(event, []);
    if (args.length !== 1 || typeof args[0] !== 'boolean') throw new Error('桌面操作不可用');
    try { windows.setHelperPinned(args[0]); }
    catch { throw new Error('桌面操作不可用'); }
    return publish();
  });
  return shortcut;
}
