import type { PageTransport } from './transport';
import type { HistoryClearBridge, HistoryClearRequest, HistoryClearState, HistoryResyncRequest, HistoryRecertifyRequest, HistoryRecertifyCancelRequest } from '../shared/history-clear-bridge';

export function createHistoryClearBridge(transport: PageTransport): HistoryClearBridge {
  const single = (channel: string, args: unknown[]) => args.length === 1
    ? transport.invoke(channel, args[0]) : Promise.reject(new Error('清空操作不可用。'));
  return Object.freeze({
    getState: (...args: unknown[]) => args.length === 0 ? transport.invoke('history-clear:get-state') : Promise.reject(new Error('清空操作不可用。')),
    refresh: (...args: [HistoryClearRequest]) => single('history-clear:refresh', args),
    clear: (...args: [HistoryClearRequest]) => single('history-clear:clear', args),
    resync: (...args: [HistoryResyncRequest]) => single('history-clear:resync', args),
    recertify: (...args: [HistoryRecertifyRequest]) => single('history-clear:recertify', args),
    cancelRecertify: (...args: [HistoryRecertifyCancelRequest]) => single('history-clear:recertify-cancel', args),
    onStateChanged: (listener: (state: HistoryClearState) => void) => {
      if (typeof listener !== 'function') throw new Error('清空操作不可用。');
      const receive = (_event: unknown, state: HistoryClearState) => listener(state);
      transport.on('history-clear:state-changed', receive);
      return () => transport.removeListener('history-clear:state-changed', receive);
    },
  });
}
