import { pageInvokers, subscribePageState, type PageTransport } from './transport';
import type { ContactDraft, ContactSelection, ContactSessionBridge, ContactSessionUpdate } from '../shared/contact-session-bridge';

export function createContactSessionBridge(ipcRenderer: PageTransport): ContactSessionBridge {
  const { empty } = pageInvokers(ipcRenderer, '联系人操作不可用。');
  return Object.freeze({
    getState: (...args: unknown[]) => empty('contacts:get-state', args),
    refreshContacts: (...args: unknown[]) => empty('contacts:refresh', args),
    selectContact: (selection: ContactSelection) => ipcRenderer.invoke('contacts:select', selection&&typeof selection==='object'?{...selection,traceId:selection.traceId??globalThis.crypto.randomUUID()}:selection),
    readAvatar: (selection: ContactSelection) => ipcRenderer.invoke('contacts:read-avatar', selection),
    confirmManualContact: (selection: ContactSelection) => ipcRenderer.invoke('contacts:confirm-manual', selection),
    setDraft: (draft: ContactDraft) => ipcRenderer.invoke('contacts:set-draft', draft),
    onStateChanged: (listener: (state: ContactSessionUpdate) => void) =>
      subscribePageState(ipcRenderer, 'contacts:state-changed', listener, '联系人操作不可用。'),
  });
}
