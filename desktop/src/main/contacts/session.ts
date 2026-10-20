import type { ContactDraft, ContactSelection, ContactSessionState, ContactSummary } from '../../shared/contact-session-bridge';
import { contactDraftUpdate, type ContactDraftUpdate } from '../../shared/contact-session-bridge';

export type ContactDirectoryResult = {
  generation: number;
  contacts: ContactSummary[] | null;
};

// 只有 main 的具名联系人目录适配器能加载数据；会话层不持有 HTTP、认证或 owner 参数。
export class ContactSession {
  private state: ContactSessionState = {
    revision: 0, scopeRevision: 0, directoryPhase: 'unavailable',
    contacts: [], selectedContactId: null, draft: '',
  };
  private generation: number | undefined;
  private directoryRequest = 0;
  private readonly listeners = new Set<(state: ContactSessionState, kind: 'full' | 'draft') => void>();

  constructor(private readonly readDirectory: () => Promise<ContactDirectoryResult>) {}

  getState(): ContactSessionState {
    return { ...this.state, contacts: this.state.contacts.map((contact) => ({ ...contact })) };
  }

  onStateChanged(listener: (state: ContactSessionState, kind: 'full' | 'draft') => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setConnection(generation: number | undefined): void {
    if (generation === this.generation) return;
    this.generation = generation;
    ++this.directoryRequest;
    this.publish({ directoryPhase: 'unavailable', contacts: [], selectedContactId: null,
      draft: '', scopeRevision: this.state.scopeRevision + 1 });
    if (generation !== undefined) void this.refreshContacts();
  }

  async refreshContacts(): Promise<void> {
    const generation = this.generation;
    if (generation === undefined) return;
    const request = ++this.directoryRequest;
    this.publish({ directoryPhase: 'loading' });
    const current = () => generation === this.generation && request === this.directoryRequest;
    try {
      const directory = await this.readDirectory();
      if (!current() || directory.generation !== generation) return;
      if (directory.contacts === null) {
        this.clearDirectory('owner-unconfigured');
        return;
      }
      const selectedStillPresent = directory.contacts.some((contact) => contact.contactId === this.state.selectedContactId);
      this.publish({ directoryPhase: 'ready', contacts: directory.contacts,
        ...(!selectedStillPresent && this.state.selectedContactId !== null ? {
          selectedContactId: null, draft: '', scopeRevision: this.state.scopeRevision + 1,
        } : {}),
      });
    } catch {
      if (current()) this.clearDirectory('error');
    }
  }

  selectContact(selection: ContactSelection): ContactSessionState {
    if (!this.isCurrent(selection) || !this.state.contacts.some((contact) => contact.contactId === selection.contactId)) {
      throw new Error('联系人选择已失效，请刷新后重新确认。');
    }
    if (selection.contactId !== this.state.selectedContactId) {
      // 选择来自当前有效目录；切换后，旧刷新成功或失败都不能改变新会话。
      ++this.directoryRequest;
      this.publish({ directoryPhase: 'ready', selectedContactId: selection.contactId,
        draft: '', scopeRevision: this.state.scopeRevision + 1 });
    }
    return this.getState();
  }

  setDraft(draft: ContactDraft): ContactDraftUpdate {
    if (!this.isCurrent(draft) || draft.contactId !== this.state.selectedContactId) {
      throw new Error('本次联系人已变化，请重新输入草稿。');
    }
    this.publish({ draft: draft.text }, 'draft');
    return contactDraftUpdate(this.state);
  }

  clearDraft(selection: ContactSelection): void {
    if (!this.isCurrent(selection) || selection.contactId !== this.state.selectedContactId) {
      throw new Error('本次联系人已变化，请重新确认。');
    }
    this.publish({ draft: '', draftClearRevision: (this.state.draftClearRevision ?? 0) + 1 });
  }

  private isCurrent(selection: ContactSelection): boolean {
    return this.generation !== undefined && selection.scopeRevision === this.state.scopeRevision
      && (this.state.directoryPhase === 'ready' || this.state.directoryPhase === 'loading');
  }

  private clearDirectory(directoryPhase: 'owner-unconfigured' | 'error'): void {
    this.publish({ directoryPhase, contacts: [], selectedContactId: null,
      draft: '', scopeRevision: this.state.scopeRevision + 1 });
  }

  private publish(update: Partial<ContactSessionState>, kind: 'full' | 'draft' = 'full'): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState(), kind);
  }
}
