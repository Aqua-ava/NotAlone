import { ipcRenderer } from 'electron';
import type { ContactDraft, ContactSelection, ContactSessionBridge, ContactSessionState } from '../shared/contact-session-bridge';

export function createContactSessionBridge(): ContactSessionBridge {
  const withoutArguments = (channel: string, args: unknown[]) => args.length === 0
    ? ipcRenderer.invoke(channel) : Promise.reject(new Error('联系人操作不可用。'));
  return Object.freeze({
    getState: (...args: unknown[]) => withoutArguments('contacts:get-state', args),
    refreshContacts: (...args: unknown[]) => withoutArguments('contacts:refresh', args),
    selectContact: (selection: ContactSelection) => ipcRenderer.invoke('contacts:select', selection),
    setDraft: (draft: ContactDraft) => ipcRenderer.invoke('contacts:set-draft', draft),
    onStateChanged: (listener: (state: ContactSessionState) => void) => {
      if (typeof listener !== 'function') throw new Error('联系人操作不可用。');
      const receive = (_event: unknown, state: ContactSessionState) => listener(state);
      ipcRenderer.on('contacts:state-changed', receive);
      return () => ipcRenderer.removeListener('contacts:state-changed', receive);
    },
  });
}
