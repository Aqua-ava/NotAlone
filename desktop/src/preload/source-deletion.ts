import type { PageTransport } from './transport';
import type { SourceDeletionBridge, SourceDeletionRequest, SourceDeletionState } from '../shared/source-deletion-bridge';
import type { ContactSelection } from '../shared/contact-session-bridge';
export function createSourceDeletionBridge(transport: PageTransport): SourceDeletionBridge {
  return Object.freeze({
    getState: (...args: unknown[]) => args.length === 0 ? transport.invoke('sources:get-state') : Promise.reject(new Error('来源操作不可用。')),
    refresh: (...args: [ContactSelection]) => args.length === 1 ? transport.invoke('sources:refresh', args[0]) : Promise.reject(new Error('来源操作不可用。')),
    delete: (...args: [SourceDeletionRequest]) => args.length === 1 ? transport.invoke('sources:delete', args[0]) : Promise.reject(new Error('来源操作不可用。')),
    onStateChanged: (listener: (state: SourceDeletionState) => void) => {
      if (typeof listener !== 'function') throw new Error('来源操作不可用。');
      const receive = (_event: unknown, state: SourceDeletionState) => listener(state);
      transport.on('sources:state-changed', receive);
      return () => transport.removeListener('sources:state-changed', receive);
    },
  });
}
