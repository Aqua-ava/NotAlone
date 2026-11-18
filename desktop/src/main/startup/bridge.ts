import { dialog, ipcMain, shell } from 'electron';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { AppWindows } from '../windows';
import type { BackendHost } from '../backend/host';
import { noArguments, type PageCommands } from '../page-commands';
import type { StartupDiagnostics } from './diagnostics';
import { DiagnosticExportController } from './diagnostic-export';

// 导出诊断需要调用窗口作为保存对话框的父窗口，保留直接 ipcMain 注册；其余操作只用页面命令。
export function installStartupBridge(windows: AppWindows, commands: PageCommands, diagnostics: StartupDiagnostics, backend: BackendHost, userData: string): void {
  const diagnosticExport = new DiagnosticExportController(() => diagnostics.getState(), () => backend.getState());
  commands.handle('startup:preview-diagnostics', (...args) => { noArguments(args); return diagnosticExport.preview(); }, 'manager');
  ipcMain.handle('startup:export-diagnostics', async (event, ...args: unknown[]) => {
    const caller = windows.validateCaller(event, []);
    if (!caller.webContents.getURL().endsWith('#manager')) throw new Error('诊断导出不可用');
    if (args.length !== 1) throw new Error('请先预览诊断');
    return diagnosticExport.export(args[0], async () => {
      const result = await dialog.showSaveDialog(caller, { title: '将已预览诊断保存到本机',
        defaultPath: 'NotAlone-diagnostics.json', filters: [{ name: '诊断 JSON', extensions: ['json'] }],
        properties: ['showOverwriteConfirmation'] });
      return result.canceled ? undefined : result.filePath;
    });
  });
  commands.handle('startup:get-state', (...args) => { noArguments(args); return diagnostics.getState(); });
  commands.handle('startup:get-paths', (...args) => { noArguments(args); return diagnostics.getPaths(); }, 'manager');
  commands.handle('startup:save-paths', async (...args) => {
    if (args.length !== 1) throw new Error('启动配置暂时不可修改');
    await backend.saveStartupConfiguration((canSave) => diagnostics.savePaths(args[0], canSave));
  }, 'manager');
  commands.handle('startup:retry', (...args) => { noArguments(args); return backend.connect(); });
  diagnostics.onStateChanged((state) => commands.publish('startup:state-changed', state));
  const backupDirectory = path.join(userData, 'updates');
  const historicalDirectory = async () => {
    const directory = await lstat(backupDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('历史副本目录暂时无法打开');
  };
  commands.handle('startup:reveal-update-backup', async (...args) => {
    noArguments(args);
    await historicalDirectory();
    const result = await shell.openPath(backupDirectory);
    if (result) throw new Error('备份位置暂时无法打开');
  }, 'manager');
}
