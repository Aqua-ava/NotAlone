import type { ContactDraft, ContactSelection, ContactSessionState, ContactSummary } from '../../shared/contact-session-bridge';
import { contactDraftUpdate, type ContactDraftUpdate } from '../../shared/contact-session-bridge';
import type { ContactDeletionQuiet } from './deletion-quiet';
import {currentDiagnosticTrace,diagnose,newTraceId,withDiagnosticTrace} from '../../../../backend-ts/src/diagnostics/context';

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

  constructor(private readonly readDirectory: () => Promise<ContactDirectoryResult>,
    private readonly quiet?: ContactDeletionQuiet) {
    // 联系人目录没有独立的 dispose：应用生命周期内跟随删除窗口，窗口结束时统一补读一次。
    quiet?.onSettled(() => {
      if (this.state.directoryPhase === 'ready') void this.refreshContactsInBackground();
      else void this.refreshContacts();
    });
  }

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
      draft: '', scopeRevision: this.state.scopeRevision + 1 },'full',{caller:'connection_generation',reasonCode:'connection_changed'});
    if (generation !== undefined) void this.refreshContacts();
  }

  // 授权决定变化保留人工选择与草稿，但所有既有读取和提交必须重新捕获范围。
  invalidateReadingScope(caller='foreground_scope_change'): void {
    ++this.directoryRequest;
    this.publish({ scopeRevision: this.state.scopeRevision + 1 },'full',{caller,reasonCode:'reading_scope_changed'});
    if (this.state.directoryPhase === 'loading') void this.refreshContacts();
  }

  async refreshContacts(): Promise<void> { await this.refreshDirectory(false); }

  // 自动纳入只补充共享目录；暂时失败不清空已确认对象、草稿或可用目录。
  refreshContactsInBackground(): Promise<boolean> { return this.refreshDirectory(true); }

  private async refreshDirectory(background: boolean): Promise<boolean> {
    const generation = this.generation;
    if (generation === undefined || (background && this.state.directoryPhase !== 'ready')) return false;
    const request = ++this.directoryRequest;
    const phaseBefore = this.state.directoryPhase;
    if (!background) this.publish({ directoryPhase: 'loading' });
    const current = () => generation === this.generation && request === this.directoryRequest;
    try {
      const directory = await this.readDirectory();
      if (!current() || directory.generation !== generation) return false;
      if (directory.contacts === null) {
        if (!background) this.clearDirectory('owner-unconfigured');
        return false;
      }
      const selectedStillPresent = directory.contacts.some((contact) => contact.contactId === this.state.selectedContactId);
      this.publish({ directoryPhase: 'ready', contacts: directory.contacts,
        ...(!selectedStillPresent && this.state.selectedContactId !== null ? {
          selectedContactId: null, draft: '', scopeRevision: this.state.scopeRevision + 1,
        } : {}),
      },'full',{caller:'directory_missing',reasonCode:'directory_missing'});
      return true;
    } catch {
      if (current() && !background) {
        if (this.quiet?.deleting) {
          // 删除窗口内名单服务可能整体关闭：恢复加载前状态并保留目录、选择与草稿，窗口结束统一补读。
          this.publish({ directoryPhase: phaseBefore === 'loading' ? 'unavailable' : phaseBefore });
        } else this.clearDirectory('error');
      }
      return false;
    }
  }

  /**
   * 删除请求发出后立即从内存目录撤下该联系人，不等后端名单服务恢复。
   * 只让这一位失效：其他联系人的选中项和草稿保持不变；被删联系人仍在加载中时用现有列表收敛为可读状态。
   */
  removeContact(contactId: string): void {
    if (!this.state.contacts.some((contact) => contact.contactId === contactId)) return;
    // 丢弃发出前已开始的目录读取，避免删除期间的迟到结果把对象重新加回。
    ++this.directoryRequest;
    const selected = this.state.selectedContactId === contactId;
    this.publish({ directoryPhase: this.state.directoryPhase === 'loading' ? 'ready' : this.state.directoryPhase,
      contacts: this.state.contacts.filter((contact) => contact.contactId !== contactId),
      ...(selected ? { selectedContactId: null, draft: '', scopeRevision: this.state.scopeRevision + 1 } : {}) },'full',{caller:'contact_removed',reasonCode:'contact_removed'});
  }

  selectContact(selection: ContactSelection,caller='select_contact'): ContactSessionState {
    if (!this.isCurrent(selection) || !this.state.contacts.some((contact) => contact.contactId === selection.contactId)) {
      throw new Error('联系人选择已失效，请刷新后重新确认。');
    }
    if (selection.contactId !== this.state.selectedContactId) {
      // 选择来自当前有效目录；切换后，旧刷新成功或失败都不能改变新会话。
      ++this.directoryRequest;
      this.publish({ directoryPhase: 'ready', selectedContactId: selection.contactId,
        draft: '', scopeRevision: this.state.scopeRevision + 1 },'full',{caller,reasonCode:'contact_selected',traceId:selection.traceId});
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
      draft: '', scopeRevision: this.state.scopeRevision + 1 },'full',{caller:directoryPhase==='owner-unconfigured'?'directory_missing':'directory_failed',reasonCode:directoryPhase==='owner-unconfigured'?'not_ready':'directory_failed'});
  }

  private publish(update: Partial<ContactSessionState>, kind: 'full' | 'draft' = 'full',cause?:{caller:string;reasonCode:string;traceId?:string}): void {
    const previous=this.state;
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    const publish=()=>{for (const listener of this.listeners) listener(this.getState(), kind);};
    if(previous.scopeRevision===this.state.scopeRevision){publish();return;}
    withDiagnosticTrace(cause?.traceId??currentDiagnosticTrace()??newTraceId(),()=>{
      const contact=this.state.selectedContactId??previous.selectedContactId;
      diagnose({event:'scope.revision_changed',caller:cause?.caller??'memory_scope_listener',reasonCode:cause?.reasonCode??'scope_changed',fromRevision:previous.scopeRevision,toRevision:this.state.scopeRevision,...(contact?{contactPrefix:contact.slice(0,8)}:{})});
      publish();
    });
  }
}
