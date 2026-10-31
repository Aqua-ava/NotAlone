import type { ContactHistoryBridge, ContactHistoryRequest, ContactHistoryState } from '../shared/contact-history-bridge';
import type { PageTransport } from './transport';

export function createContactHistoryBridge(transport: PageTransport): ContactHistoryBridge {
  return Object.freeze({
    getState: (...args: unknown[]) => args.length === 0
      ? transport.invoke('contact-history:get-state') : Promise.reject(new Error('聊天记录暂不可用。')),
    load: (...args: [ContactHistoryRequest]) => args.length === 1
      ? transport.invoke('contact-history:load', args[0]) : Promise.reject(new Error('聊天记录暂不可用。')),
    onStateChanged: (listener: (state: ContactHistoryState) => void) => {
      if (typeof listener !== 'function') throw new Error('聊天记录暂不可用。');
      const receive = (_event: unknown, state: ContactHistoryState) => listener(state);
      transport.on('contact-history:state-changed', receive);
      return () => transport.removeListener('contact-history:state-changed', receive);
    },
  });
}
