import { pageInvokers, subscribePageState, type PageTransport } from './transport';
import type { BackendBridge, BackendState } from '../shared/backend-bridge';

export function createBackendBridge(ipcRenderer: PageTransport): BackendBridge {
  const { empty } = pageInvokers(ipcRenderer, '后端操作不可用');
  return Object.freeze({
    getState: (...args: unknown[]) => empty('backend:get-state', args),
    retryConnection: (...args: unknown[]) => empty('backend:retry-connection', args),
    quit: (...args: unknown[]) => empty('backend:quit', args),
    onStateChanged: (listener: (state: BackendState) => void) =>
      subscribePageState(ipcRenderer, 'backend:state-changed', listener, '后端操作不可用'),
  });
}
