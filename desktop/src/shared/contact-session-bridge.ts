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
  // 主进程确认本次助手会话已删除后，通知输入框清除同范围的本地编辑。
  draftClearRevision?: number;
}

export interface ContactSelection {
  contactId: string;
  scopeRevision: number;
}

export interface ContactDraft extends ContactSelection { text: string; }
// 草稿传输不重复携带联系人目录；其余变化继续传输权威完整快照。
export type ContactDraftUpdate = Pick<ContactSessionState, 'revision' | 'scopeRevision' | 'selectedContactId' | 'draft'> & { kind: 'draft' };
export type ContactSessionUpdate = ContactSessionState | ContactDraftUpdate;

export function contactDraftUpdate(state: ContactSessionState): ContactDraftUpdate {
  return { kind: 'draft', revision: state.revision, scopeRevision: state.scopeRevision,
    selectedContactId: state.selectedContactId, draft: state.draft };
}

export function createContactSessionReceiver() {
  let pending: ContactDraftUpdate | undefined;
  return (current: ContactSessionState, update: ContactSessionUpdate): ContactSessionState => {
    if (update.revision <= current.revision) return current;
    if ('kind' in update) {
      // 初读回包可能落后于订阅事件；只保留一份最新草稿，等同范围完整快照到达。
      if (update.scopeRevision > current.scopeRevision || current.revision < 0) {
        if (!pending || update.revision > pending.revision) pending = update;
        return current;
      }
      if (update.scopeRevision !== current.scopeRevision || update.selectedContactId !== current.selectedContactId) return current;
      return { ...current, revision: update.revision, draft: update.draft };
    }
    let next = update;
    if (pending && pending.revision > next.revision && pending.scopeRevision === next.scopeRevision
      && pending.selectedContactId === next.selectedContactId) next = { ...next, revision: pending.revision, draft: pending.draft };
    if (pending && (pending.revision <= next.revision || pending.scopeRevision <= next.scopeRevision)) pending = undefined;
    return next;
  };
}
export interface ContactCreation { displayName: string; scopeRevision: number; }

export interface ContactSessionBridge {
  getState(): Promise<ContactSessionState>;
  refreshContacts(): Promise<void>;
  selectContact(selection: ContactSelection): Promise<ContactSessionState>;
  createContact(creation: ContactCreation): Promise<ContactSessionState>;
  confirmManualContact(selection: ContactSelection): Promise<ContactSessionState>;
  setDraft(draft: ContactDraft): Promise<ContactDraftUpdate>;
  onStateChanged(listener: (state: ContactSessionUpdate) => void): () => void;
}
