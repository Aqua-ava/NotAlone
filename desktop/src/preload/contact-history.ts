import type { ContactHistoryBridge, ContactHistoryRequest, ContactHistoryState } from '../shared/contact-history-bridge';
import { pageInvokers, subscribePageState, type PageTransport } from './transport';

export function createContactHistoryBridge(transport: PageTransport): ContactHistoryBridge {
  const { empty, single } = pageInvokers(transport, '聊天记录暂不可用。');
  return Object.freeze({
    getState: (...args: unknown[]) => empty('contact-history:get-state', args),
    load: (...args: [ContactHistoryRequest]) => single('contact-history:load', args),
    onStateChanged: (listener: (state: ContactHistoryState) => void) =>
      subscribePageState(transport, 'contact-history:state-changed', listener, '聊天记录暂不可用。'),
  });
}
