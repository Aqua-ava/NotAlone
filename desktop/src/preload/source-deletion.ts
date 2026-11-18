import { pageInvokers, subscribePageState, type PageTransport } from './transport';
import type { SourceDeletionBridge, SourceDeletionRequest, SourceDeletionState } from '../shared/source-deletion-bridge';
import type { ContactSelection } from '../shared/contact-session-bridge';
export function createSourceDeletionBridge(transport: PageTransport): SourceDeletionBridge {
  const { empty, single } = pageInvokers(transport, '来源操作不可用。');
  return Object.freeze({
    getState: (...args: unknown[]) => empty('sources:get-state', args),
    refresh: (...args: [ContactSelection]) => single('sources:refresh', args),
    delete: (...args: [SourceDeletionRequest]) => single('sources:delete', args),
    onStateChanged: (listener: (state: SourceDeletionState) => void) =>
      subscribePageState(transport, 'sources:state-changed', listener, '来源操作不可用。'),
  });
}
