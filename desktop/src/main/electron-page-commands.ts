import { ipcMain } from 'electron';
import type { AppWindows } from './windows';
import type { PageCommands } from './page-commands';

export function electronPageCommands(windows: AppWindows): PageCommands {
  return {
    handle(channel, handler, role) {
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        const caller = windows.validateCaller(event, []);
        if (role && caller.webContents.getURL() !== `notalone://app/index.html#${role}`) throw new Error('页面操作不可用。');
        return handler(...args);
      });
    },
    publish: (channel, state, role) => windows.publish(channel, state, role),
  };
}
