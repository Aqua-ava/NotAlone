import { clipboard, ipcMain } from 'electron';
import type { AppWindows } from '../windows';
import { candidateCopyRequest, type CandidateCopyController } from './controller';

export function installElectronCandidateCopy(windows: AppWindows, copies: CandidateCopyController): void {
  ipcMain.handle('candidate-copy:copy', (event, ...args: unknown[]) => {
    const caller = windows.validateCaller(event, []);
    if (caller.webContents.getURL() !== 'notalone://app/index.html#helper') throw new Error('复制操作不可用。');
    // 捕获本次已验证的小窗；复制完成后不按前台窗口重新查找目标。
    return copies.copy(candidateCopyRequest(args), {
      writeText: (text) => clipboard.writeText(text),
      hideWindow: () => { if (caller.isDestroyed()) throw new Error('小窗已关闭。'); caller.hide(); },
    });
  });
}
