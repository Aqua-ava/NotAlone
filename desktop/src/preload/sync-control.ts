import type { SyncControlBridge, SyncControlState, SyncControlRequest } from '../shared/sync-control-bridge';
import type { PageTransport } from './transport';

export function createSyncControlBridge(transport: PageTransport): SyncControlBridge {
  const empty = (channel: string, args: unknown[]) => args.length === 0
    ? transport.invoke(channel) : Promise.reject(new Error('同步操作不可用。'));
  const single = (channel: string, args: unknown[]) => args.length === 1
    ? transport.invoke(channel, args[0]) : Promise.reject(new Error('同步操作不可用。'));
  return Object.freeze({
    getState: (...args: unknown[]) => empty('sync-control:get-state', args),
    refresh: (...args: unknown[]) => empty('sync-control:refresh', args),
    enable: (...args: [SyncControlRequest]) => single('sync-control:enable', args),
    disable: (...args: [SyncControlRequest]) => single('sync-control:disable', args),
    pause: (...args: [SyncControlRequest]) => single('sync-control:pause', args),
    retry: (...args: [SyncControlRequest]) => single('sync-control:retry', args),
    onStateChanged: (listener: (state: SyncControlState) => void) => {
      if (typeof listener !== 'function') throw new Error('同步操作不可用。');
      const receive = (_event: unknown, state: SyncControlState) => listener(state);
      transport.on('sync-control:state-changed', receive);
      return () => transport.removeListener('sync-control:state-changed', receive);
    },
  });
}
