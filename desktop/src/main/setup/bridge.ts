import { isDeepSeekConfiguration } from '../../shared/ai-service-configuration';
import { isModelParameters } from '../../shared/model-parameters';
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
  ipcMain.handle('setup:retry-restart', (event, ...args: unknown[]) => {
    const window = windows.validateCaller(event, args);
    if (!window.webContents.getURL().endsWith('#manager')) throw new Error('首次配置操作不可用');
    return setup.retryRestart();
  });
  ipcMain.handle('setup:save-deepseek-configuration', (event, ...args: unknown[]) => {
    const window = windows.validateCaller(event, []);
    const value = args[0];
    if (!window.webContents.getURL().endsWith('#manager') || args.length !== 1 || !isDeepSeekConfiguration(value)) throw new Error('AI 服务配置无效');
    return setup.saveDeepSeekConfiguration({ baseUrl: value.baseUrl, apiKey: value.apiKey });
  });
  ipcMain.handle('setup:save-model-parameters', (event, ...args: unknown[]) => {
    const window = windows.validateCaller(event, []);
    const value = args[0];
    if (!window.webContents.getURL().endsWith('#manager') || args.length !== 1 || !isModelParameters(value)) throw new Error('模型参数无效');
    return setup.saveModelParameters(structuredClone(value));
  });
  setup.onStateChanged((state) => windows.publish('setup:state-changed', state));
}
