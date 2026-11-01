import { validContactDeletionRequest, validContactDeletionRetry, type ContactDeletionBridge, type ContactDeletionRequest,
  type ContactDeletionRetry, type ContactDeletionState } from '../shared/contact-deletion-bridge';
import type { PageTransport } from './transport';

export function createContactDeletionBridge(transport: PageTransport): ContactDeletionBridge {
  const invalid = () => Promise.reject(new Error('联系人删除操作不可用。'));
  return Object.freeze({
    getState: (...args: unknown[]) => args.length === 0 ? transport.invoke('contact-deletion:get-state') : invalid(),
    refresh: (...args: unknown[]) => args.length === 0 ? transport.invoke('contact-deletion:refresh') : invalid(),
    delete: (...args: [ContactDeletionRequest]) => args.length === 1 && validContactDeletionRequest(args[0]) ? transport.invoke('contact-deletion:delete', args[0]) : invalid(),
    retry: (...args: [ContactDeletionRetry]) => args.length === 1 && validContactDeletionRetry(args[0]) ? transport.invoke('contact-deletion:retry', args[0]) : invalid(),
    onStateChanged: (listener: (state: ContactDeletionState) => void) => {
      if (typeof listener !== 'function') throw new Error('联系人删除操作不可用。');
      const receive = (_event: unknown, state: ContactDeletionState) => listener(state);
      transport.on('contact-deletion:state-changed', receive);
      return () => transport.removeListener('contact-deletion:state-changed', receive);
    },
  });
}
