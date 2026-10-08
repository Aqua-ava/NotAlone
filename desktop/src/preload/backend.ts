import { ipcRenderer } from 'electron';
import type { BackendBridge, BackendState } from '../shared/backend-bridge';

export function createBackendBridge(): BackendBridge {
  const invoke = (channel: string, args: unknown[]) => args.length === 0
    ? ipcRenderer.invoke(channel) : Promise.reject(new Error('后端操作不可用'));
  return Object.freeze({
    getState: (...args: unknown[]) => invoke('backend:get-state', args),
    retryConnection: (...args: unknown[]) => invoke('backend:retry-connection', args),
    quit: (...args: unknown[]) => invoke('backend:quit', args),
    onStateChanged: (listener: (state: BackendState) => void) => {
      if (typeof listener !== 'function') throw new Error('后端操作不可用');
      const receive = (_event: unknown, state: BackendState) => listener(state);
      ipcRenderer.on('backend:state-changed', receive);
      return () => ipcRenderer.removeListener('backend:state-changed', receive);
    },
  });
}
