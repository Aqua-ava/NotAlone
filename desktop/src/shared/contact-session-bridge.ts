export interface ContactSummary {
  contactId: string;
  displayName: string;
  messageCount: number;
  sourceCount: number;
}

export type ContactDirectoryPhase = 'unavailable' | 'loading' | 'ready' | 'owner-unconfigured' | 'error';

// scopeRevision 只标记本次临时会话的有效性，不代表数据库 owner 身份。
export interface ContactSessionState {
  revision: number;
  scopeRevision: number;
  directoryPhase: ContactDirectoryPhase;
  contacts: ContactSummary[];
  selectedContactId: string | null;
  draft: string;
}

export interface ContactSelection {
  contactId: string;
  scopeRevision: number;
}

export interface ContactDraft extends ContactSelection { text: string; }

export interface ContactSessionBridge {
  getState(): Promise<ContactSessionState>;
  refreshContacts(): Promise<void>;
  selectContact(selection: ContactSelection): Promise<ContactSessionState>;
  setDraft(draft: ContactDraft): Promise<ContactSessionState>;
  onStateChanged(listener: (state: ContactSessionState) => void): () => void;
}
