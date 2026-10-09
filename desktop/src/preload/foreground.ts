import type { PageTransport } from './transport';
import type { ForegroundBridge, ForegroundState } from '../shared/foreground-bridge';

export function createForegroundBridge(transport: PageTransport): ForegroundBridge {
  return Object.freeze({
    getState: (...args: unknown[]) => args.length === 0 ? transport.invoke('foreground:get-state')
      : Promise.reject(new Error('前台状态操作不可用。')),
    onStateChanged: (listener: (state: ForegroundState) => void) => {
      if (typeof listener !== 'function') throw new Error('前台状态操作不可用。');
      const receive = (_event: unknown, state: ForegroundState) => listener(state);
      transport.on('foreground:state-changed', receive);
      return () => transport.removeListener('foreground:state-changed', receive);
    },
  });
}
