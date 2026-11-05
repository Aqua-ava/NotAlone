import type { PageTransport } from './transport';
import type { HistoryRecertifyBatchBridge, HistoryRecertifyBatchStartRequest, HistoryRecertifyBatchState } from '../shared/history-recertify-batch-bridge';

/** 仅开发模式由 preload 暴露；通道名与主进程开发宿主注册保持一致。 */
export function createHistoryRecertifyBatchBridge(transport: PageTransport): HistoryRecertifyBatchBridge {
  const invalid = () => Promise.reject(new Error('批量修复操作不可用。'));
  const single = (channel: string, args: unknown[]) => args.length === 1 ? transport.invoke(channel, args[0]) : invalid();
  const none = (channel: string, args: unknown[]) => args.length === 0 ? transport.invoke(channel) : invalid();
  return Object.freeze({
    getState: (...args: unknown[]) => none('history-recertify-batch:get-state', args),
    refreshOverview: (...args: unknown[]) => none('history-recertify-batch:refresh-overview', args),
    start: (...args: [HistoryRecertifyBatchStartRequest]) => single('history-recertify-batch:start', args),
    stop: (...args: unknown[]) => none('history-recertify-batch:stop', args),
    onStateChanged: (listener: (state: HistoryRecertifyBatchState) => void) => {
      if (typeof listener !== 'function') throw new Error('批量修复操作不可用。');
      const receive = (_event: unknown, state: HistoryRecertifyBatchState) => listener(state);
      transport.on('history-recertify-batch:state-changed', receive);
      return () => transport.removeListener('history-recertify-batch:state-changed', receive);
    },
  });
}
