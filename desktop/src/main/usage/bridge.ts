import { ipcMain } from 'electron';
import type { AppWindows } from '../windows';
import type { UsageController } from './controller';
export function installUsageBridge(windows: AppWindows, usage: UsageController): void {
  for (const channel of ['usage:get-state', 'usage:refresh'] as const) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const window = windows.validateCaller(event, args);
      if (!window.webContents.getURL().endsWith('#manager')) throw new Error('用量读取不可用。');
      return channel === 'usage:get-state' ? usage.getState() : usage.refresh();
    });
  }
  usage.onStateChanged((state) => windows.publish('usage:state-changed', state, 'manager'));
}
