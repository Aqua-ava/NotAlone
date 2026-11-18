import { validContactDeletionRequest, validContactDeletionRetry, type ContactDeletionBridge, type ContactDeletionRequest,
  type ContactDeletionRetry, type ContactDeletionState } from '../shared/contact-deletion-bridge';
import { pageInvokers, subscribePageState, type PageTransport } from './transport';

export function createContactDeletionBridge(transport: PageTransport): ContactDeletionBridge {
  const { empty, reject } = pageInvokers(transport, '联系人删除操作不可用。');
  return Object.freeze({
    getState: (...args: unknown[]) => empty('contact-deletion:get-state', args),
    refresh: (...args: unknown[]) => empty('contact-deletion:refresh', args),
    delete: (...args: [ContactDeletionRequest]) => args.length === 1 && validContactDeletionRequest(args[0]) ? transport.invoke('contact-deletion:delete', args[0]) : reject(),
    retry: (...args: [ContactDeletionRetry]) => args.length === 1 && validContactDeletionRetry(args[0]) ? transport.invoke('contact-deletion:retry', args[0]) : reject(),
    onStateChanged: (listener: (state: ContactDeletionState) => void) =>
      subscribePageState(transport, 'contact-deletion:state-changed', listener, '联系人删除操作不可用。'),
  });
}
