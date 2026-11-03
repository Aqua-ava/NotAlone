import type { ContactHistoryRequest, ContactHistoryState } from '../../shared/contact-history-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { mergeContactHistoryMessages, readContactHistoryMessages } from './messages';

type Scope = { generation: number; contactId: string; scopeRevision: number };
const emptyMessages = (): ContactHistoryState['messages'] => ({ phase: 'idle', items: [], nextCursor: null });
const reconciliationIntervalMs = 5000;

/** 管理窗口的联系人历史只读分页，不依赖回复会话或助手会话生命周期。 */
export class ContactHistoryController {
  private state: ContactHistoryState = { revision: 0, contactId: null, scopeRevision: 0, messages: emptyMessages(), error: null };
  private scope: Scope | undefined;
  private pending: AbortController | undefined;
  private refreshPending: AbortController | undefined;
  private stream: AbortController | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private reconciliationTimer: NodeJS.Timeout | undefined;
  private refreshAfterLoad = false;
  private refreshNewestQueued = false;
  private readonly refreshMessageIds = new Set<string>();
  private readonly messagePageCursors = new Map<string, string | null>();
  private operation = 0;
  private disposed = false;
  private readonly listeners = new Set<(state: ContactHistoryState) => void>();
  private readonly unsubscribeContacts: () => void;
  private readonly unsubscribeBackend: () => void;

  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession) {
    this.unsubscribeContacts = contacts.onStateChanged(() => this.synchronizeScope());
    this.unsubscribeBackend = backend.onStateChanged(() => this.synchronizeScope());
    this.synchronizeScope();
  }

  getState(): ContactHistoryState { this.synchronizeScope(); return structuredClone(this.state); }
  onStateChanged(listener: (state: ContactHistoryState) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    this.disposed = true; this.cancel(); this.stopStream(); this.unsubscribeContacts(); this.unsubscribeBackend(); this.listeners.clear();
  }

  /** 在正文来源删除或聊天清空开始时立即撤下旧正文，避免它留在页面上。 */
  invalidate(error = '聊天记录已变化，请刷新后核对。'): void {
    this.synchronizeScope();
    this.cancel(); this.stopStream();
    this.messagePageCursors.clear();
    this.publish({ messages: { phase: 'failed', items: [], nextCursor: null }, error });
  }

  /** 当前有效联系人经过删除复验后重读第一页。 */
  async refreshCurrent(contactId?: string): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    if (!scope || (contactId !== undefined && contactId !== scope.contactId)) return;
    await this.load({ contactId: scope.contactId, scopeRevision: scope.scopeRevision, older: false });
  }

  private publish(patch: Partial<ContactHistoryState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    const next = this.getStateWithoutSync();
    for (const listener of this.listeners) listener(next);
  }

  private getStateWithoutSync(): ContactHistoryState { return structuredClone(this.state); }

  private cancel(): void {
    this.pending?.abort(); this.pending = undefined;
    this.refreshPending?.abort(); this.refreshPending = undefined;
    this.operation += 1;
  }

  private synchronizeScope(): void {
    if (this.disposed) return;
    const generation = this.backend.getConnectionGeneration();
    const contact = this.contacts.getState();
    const contactId = contact.selectedContactId;
    const valid = generation !== undefined && contactId !== null && contact.directoryPhase === 'ready'
      && contact.contacts.some(entry => entry.contactId === contactId);
    const next = valid ? { generation, contactId: contactId!, scopeRevision: contact.scopeRevision } : undefined;
    const unchangedScope = next === undefined && this.scope === undefined && this.state.contactId === null
      && this.state.scopeRevision === contact.scopeRevision;
    const unchangedSelection = next !== undefined && this.scope !== undefined
      && next.generation === this.scope.generation && next.contactId === this.scope.contactId
      && next.scopeRevision === this.scope.scopeRevision;
    if (unchangedScope || unchangedSelection) return;
    this.cancel(); this.stopStream(); this.messagePageCursors.clear(); this.scope = next;
    this.publish({ contactId: next?.contactId ?? null, scopeRevision: contact.scopeRevision, messages: emptyMessages(), error: null });
    if (next) this.startStream(next);
  }

  private assertScope(request: ContactHistoryRequest): Scope {
    this.synchronizeScope();
    const scope = this.scope;
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision
      || scope.generation !== this.backend.getConnectionGeneration()) throw new Error('联系人范围已变化，请重新确认联系人。');
    return scope;
  }

  async load(request: ContactHistoryRequest): Promise<void> {
    const scope = this.assertScope(request);
    if (!this.stream) this.startStream(scope);
    if (this.state.messages.phase === 'loading') return;
    const before = request.older ? this.state.messages.nextCursor : null;
    if (request.older && (!before || this.state.messages.phase !== 'ready')) return;

    this.cancel();
    const operation = this.operation, pending = new AbortController(); this.pending = pending;
    const current = () => !this.disposed && this.operation === operation && this.scope === scope
      && this.pending === pending && scope.generation === this.backend.getConnectionGeneration();
    this.publish({ messages: { ...this.state.messages, phase: 'loading' }, error: null });
    try {
      const page = await readContactHistoryMessages(this.backend, scope.contactId, before, pending.signal);
      if (!current() || page.generation !== scope.generation) return;
      if (!before) this.messagePageCursors.clear();
      for (const message of page.messages) this.messagePageCursors.set(message.messageId, before);
      this.publish({ messages: { phase: 'ready',
        items: before ? mergeContactHistoryMessages(this.state.messages.items, page.messages) : page.messages,
        nextCursor: page.nextCursor }, error: null });
    } catch {
      if (current()) this.publish({ messages: { phase: 'failed', items: [], nextCursor: null },
        error: '暂时无法读取这位联系人的聊天记录，请重试。' });
    } finally {
      if (this.pending === pending) this.pending = undefined;
      if (this.refreshAfterLoad && this.scope === scope) {
        this.refreshAfterLoad = false;
        this.scheduleRefresh(scope);
      }
    }
  }

  private startStream(scope: Scope): void {
    const stream = new AbortController(); this.stream = stream;
    this.scheduleReconciliation(scope);
    const current = () => !stream.signal.aborted && this.stream === stream && this.scope === scope
      && scope.generation === this.backend.getConnectionGeneration();
    this.backend.subscribeMessages({
      connected: () => {
        if (current() && this.state.messages.phase !== 'idle') this.queueRefresh(scope);
      },
      interrupted: () => {
        if (!current()) return;
        stream.abort(); this.stream = undefined;
      },
      message: event => {
        if (!current() || event.contactId !== scope.contactId || this.state.messages.phase === 'idle') return;
        const visibleRefreshableMessage = this.state.messages.items.some(message => message.messageId === event.messageId
          && (message.messageType === 'image' || message.messageType === 'quote' || message.quoted !== null));
        if (event.change === 'created') this.queueRefresh(scope);
        else if (visibleRefreshableMessage) this.queueRefresh(scope, event.messageId);
      },
    }, stream.signal);
  }

  private scheduleReconciliation(scope: Scope): void {
    if (this.reconciliationTimer || this.disposed || this.scope !== scope) return;
    // 历史补齐不发布新来信事件；仅核对当前已打开联系人的最近一页，也恢复断流订阅。
    this.reconciliationTimer = setTimeout(() => {
      this.reconciliationTimer = undefined;
      if (this.disposed || this.scope !== scope || scope.generation !== this.backend.getConnectionGeneration()) return;
      if (!this.stream) this.startStream(scope);
      if (this.state.messages.phase !== 'idle' && !this.refreshPending) this.queueRefresh(scope);
      this.scheduleReconciliation(scope);
    }, reconciliationIntervalMs);
    this.reconciliationTimer.unref?.();
  }

  private stopStream(): void {
    this.stream?.abort(); this.stream = undefined;
    clearTimeout(this.refreshTimer); this.refreshTimer = undefined; this.refreshAfterLoad = false;
    clearTimeout(this.reconciliationTimer); this.reconciliationTimer = undefined;
    this.refreshNewestQueued = false; this.refreshMessageIds.clear();
  }

  private queueRefresh(scope: Scope, messageId?: string): void {
    if (messageId) this.refreshMessageIds.add(messageId);
    else this.refreshNewestQueued = true;
    if (this.state.messages.phase === 'loading') { this.refreshAfterLoad = true; return; }
    this.scheduleRefresh(scope);
  }

  private scheduleRefresh(scope: Scope): void {
    if (this.refreshTimer || this.disposed || this.scope !== scope) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.state.messages.phase === 'loading') { this.refreshAfterLoad = true; return; }
      if (this.scope === scope && scope.generation === this.backend.getConnectionGeneration()) {
        const newest = this.refreshNewestQueued;
        const messageIds = [...this.refreshMessageIds];
        this.refreshNewestQueued = false; this.refreshMessageIds.clear();
        void this.refreshVisiblePages(scope, newest, messageIds);
      }
    }, 120);
    this.refreshTimer.unref?.();
  }

  private async refreshVisiblePages(scope: Scope, newest: boolean, messageIds: string[]): Promise<void> {
    if (this.scope !== scope || scope.generation !== this.backend.getConnectionGeneration()) return;
    if (this.state.messages.phase === 'loading') {
      this.refreshNewestQueued ||= newest;
      for (const messageId of messageIds) this.refreshMessageIds.add(messageId);
      this.refreshAfterLoad = true;
      return;
    }
    if (!newest && !messageIds.length) return;
    this.refreshPending?.abort();
    const pending = new AbortController(); this.refreshPending = pending;
    const current = () => !this.disposed && !pending.signal.aborted && this.refreshPending === pending
      && this.scope === scope && scope.generation === this.backend.getConnectionGeneration();
    try {
      const pages = new Map<string, { before: string | null; messages: ContactHistoryState['messages']['items']; nextCursor: string | null }>();
      const readPage = async (before: string | null) => {
        const key = before ?? '';
        const cached = pages.get(key);
        if (cached) return cached;
        const page = await readContactHistoryMessages(this.backend, scope.contactId, before, pending.signal);
        if (page.generation !== scope.generation) throw new Error('聊天历史连接已变化。');
        const result = { before, messages: page.messages, nextCursor: page.nextCursor };
        pages.set(key, result);
        return result;
      };
      if (newest) await readPage(null);
      for (const messageId of messageIds) {
        const before = this.messagePageCursors.get(messageId) ?? null;
        let page = await readPage(before);
        if (page.messages.some(message => message.messageId === messageId)) continue;

        // 首页插入新消息后，原第一页中的旧消息可能落入更早页；沿游标定位目标 ID，不猜数组页码。
        let cursor: string | null = null;
        const seen = new Set<string>();
        while (true) {
          page = await readPage(cursor);
          if (page.messages.some(message => message.messageId === messageId)) break;
          const next = page.nextCursor;
          if (!next || seen.has(next)) break;
          seen.add(next);
          cursor = next;
        }
      }
      if (!current()) return;
      const incoming = [...pages.values()].flatMap(page => page.messages);
      for (const page of pages.values()) {
        for (const message of page.messages) this.messagePageCursors.set(message.messageId, page.before);
      }
      const items = mergeContactHistoryMessages(this.state.messages.items, incoming);
      const nextCursor = this.state.messages.phase === 'failed' ? pages.get('')?.nextCursor ?? this.state.messages.nextCursor
        : this.state.messages.nextCursor;
      this.publish({ messages: { phase: 'ready', items, nextCursor }, error: null });
    } catch {
      if (current()) this.publish({ error: '聊天记录更新暂时无法读取，请刷新后核对。' });
    } finally {
      if (this.refreshPending === pending) this.refreshPending = undefined;
    }
  }
}
