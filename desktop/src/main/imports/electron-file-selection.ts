import { dialog, ipcMain } from 'electron';
import type { AppWindows } from '../windows';
import type { ImportController } from './controller';

// 原生选择只接受本次核验后的管理窗口，不允许渲染层传文件路径或窗口身份。
export function installElectronImportFileSelection(windows: AppWindows, imports: ImportController): void {
  ipcMain.handle('imports:choose-file', (event, ...args: unknown[]) => {
    const caller = windows.validateCaller(event, args);
    if (caller.webContents.getURL() !== 'notalone://app/index.html#manager') throw new Error('历史导入操作不可用。');
    return imports.chooseFile(() => dialog.showOpenDialog(caller, {
      title: '选择单联系人历史文件', buttonLabel: '选择这份文件',
      properties: ['openFile'], filters: [{ name: '微信单联系人 JSONL', extensions: ['jsonl'] }],
      message: '只预览你主动选择的这一份单联系人 JSONL 文件。',
    }));
  });
}
