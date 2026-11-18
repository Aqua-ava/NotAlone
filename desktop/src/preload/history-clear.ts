import { pageInvokers, subscribePageState, type PageTransport } from './transport';
import type { HistoryClearBridge, HistoryClearRequest, HistoryClearState, HistoryResyncRequest } from '../shared/history-clear-bridge';

export function createHistoryClearBridge(transport: PageTransport): HistoryClearBridge {
  const { empty, single } = pageInvokers(transport, '清空操作不可用。');
  return Object.freeze({
    getState: (...args: unknown[]) => empty('history-clear:get-state', args),
    refresh: (...args: [HistoryClearRequest]) => single('history-clear:refresh', args),
    clear: (...args: [HistoryClearRequest]) => single('history-clear:clear', args),
    resync: (...args: [HistoryResyncRequest]) => single('history-clear:resync', args),
    onStateChanged: (listener: (state: HistoryClearState) => void) =>
      subscribePageState(transport, 'history-clear:state-changed', listener, '清空操作不可用。'),
  });
}
