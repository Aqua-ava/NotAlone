import type { HistoryAuthorizationRequest, SyncControlBridge, SyncControlState, SyncControlRequest, SyncScopeRequest } from '../shared/sync-control-bridge';
import { pageInvokers, subscribePageState, type PageTransport } from './transport';

export function createSyncControlBridge(transport: PageTransport): SyncControlBridge {
  const { empty, single } = pageInvokers(transport, '同步操作不可用。');
  return Object.freeze({
    getState: (...args: unknown[]) => empty('sync-control:get-state', args),
    refresh: (...args: unknown[]) => empty('sync-control:refresh', args),
    setScope: (...args: [SyncScopeRequest]) => single('sync-control:set-scope', args),
    setHistoryAuthorization: (...args: [HistoryAuthorizationRequest]) => single('sync-control:set-history-authorization', args),
    enable: (...args: [SyncControlRequest]) => single('sync-control:enable', args),
    disable: (...args: [SyncControlRequest]) => single('sync-control:disable', args),
    onStateChanged: (listener: (state: SyncControlState) => void) =>
      subscribePageState(transport, 'sync-control:state-changed', listener, '同步操作不可用。'),
  });
}
