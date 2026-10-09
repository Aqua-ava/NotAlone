import { ipcRenderer } from 'electron';
import type { SetupBridge, SetupState } from '../shared/setup-bridge';

export function createSetupBridge(): SetupBridge {
  const invoke = (channel: string, args: unknown[]) => args.length === 0
    ? ipcRenderer.invoke(channel) : Promise.reject(new Error('首次配置操作不可用'));
  return Object.freeze({
    getState: (...args: unknown[]) => invoke('setup:get-state', args),
    refresh: (...args: unknown[]) => invoke('setup:refresh', args),
    initializeOwner: (...args: unknown[]) => args.length === 1 && typeof args[0] === 'string'
      ? ipcRenderer.invoke('setup:initialize-owner', args[0]) : Promise.reject(new Error('首次配置操作不可用')),
    saveDeepSeekKey: (...args: unknown[]) => args.length === 1 && typeof args[0] === 'string'
      ? ipcRenderer.invoke('setup:save-deepseek-key', args[0]) : Promise.reject(new Error('首次配置操作不可用')),
    retryRestart: (...args: unknown[]) => invoke('setup:retry-restart', args),
    reloadControlledConfiguration: (...args: unknown[]) => invoke('setup:reload-controlled-configuration', args),
    onStateChanged: (listener: (state: SetupState) => void) => {
      if (typeof listener !== 'function') throw new Error('首次配置操作不可用');
      const receive = (_event: unknown, state: SetupState) => listener(state);
      ipcRenderer.on('setup:state-changed', receive);
      return () => ipcRenderer.removeListener('setup:state-changed', receive);
    },
  });
}
