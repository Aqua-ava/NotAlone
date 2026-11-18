import { pageInvokers, subscribePageState } from './transport';
import { isDeepSeekConfiguration } from '../shared/ai-service-configuration';
import { isModelParameters } from '../shared/model-parameters';
import { ipcRenderer } from 'electron';
import type { SetupBridge, SetupState } from '../shared/setup-bridge';

export function createSetupBridge(): SetupBridge {
  const { empty } = pageInvokers(ipcRenderer, '首次配置操作不可用');
  return Object.freeze({
    getState: (...args: unknown[]) => empty('setup:get-state', args),
    refresh: (...args: unknown[]) => empty('setup:refresh', args),
    saveDeepSeekConfiguration: (...args: unknown[]) => args.length === 1 && isDeepSeekConfiguration(args[0])
      ? ipcRenderer.invoke('setup:save-deepseek-configuration', { baseUrl: args[0].baseUrl, apiKey: args[0].apiKey }) : Promise.reject(new Error('AI 服务配置无效')),
    saveModelParameters: (...args: unknown[]) => args.length === 1 && isModelParameters(args[0])
      ? ipcRenderer.invoke('setup:save-model-parameters', structuredClone(args[0])) : Promise.reject(new Error('模型参数无效')),
    retryRestart: (...args: unknown[]) => empty('setup:retry-restart', args),
    onStateChanged: (listener: (state: SetupState) => void) =>
      subscribePageState(ipcRenderer, 'setup:state-changed', listener, '首次配置操作不可用'),
  });
}
