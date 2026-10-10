import type { PageTransport } from './transport';
import type { StyleSampleBridge, StyleSampleState } from '../shared/style-sample-bridge';
export function createStyleSampleBridge(transport: PageTransport): StyleSampleBridge {
  return Object.freeze({
    getState: (...args: unknown[]) => args.length ? Promise.reject(new Error('样本操作无效。')) : transport.invoke('style-samples:get-state'),
    refresh: (...args: unknown[]) => transport.invoke('style-samples:refresh', ...args),
    saveManual: (...args: unknown[]) => transport.invoke('style-samples:save-manual', ...args),
    saveCandidate: (...args: unknown[]) => transport.invoke('style-samples:save-candidate', ...args),
    saveMessage: (...args: unknown[]) => transport.invoke('style-samples:save-message', ...args),
    deleteSample: (...args: unknown[]) => transport.invoke('style-samples:delete', ...args),
    onStateChanged: (listener: (state: StyleSampleState) => void) => {
      if (typeof listener !== 'function') throw new Error('样本操作无效。');
      const receive = (_event: unknown, state: StyleSampleState) => listener(state);
      transport.on('style-samples:state-changed', receive);
      return () => transport.removeListener('style-samples:state-changed', receive);
    },
  });
}
