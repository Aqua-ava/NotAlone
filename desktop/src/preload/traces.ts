import type { TraceBatchRequest, TraceBridge, TraceFindRequest, TraceListRequest, TraceState } from '../shared/trace-bridge';
import type { PageTransport } from './transport';

export function createTraceBridge(transport: PageTransport): TraceBridge {
  const invoke = (channel: string, args: unknown[]) => args.length === 1 ? transport.invoke(channel, args[0]) : Promise.reject(new Error('过程操作不可用。'));
  return Object.freeze({
    getState: (...args: unknown[]) => args.length === 0 ? transport.invoke('traces:get-state') : Promise.reject(new Error('过程操作不可用。')),
    list: (...args: [TraceListRequest]) => invoke('traces:list', args),
    find: (...args: [TraceFindRequest]) => invoke('traces:find', args),
    show: (...args: [TraceBatchRequest]) => invoke('traces:show', args),
    remove: (...args: [TraceBatchRequest]) => invoke('traces:remove', args),
    onStateChanged: (listener: (state: TraceState) => void) => {
      if (typeof listener !== 'function') throw new Error('过程操作不可用。');
      const receive = (_event: unknown, state: TraceState) => listener(state);
      transport.on('traces:state-changed', receive);
      return () => transport.removeListener('traces:state-changed', receive);
    },
  });
}
