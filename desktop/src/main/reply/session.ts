import { invalidatedSqliteDiscussion } from './sqlite-discussion-read';
import type { ReplyStateUpdate, ReplySessionState, ReplyGenerationBlock, AssistantSessionDeletion, AssistantSessionSelection } from '../../shared/reply-bridge';
import type { ContactSelection, ContactSessionState } from '../../shared/contact-session-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import type { ContactSession } from '../contacts/session';
import { currentAssistantSession, deleteAssistantSession, readAssistantSession } from './assistant-sessions';
import { listAssistantSessions, newAssistantSession, selectAssistantSession } from './assistant-session-catalog';
import { AssistantSessionProjection, type AssistantProjectionScope } from './assistant-session-projection';

type WorkspaceContent = { sessionId: string | null; draft: string };

// 只管理当前 SQLite 讨论的展示与独立草稿；生成、候选和停止由各自的 SQLite 入口负责。
export class ReplySession {
  private state: ReplySessionState = { revision: 0, scopeRevision: 0, contactId: null, generationBlock: null };
  private draft = '';
  private operation = 0;
  private helperHidden = false;
  private savedRead: AbortController | undefined;
  private contactRestoreTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly sessionProjection = new AssistantSessionProjection();
  private sessionDelete: AbortController | undefined;
  private catalogPending: AbortController | undefined;
  private catalogMutation: AbortController | undefined;
  private readonly listeners = new Map<(state: ReplySessionState) => void, readonly (keyof ReplySessionState)[] | undefined>();
  private readonly updateListeners = new Set<(update: ReplyStateUpdate) => void>();
  private publishedState: ReplySessionState | undefined;
  private readonly sessionDeletionListeners = new Set<(phase: 'started' | 'settled') => void>();
  private readonly retainedContent = new Map<string, WorkspaceContent>();
  private contentGeneration: number | undefined;
  private pendingContent: WorkspaceContent | undefined;
  private pendingOwnerContextChanges = 0;

  constructor(private readonly contacts: ContactSession, private readonly backend: BackendHost,
    private readonly generationBlock: () => ReplyGenerationBlock = () => null) {
    let versionGeneration = backend.getConnectionGeneration();
    this.contentGeneration = versionGeneration;
    backend.onStateChanged(() => {
      const generation = backend.getConnectionGeneration();
      if (generation !== versionGeneration) {
        versionGeneration = generation;
        this.cancelContactRestore();
        this.retainedContent.clear(); this.pendingContent = undefined;
        this.contentGeneration = undefined;
        this.cancelPending(); this.cancelSavedRead(); this.invalidateSessionCatalog();
        this.sessionProjection.invalidateSource();
        this.publish({ sourceAvailability: undefined, savedSession: this.state.savedSession ? { ...this.state.savedSession,
          phase: 'idle', ...invalidatedSqliteDiscussion() } : undefined,
          inputClearRevision: (this.state.inputClearRevision ?? 0) + 1 });
      }
    });
    this.state.generationBlock = generationBlock();
    contacts.onStateChanged(state => this.receiveContact(state));
    this.receiveContact(contacts.getState());
  }
  getState(): ReplySessionState { return structuredClone(this.projectState()); }
  private projectState(): ReplySessionState {
    if (!this.pendingOwnerContextChanges) return this.state;
    return { ...this.state, savedSession: this.state.savedSession ? { ...this.state.savedSession,
      ...invalidatedSqliteDiscussion(), phase: 'loading' } : undefined };
  }
  refreshGenerationEligibility(): void {
    const generationBlock = this.generationBlock();
    if (generationBlock === this.state.generationBlock) return;
    const revokedRead = generationBlock !== null && this.savedRead !== undefined;
    if (revokedRead) this.cancelSavedRead();
    this.publish({ generationBlock, ...(revokedRead && this.state.savedSession?.phase === 'loading'
      ? { savedSession: { ...this.state.savedSession, phase: 'failed' as const } } : {}) });
    if (generationBlock === null && this.state.contactId && this.state.savedSession?.phase !== 'ready'
      && this.contactRestoreTimer === undefined) void this.readSavedSession({ contactId: this.state.contactId, scopeRevision: this.state.scopeRevision });
  }
  onStateChanged(listener: (state: ReplySessionState) => void, fields?: readonly (keyof ReplySessionState)[]): () => void {
    this.listeners.set(listener, fields); return () => this.listeners.delete(listener);
  }
  onStateUpdated(listener: (update: ReplyStateUpdate) => void): () => void {
    this.publishedState ??= this.projectState(); this.updateListeners.add(listener);
    return () => { this.updateListeners.delete(listener); };
  }
  onSessionDeletion(listener: (phase: 'started' | 'settled') => void): () => void {
    this.sessionDeletionListeners.add(listener); return () => { this.sessionDeletionListeners.delete(listener); };
  }
  notifyHelperLifecycle(event: 'focused' | 'blurred' | 'hidden' | 'closed'): void {
    if (event === 'hidden' || event === 'closed') { this.helperHidden = true; this.cancelPending(); }
    else if (event === 'focused' && this.helperHidden) {
      this.helperHidden = false;
      if (this.state.contactId) void this.readSavedSession({ contactId: this.state.contactId, scopeRevision: this.state.scopeRevision }, true);
    }
  }
  async prepareConnectionChange(): Promise<void> {
    this.cancelPending(); this.cancelSavedRead(); this.invalidateSessionCatalog();
  }

  async readSavedSession(selection: ContactSelection, retainVerifiedDisplay = false): Promise<void> {
    this.assertScope(selection); this.cancelContactRestore();
    if (this.pendingOwnerContextChanges || this.state.sessionDeletion === 'deleting'
      || this.catalogPending || this.state.sessionCatalog?.selectionPending) return;
    this.cancelSavedRead();
    const pending = new AbortController(); this.savedRead = pending;
    const generation = this.backend.getConnectionGeneration(), content = this.pendingContent, inputOperation = this.operation;
    const heldSessionId = this.state.savedSession?.sessionId ?? content?.sessionId;
    if (!retainVerifiedDisplay || this.projectState().savedSession?.phase !== 'ready') {
      this.publish({ savedSession: { phase: 'loading', sessionId: heldSessionId ?? null, ...invalidatedSqliteDiscussion() } });
    }
    let projectionRead = this.sessionProjection.beginRead(this.projectionScope());
    const current = () => !pending.signal.aborted && selection.scopeRevision === this.state.scopeRevision
      && selection.contactId === this.state.contactId && generation === this.backend.getConnectionGeneration()
      && this.sessionProjection.isReadCurrent(projectionRead);
    try {
      const resolved = heldSessionId ? undefined : await currentAssistantSession(this.backend, selection.contactId, pending.signal);
      if (resolved?.deletionOperationId) {
        if (current() && resolved.generation === generation) {
          this.sessionProjection.invalidateSource();
          this.publish({ sessionDeletion: 'failed', confirmedSessionDeletion: undefined,
            savedSession: { phase: 'failed', sessionId: resolved.sessionId, ...invalidatedSqliteDiscussion() } });
        }
        return;
      }
      const sessionId = heldSessionId ?? resolved!.sessionId;
      if (!current()) return;
      if (resolved?.catalog) this.publish({ sessionCatalog: { phase: 'ready', items: resolved.catalog.items,
        currentSessionId: resolved.catalog.currentSessionId } });
      if (!sessionId) { this.publish({ savedSession: { phase: 'ready', sessionId: null, discussionEntries: [], runtimeRecovery: 'none' } }); return; }
      projectionRead = this.sessionProjection.resolveReadSession(projectionRead, sessionId);
      const saved = await readAssistantSession(this.backend, selection.contactId, sessionId, pending.signal);
      if (!current() || saved.generation !== generation) return;
      const accepted = this.sessionProjection.acceptRead(projectionRead, saved);
      if (accepted.kind !== 'accepted') return;
      projectionRead = accepted.read;
      this.publish({ savedSession: accepted.snapshot, sourceAvailability: undefined,
        ...(saved.sessionId !== heldSessionId ? { sessionDeletion: undefined } : {}) }, 'authoritative');
      if (current() && content && this.pendingContent === content && inputOperation === this.operation
        && (content.sessionId === null || content.sessionId === saved.sessionId)) {
        this.pendingContent = undefined; this.retainedContent.delete(selection.contactId);
        this.draft = content.draft; this.contacts.setDraft({ ...selection, text: content.draft });
        this.publish({ inputClearRevision: (this.state.inputClearRevision ?? 0) + 1 });
      }
    } catch (error) {
      if (!current()) return;
      const unavailable = error instanceof BackendRequestFailure && error.kind === 'response'
        && (error.status === 404 && error.code === 'not_found' || error.status === 409
          && ['assistant_session_conflict', 'assistant_session_rejected'].includes(error.code ?? '')
          && ['source_unavailable', 'source_deleted'].includes(error.reason ?? ''));
      const rejected = this.sessionProjection.failRead(projectionRead, unavailable ? 'unavailable' : 'unknown');
      if (rejected.kind !== 'failed') return;
      if (unavailable) { this.retainedContent.delete(selection.contactId); this.pendingContent = undefined; }
      this.publish({ savedSession: rejected.snapshot, sourceAvailability: 'failed' });
    } finally { if (this.savedRead === pending) this.savedRead = undefined; }
  }

  private invalidateSessionCatalog(): void {
    const pending = this.catalogPending;
    if (!pending) return;
    const selectionPending = this.catalogMutation === pending || this.state.sessionCatalog?.selectionPending === true;
    pending.abort(); this.catalogPending = undefined; this.catalogMutation = undefined;
    // 纯读取取消后可重新核对；变更请求已发出则继续保留结果未知的门禁。
    this.publish({ sessionCatalog: { phase: selectionPending ? 'failed' : 'idle', items: [],
      currentSessionId: null, selectionPending } });
  }

  async listSavedSessions(selection: ContactSelection): Promise<void> {
    this.assertScope(selection);
    if (this.catalogPending || this.state.sessionDeletion === 'deleting'
      || this.pendingOwnerContextChanges > 0) return;
    const previous = this.state.sessionCatalog;
    const pending = new AbortController(); this.catalogPending = pending;
    const generation = this.backend.getConnectionGeneration();
    const current = () => !pending.signal.aborted && this.catalogPending === pending
      && selection.contactId === this.state.contactId && selection.scopeRevision === this.state.scopeRevision
      && generation === this.backend.getConnectionGeneration();
    this.publish({ sessionCatalog: { phase: 'loading', items: previous?.items ?? [],
      currentSessionId: previous?.currentSessionId ?? null, selectionPending: previous?.selectionPending } });
    try {
      const catalog = await listAssistantSessions(this.backend, selection.contactId, pending.signal);
      if (current() && catalog.generation === generation) this.publish({ sessionCatalog: { phase: 'ready',
        items: catalog.items, currentSessionId: catalog.currentSessionId, selectionPending: previous?.selectionPending } });
    } catch {
      if (current()) this.publish({ sessionCatalog: { phase: 'failed', items: previous?.items ?? [],
        currentSessionId: previous?.currentSessionId ?? null, selectionPending: previous?.selectionPending } });
    } finally { if (this.catalogPending === pending) this.catalogPending = undefined; }
  }
  async newSavedSession(selection: ContactSelection): Promise<void> { await this.switchSavedSession(selection); }
  async viewSavedSession(selection: AssistantSessionSelection): Promise<void> { await this.switchSavedSession(selection, true); }
  async resumeSavedSession(selection: AssistantSessionSelection): Promise<void> { await this.switchSavedSession(selection); }
  private async switchSavedSession(selection: ContactSelection & { sessionId?: string }, viewOnly = false): Promise<void> {
    this.assertScope(selection);
    if (this.catalogPending || this.state.savedSession?.phase === 'loading' || this.state.sessionDeletion === 'deleting'
      || this.state.sessionDeletion === 'failed' || this.pendingOwnerContextChanges) throw new Error('请等待当前操作完成后再切换助手会话。');
    const previous = this.state.sessionCatalog;
    this.cancelPending();
    const pending = new AbortController(); this.catalogPending = pending;
    if (!viewOnly) this.catalogMutation = pending;
    const generation = this.backend.getConnectionGeneration();
    const current = () => !pending.signal.aborted && this.catalogPending === pending
      && selection.contactId === this.state.contactId && selection.scopeRevision === this.state.scopeRevision
      && generation === this.backend.getConnectionGeneration();
    this.publish({ sessionCatalog: { phase: 'loading', items: previous?.items ?? [],
      currentSessionId: previous?.currentSessionId ?? null, selectionPending: previous?.selectionPending } });
    try {
      const selected = viewOnly ? { sessionId: selection.sessionId!, generation } : selection.sessionId
        ? await selectAssistantSession(this.backend, selection.contactId, selection.sessionId, pending.signal)
        : await newAssistantSession(this.backend, selection.contactId, pending.signal);
      if (!current() || selected.generation !== generation) return;
      const saved = await readAssistantSession(this.backend, selection.contactId, selected.sessionId, pending.signal);
      if (!current() || saved.generation !== generation) return;
      const catalog = viewOnly ? await listAssistantSessions(this.backend, selection.contactId, pending.signal) : undefined;
      if (!current() || catalog && catalog.generation !== generation) return;
      this.cancelSavedRead(); this.notifyInputChanged(); this.retainedContent.delete(selection.contactId);
      const currentSessionId = viewOnly ? catalog!.currentSessionId : saved.sessionId;
      const items = catalog?.items ?? (previous?.items ?? []).map(item => ({ ...item, isCurrent: item.sessionId === currentSessionId }));
      if (!items.some(item => item.sessionId === saved.sessionId)) items.push({ sessionId: saved.sessionId, isCurrent: saved.sessionId === currentSessionId });
      this.publish({ savedSession: { phase: 'ready', sessionId: saved.sessionId,
        discussionEntries: saved.discussionEntries, runtimeRecovery: saved.runtimeRecovery },
        sessionCatalog: { phase: 'ready', items, currentSessionId, selectionPending: false },
        sessionDeletion: undefined, confirmedSessionDeletion: undefined, sourceAvailability: undefined,
        contextRefresh: !viewOnly && 'contextRefreshed' in selected && selected.contextRefreshed ? { sessionId: saved.sessionId } : undefined,
        inputClearRevision: (this.state.inputClearRevision ?? 0) + 1 }, 'authoritative');
      this.catalogPending = undefined;
    } catch {
      // 只有实际变更可能留下未知写入；只读失败保留既有待核对决定。
      if (current()) this.publish({ sessionCatalog: { phase: 'failed', items: [], currentSessionId: null,
        selectionPending: !viewOnly || previous?.selectionPending === true } });
    } finally {
      if (this.catalogPending === pending) this.catalogPending = undefined;
      if (this.catalogMutation === pending) this.catalogMutation = undefined;
    }
  }

  async deleteSavedSession(selection: AssistantSessionDeletion): Promise<void> {
    this.assertScope(selection);
    if (this.catalogPending || this.state.sessionCatalog?.selectionPending) throw new Error('请先核对助手会话的选择结果。');
    if (selection.confirmed !== true || selection.sessionId !== this.state.savedSession?.sessionId) {
      throw new Error('本次助手会话已变化，请重新确认。');
    }
    if (this.state.sessionDeletion === 'deleting') return;
    this.sessionProjection.invalidateSource();
    this.savedRead?.abort(); this.savedRead = undefined;
    this.cancelPending();
    this.notifyInputChanged();
    const pending = new AbortController(); this.sessionDelete = pending;
    const generation = this.backend.getConnectionGeneration();
    const current = () => !pending.signal.aborted && this.sessionDelete === pending
      && selection.contactId === this.state.contactId && selection.scopeRevision === this.state.scopeRevision
      && selection.sessionId === this.state.savedSession?.sessionId
      && generation === this.backend.getConnectionGeneration();
    try {
      for (const listener of this.sessionDeletionListeners) listener('started');
      this.publish({ sessionDeletion: 'deleting', confirmedSessionDeletion: undefined,
        savedSession: { phase: 'idle', sessionId: selection.sessionId, ...invalidatedSqliteDiscussion() } });
      const result = await deleteAssistantSession(this.backend, selection.contactId, selection.sessionId, pending.signal);
      if (!current() || result.generation !== generation) return;
      this.retainedContent.delete(selection.contactId); this.pendingContent = undefined;
      this.publish({ sessionDeletion: result.phase, savedSession: { phase: 'idle', sessionId: null, ...invalidatedSqliteDiscussion() },
        sessionCatalog: undefined,
        inputClearRevision: (this.state.inputClearRevision ?? 0) + 1,
        confirmedSessionDeletion: { sessionId: selection.sessionId, contactId: selection.contactId,
          scopeRevision: selection.scopeRevision, connectionGeneration: result.generation,
          revision: this.state.revision + 1 },
        contextRefresh: undefined, sourceAvailability: undefined });
    } catch {
      if (current()) this.publish({ sessionDeletion: 'failed' });
    } finally {
      if (this.sessionDelete === pending) this.sessionDelete = undefined;
      for (const listener of this.sessionDeletionListeners) listener('settled');
    }
  }

  private retainWorkspace(): WorkspaceContent {
    return { sessionId: this.state.savedSession?.sessionId ?? null, draft: this.draft };
  }
  beginOwnerContextChange(): void {
    if (this.state.contactId) this.retainedContent.set(this.state.contactId, this.pendingContent ?? this.retainWorkspace());
    this.pendingContent = this.state.contactId ? this.retainedContent.get(this.state.contactId) : undefined;
    ++this.pendingOwnerContextChanges;
    this.withdrawDiscussion();
  }
  async revalidateOwnerContextChange(): Promise<void> {
    this.pendingOwnerContextChanges = Math.max(0, this.pendingOwnerContextChanges - 1);
    if (!this.pendingOwnerContextChanges) await this.revalidateDeletedSource('');
  }
  beginHistoryClear(_contactId: string): () => Promise<void> {
    this.beginOwnerContextChange();
    let settlement: Promise<void> | undefined;
    return () => settlement ??= this.revalidateOwnerContextChange();
  }
  private withdrawDiscussion(): void {
    this.sessionProjection.invalidateSource(); this.cancelSavedRead(); this.invalidateSessionCatalog(); this.cancelPending();
    if (this.state.savedSession) this.publish({ savedSession: { ...this.state.savedSession,
      ...invalidatedSqliteDiscussion(), phase: 'idle' }, sourceAvailability: 'checking' });
  }
  async revalidateDeletedSource(_contactId: string): Promise<void> {
    const contactId = this.state.contactId, scopeRevision = this.state.scopeRevision;
    const generation = this.backend.getConnectionGeneration();
    this.withdrawDiscussion();
    const restoreContent = this.pendingContent;
    const refreshCatalog = this.state.sessionCatalog?.phase === 'idle' && !this.state.sessionCatalog.selectionPending;
    this.publish({ sourceAvailability: undefined });
    if (!contactId || generation === undefined || this.pendingOwnerContextChanges
      || contactId !== this.state.contactId || scopeRevision !== this.state.scopeRevision
      || generation !== this.backend.getConnectionGeneration()) return;
    // 缓存只恢复独立想法；目录与讨论正文仍由正式只读入口重新核验。
    const selection = { contactId, scopeRevision };
    if (refreshCatalog) await this.listSavedSessions(selection);
    if ((restoreContent || refreshCatalog) && contactId === this.state.contactId && scopeRevision === this.state.scopeRevision
      && generation === this.backend.getConnectionGeneration()) await this.readSavedSession(selection);
  }

  async retrySourceValidation(selection: ContactSelection): Promise<void> {
    this.assertScope(selection); await this.readSavedSession(selection);
  }
  private assertScope(selection: ContactSelection): ContactSessionState {
    const state = this.contacts.getState();
    if (this.backend.getConnectionGeneration() === undefined || selection.scopeRevision !== state.scopeRevision
      || selection.contactId !== state.selectedContactId || !['ready', 'loading'].includes(state.directoryPhase)) {
      throw new Error('本次联系人已变化，请重新确认。');
    }
    return state;
  }
  private cancelContactRestore(): void { clearTimeout(this.contactRestoreTimer); this.contactRestoreTimer = undefined; }
  private receiveContact(state: ContactSessionState): void {
    if (state.directoryPhase === 'ready') {
      for (const id of this.retainedContent.keys()) {
        if (!state.contacts.some(contact => contact.contactId === id)) this.retainedContent.delete(id);
      }
    } else if (!['ready', 'loading'].includes(state.directoryPhase)) this.retainedContent.clear();
    if (state.scopeRevision !== this.state.scopeRevision || state.selectedContactId !== this.state.contactId) {
      this.cancelContactRestore();
      const generation = this.backend.getConnectionGeneration();
      if (generation !== undefined && generation === this.contentGeneration && this.state.contactId
        && state.contacts.some(contact => contact.contactId === this.state.contactId)) {
        this.retainedContent.set(this.state.contactId, this.pendingContent ?? this.retainWorkspace());
      }
      this.contentGeneration = generation;
      this.pendingContent = state.selectedContactId ? this.retainedContent.get(state.selectedContactId) : undefined;
      this.sessionDelete?.abort(); this.sessionDelete = undefined;
      this.catalogPending?.abort(); this.catalogPending = undefined; this.catalogMutation = undefined;
      this.cancelSavedRead(); this.cancelPending(); this.draft = state.draft;
      this.publish({ scopeRevision: state.scopeRevision, contactId: state.selectedContactId,
        inputClearRevision: (this.state.inputClearRevision ?? 0) + 1,
        savedSession: { phase: 'idle', sessionId: null, ...invalidatedSqliteDiscussion() }, sessionDeletion: undefined,
        sessionCatalog: undefined, confirmedSessionDeletion: undefined, contextRefresh: undefined, sourceAvailability: undefined });
      if (state.selectedContactId && state.directoryPhase === 'ready') {
        const selection = { contactId: state.selectedContactId, scopeRevision: state.scopeRevision };
        this.publish({ savedSession: { phase: 'loading', sessionId: null, ...invalidatedSqliteDiscussion() } });
        this.contactRestoreTimer = setTimeout(() => {
          this.contactRestoreTimer = undefined;
          if (generation === this.backend.getConnectionGeneration() && selection.contactId === this.state.contactId
            && selection.scopeRevision === this.state.scopeRevision) void this.readSavedSession(selection);
        }, 150);
      }
    } else if (state.draft !== this.draft) {
      this.draft = state.draft; this.notifyInputChanged(); this.cancelPending();
    }
  }
  private notifyInputChanged(): void {
    if (this.pendingContent && this.state.contactId) this.retainedContent.delete(this.state.contactId);
    this.pendingContent = undefined; ++this.operation;
  }
  private cancelSavedRead(): void { this.savedRead?.abort(); this.savedRead = undefined; }
  private cancelPending(): void { ++this.operation; }
  private projectionScope(): AssistantProjectionScope {
    return { connectionGeneration: this.backend.getConnectionGeneration(), contactId: this.state.contactId,
      scopeRevision: this.state.scopeRevision, sessionId: this.state.savedSession?.sessionId ?? null };
  }
  private publish(update: Partial<ReplySessionState>, savedOrigin: 'authoritative' | 'local' = 'local'): void {
    const state = { ...this.state, ...update, revision: this.state.revision + 1 };
    this.sessionProjection.registerDisplay({ connectionGeneration: this.backend.getConnectionGeneration(), contactId: state.contactId,
      scopeRevision: state.scopeRevision, sessionId: state.savedSession?.sessionId ?? null }, update.savedSession, savedOrigin);
    this.state = state;
    const previous = this.publishedState, projected = this.projectState(); this.publishedState = projected;
    const changes: Partial<ReplySessionState> = {};
    for (const key of Object.keys(projected) as (keyof ReplySessionState)[]) {
      if (!Object.is(projected[key], previous?.[key])) Object.assign(changes, { [key]: projected[key] });
    }
    if (this.updateListeners.size) {
      const event: ReplyStateUpdate = !previous || previous.contactId !== projected.contactId || previous.scopeRevision !== projected.scopeRevision
        ? { kind: 'snapshot', state: structuredClone(projected) }
        : { kind: 'patch', baseRevision: previous.revision, revision: projected.revision,
          contactId: projected.contactId, scopeRevision: projected.scopeRevision, changes: structuredClone(changes) };
      for (const listener of this.updateListeners) listener(event);
    }
    let snapshot: ReplySessionState | undefined;
    for (const [listener, fields] of this.listeners) {
      if (previous && fields && !fields.some(key => Object.hasOwn(changes, key))) continue;
      snapshot ??= structuredClone(projected); listener(snapshot);
    }
  }
}
