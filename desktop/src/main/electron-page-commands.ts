import { ipcMain } from 'electron';
import type { AppWindows } from './windows';
import {pageRoleAllowed,type PageCommands,type PageRole} from './page-commands';

export function electronPageCommands(windows: AppWindows): PageCommands {
  return {
    handle(channel, handler, role) {
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        const caller = windows.validateCaller(event, []);
        const url=caller.webContents.getURL();
        const actual:PageRole|undefined=url==='notalone://app/index.html#manager'?'manager'
          :url==='notalone://app/index.html#helper'?'helper':undefined;
        if (!pageRoleAllowed(actual,role)) throw new Error('页面操作不可用。');
        return handler(...args);
      });
    },
    publish: (channel, state, role) => windows.publish(channel, state, role),
  };
}
