import type { AssistantCandidateHistory, AssistantCandidateSelection, AssistantCandidateVersion, AssistantCandidateVersionsState, ExplicitAssistantCandidateSelection, ReplyCandidateVersionDisplay, ReplyCandidateVersionEdit, ReplyCandidateVersionRead, ReplyCandidateVersionSelection } from '../../shared/assistant-candidate-versions';
import type { ContactSelection } from '../../shared/contact-session-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import { isUuid } from '../uuid';
import { isRecord } from './result-read';

type VersionScope = ContactSelection & { sessionId: string };
export interface AssistantCandidateVersionState {
  candidateVersions: AssistantCandidateVersionsState;
  explicitCandidateSelection: ExplicitAssistantCandidateSelection;
}
type VersionBackend = Pick<BackendHost, 'requestJson' | 'getConnectionGeneration'>;
const invalid = () => new Error('候选版本暂不可用，请重新读取。');
// 仅传递已确认的失效分类和范围身份，由 Main 清理原 turn 与当前结果。
export class AssistantCandidateSourceUnavailable extends Error {
  readonly scope: VersionScope;
  constructor(scope: VersionScope, readonly generation: number, readonly candidateId: string | null) {
    super('候选来源暂不可用，请重新读取。');
    this.scope = { contactId: scope.contactId, scopeRevision: scope.scopeRevision, sessionId: scope.sessionId };
  }
}
function sourceUnavailable(error: unknown): boolean {
  return error instanceof BackendRequestFailure && error.kind === 'response'
    && ((error.status === 404 && error.code === 'not_found')
      || (error.status === 409 && error.code === 'assistant_candidate_version_conflict'
        && (error.reason === 'source_unavailable' || error.reason === 'request_invalidated'
          || error.reason === 'candidate_unavailable')));
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}
// 与 PostgreSQL length / Python len 的 Unicode 字符契约一致，避免拒绝合法完整正文。
const characterCount = (value: string): number => Array.from(value).length;
function history(value: unknown, request: ReplyCandidateVersionRead): AssistantCandidateHistory {
  if (!exact(value, ['session_id', 'turn_id', 'candidate_id', 'candidate_group_id', 'candidate_number',
    'default_display_version_id', 'selected_version_id', 'versions'])
    || value.session_id !== request.sessionId || value.candidate_id !== request.candidateId
    || !isUuid(value.turn_id) || !isUuid(value.candidate_group_id)
    || !Number.isSafeInteger(value.candidate_number) || (value.candidate_number as number) < 1
    || (value.candidate_number as number) > 3 || !Array.isArray(value.versions) || !value.versions.length
    || !isUuid(value.default_display_version_id)
    || (value.selected_version_id !== null && !isUuid(value.selected_version_id))) throw invalid();
  const known = new Set<string>();
  let messageIds: string[] | undefined;
  const versions: AssistantCandidateVersion[] = value.versions.map((item: unknown, index) => {
    if (!exact(item, ['version_id', 'version_number', 'parent_version_id', 'text', 'messages', 'requirements', 'created_at'])
      || !isUuid(item.version_id) || item.version_number !== index
      || !Array.isArray(item.messages) || item.messages.length < 1 || item.messages.length > 8
      || typeof item.text !== 'string' || characterCount(item.text) > 65_536
      || typeof item.created_at !== 'string' || !Number.isFinite(Date.parse(item.created_at))
      || (item.requirements !== null && (typeof item.requirements !== 'string'
        || !item.requirements.trim() || characterCount(item.requirements) > 4096))) throw invalid();
    const versionId = item.version_id.toLowerCase();
    if (known.has(versionId) || (index === 0
      ? versionId !== request.candidateId || item.parent_version_id !== null || item.requirements !== null
      : !isUuid(item.parent_version_id) || !known.has(item.parent_version_id.toLowerCase()))) throw invalid();
    const limit = item.messages.length === 1 ? 65_536 : 8192;
    const messages = item.messages.map((message: unknown) => {
      if (!exact(message, ['message_id', 'text']) || !isUuid(message.message_id)
        || typeof message.text !== 'string' || !message.text.trim() || characterCount(message.text) > limit) throw invalid();
      return { messageId: message.message_id.toLowerCase(), text: message.text };
    });
    const ids = messages.map((message) => message.messageId);
    if (new Set(ids).size !== ids.length || (messageIds && (ids.length !== messageIds.length
      || ids.some((id, number) => id !== messageIds![number])))
      || messages.map((message) => message.text).join('\n\n') !== item.text) throw invalid();
    messageIds = ids; known.add(versionId);
    return { versionId, versionNumber: index,
      parentVersionId: typeof item.parent_version_id === 'string' ? item.parent_version_id.toLowerCase() : null,
      text: item.text, messages, requirements: item.requirements as string | null, createdAt: item.created_at };
  });
  const displayId = value.default_display_version_id.toLowerCase();
  const selectedId = typeof value.selected_version_id === 'string' ? value.selected_version_id.toLowerCase() : null;
  if (displayId !== versions.at(-1)!.versionId || (selectedId !== null && !known.has(selectedId))) throw invalid();
  return { sessionId: request.sessionId, turnId: value.turn_id.toLowerCase(), candidateId: request.candidateId,
    candidateGroupId: value.candidate_group_id.toLowerCase(), candidateNumber: value.candidate_number as number,
    defaultDisplayVersionId: displayId, selectedVersionId: selectedId, versions };
}
function selection(value: unknown, sessionId: string): AssistantCandidateSelection | null {
  if (!exact(value, ['selection'])) throw invalid();
  if (value.selection === null) return null;
  const item = value.selection;
  if (!exact(item, ['selection_id', 'selection_number', 'session_id', 'candidate_id', 'version_id'])
    || !isUuid(item.selection_id) || item.session_id !== sessionId || !isUuid(item.candidate_id)
    || !isUuid(item.version_id) || !Number.isSafeInteger(item.selection_number)
    || (item.selection_number as number) < 1) throw invalid();
  return { selectionId: item.selection_id.toLowerCase(), selectionNumber: item.selection_number as number,
    sessionId, candidateId: item.candidate_id.toLowerCase(), versionId: item.version_id.toLowerCase() };
}

function editReceipt(value: unknown, request: ReplyCandidateVersionEdit): { versionId: string; versionNumber: number } {
  if (!exact(value, ['session_id', 'candidate_id', 'version_id', 'version_number', 'edit_key', 'parent_version_id'])
    || value.session_id !== request.sessionId || value.candidate_id !== request.candidateId
    || value.edit_key !== request.editKey || value.parent_version_id !== request.parentVersionId
    || !isUuid(value.version_id) || !Number.isSafeInteger(value.version_number)
    || (value.version_number as number) < 1) throw invalid();
  return { versionId: value.version_id.toLowerCase(), versionNumber: value.version_number as number };
}

// 只持有当前会话的受信读取视图；明确选择始终重读后端唯一指针。
export class AssistantCandidateVersionSession {
  private scope: VersionScope | null = null;
  private epoch = 0;
  private pending: AbortController | undefined;
  private state: AssistantCandidateVersionState = {
    candidateVersions: { phase: 'idle', sessionId: null, items: [] },
    explicitCandidateSelection: { phase: 'idle', selection: null },
  };
  private readonly listeners = new Set<(state: AssistantCandidateVersionState) => void>();
  constructor(private readonly backend: VersionBackend) {}
  getState(): AssistantCandidateVersionState { return structuredClone(this.state); }
  getCachedTurnCandidates(scope: VersionScope): { turnId: string; candidateIds: string[] }[] {
    this.assertScope(scope);
    // 来源复验只传递现有受信历史的身份，不建立第二份正文缓存。
    return this.state.candidateVersions.items.flatMap((item) => item.history?.sessionId === scope.sessionId
      ? [{ turnId: item.history.turnId, candidateIds: [item.history.candidateId] }] : []);
  }
  onStateChanged(listener: (state: AssistantCandidateVersionState) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  setScope(scope: VersionScope | null): void {
    if (this.scope?.contactId === scope?.contactId && this.scope?.scopeRevision === scope?.scopeRevision
      && this.scope?.sessionId === scope?.sessionId) return;
    this.pending?.abort(); this.pending = undefined; this.epoch += 1;
    this.scope = scope ? { contactId: scope.contactId, scopeRevision: scope.scopeRevision, sessionId: scope.sessionId } : null;
    this.publish({ candidateVersions: { phase: 'idle', sessionId: scope?.sessionId ?? null, items: [] },
      explicitCandidateSelection: { phase: 'idle', selection: null } });
  }
  invalidate(scope: VersionScope, candidateIds?: string[]): void {
    this.assertScope(scope);
    this.pending?.abort(); this.pending = undefined; this.epoch += 1;
    const affected = candidateIds ? new Set(candidateIds) : null;
    const chosen = this.state.explicitCandidateSelection.selection;
    this.publish({ candidateVersions: { phase: 'failed', sessionId: scope.sessionId,
      items: this.state.candidateVersions.items.map((item) => !affected || affected.has(item.candidateId)
        ? { ...item, phase: 'failed', history: null, displayVersionId: null } : item) },
      explicitCandidateSelection: !affected || (chosen && affected.has(chosen.candidateId))
        ? { phase: 'failed', selection: null } : this.state.explicitCandidateSelection });
  }
  async read(request: ReplyCandidateVersionRead, operationCurrent: () => boolean = () => true): Promise<void> {
    await this.load(request, undefined, operationCurrent);
  }
  async reconcile(scope: VersionScope, candidateIds: string[], operationCurrent: () => boolean = () => true): Promise<void> {
    this.assertScope(scope);
    if (!candidateIds.every(isUuid)) throw invalid();
    const known = new Set(candidateIds);
    const previousSelection = this.state.explicitCandidateSelection;
    const items = () => this.state.candidateVersions.items.filter((item) => known.has(item.candidateId));
    this.pending?.abort();
    const pending = new AbortController(); this.pending = pending;
    const epoch = ++this.epoch, generation = this.backend.getConnectionGeneration();
    const current = () => operationCurrent() && !pending.signal.aborted && epoch === this.epoch
      && generation === this.backend.getConnectionGeneration();
    this.publish({ candidateVersions: { phase: 'loading', sessionId: scope.sessionId, items: items() },
      explicitCandidateSelection: { phase: 'loading', selection: null } });
    try {
      const chosen = await this.backend.requestJson({ method: 'GET',
        path: `/api/contacts/${scope.contactId}/assistant-sessions/${scope.sessionId}/selections`, signal: pending.signal });
      if (!current() || chosen.generation !== generation) return;
      this.publish({ candidateVersions: { phase: 'ready', sessionId: scope.sessionId, items: items() },
        explicitCandidateSelection: { phase: 'ready', selection: selection(chosen.data, scope.sessionId) } });
    } catch (error) {
      if (!current() && sourceUnavailable(error) && this.sourceScopeCurrent(scope, generation)) {
        throw new AssistantCandidateSourceUnavailable(scope, generation!, null);
      }
      if (current()) {
        const unavailable = sourceUnavailable(error);
        const failed: AssistantCandidateVersionState = { candidateVersions: { phase: 'failed', sessionId: scope.sessionId,
          items: items() },
          explicitCandidateSelection: { phase: 'failed',
            selection: !unavailable && error instanceof BackendRequestFailure ? previousSelection.selection : null } };
        // 已确认来源失效先交给 Main 隔离视图，避免先回显其他未核验缓存。
        if (unavailable) { this.state = failed; throw new AssistantCandidateSourceUnavailable(scope, generation!, null); }
        this.publish(failed);
        throw invalid();
      }
    } finally { if (this.pending === pending) this.pending = undefined; }
  }
  async save(edit: ReplyCandidateVersionEdit, operationCurrent: () => boolean = () => true): Promise<void> {
    this.assertScope(edit);
    const saved = this.state.candidateVersions.items.find((item) => item.candidateId === edit.candidateId)?.history;
    if (!saved || !isUuid(edit.editKey) || !saved.versions.some((item) => item.versionId === edit.parentVersionId)
      || !Array.isArray(edit.messages) || edit.messages.length !== saved.versions[0].messages.length
      || edit.messages.some((message, index) => message.messageId !== saved.versions[0].messages[index].messageId
        || typeof message.text !== 'string' || !message.text.trim()
        || message.text.length > (edit.messages.length === 1 ? 65_536 : 8192))
      || edit.messages.map((message) => message.text).join('\n\n').length > 65_536
      || (edit.requirements !== null && (typeof edit.requirements !== 'string'
        || !edit.requirements.trim() || edit.requirements.length > 4096))) throw invalid();
    await this.load(edit, edit, operationCurrent);
  }
  show(request: ReplyCandidateVersionDisplay): void {
    this.assertScope(request);
    const view = this.state.candidateVersions.items.find((item) => item.candidateId === request.candidateId);
    if (view?.phase !== 'ready' || !view.history?.versions.some((item) => item.versionId === request.versionId)) throw invalid();
    this.publish({ ...this.state, candidateVersions: { ...this.state.candidateVersions,
      items: this.state.candidateVersions.items.map((item) => item.candidateId === request.candidateId
        ? { ...item, displayVersionId: request.versionId } : item) } });
  }
  async select(request: ReplyCandidateVersionSelection, operationCurrent: () => boolean = () => true): Promise<void> {
    this.assertScope(request);
    const saved = this.state.candidateVersions.items.find((item) => item.candidateId === request.candidateId);
    if (saved?.phase !== 'ready' || !isUuid(request.selectionKey)
      || !saved.history?.versions.some((item) => item.versionId === request.versionId)) throw invalid();
    this.pending?.abort();
    const pending = new AbortController(); this.pending = pending;
    const epoch = ++this.epoch, generation = this.backend.getConnectionGeneration();
    const current = () => operationCurrent() && !pending.signal.aborted && epoch === this.epoch
      && generation === this.backend.getConnectionGeneration();
    const path = `/api/contacts/${request.contactId}/assistant-sessions/${request.sessionId}/selections`;
    const previousSelection = this.state.explicitCandidateSelection;
    let unavailableCandidateId: string | null = request.candidateId;
    this.publish({ ...this.state, explicitCandidateSelection: { phase: 'saving', selection: null } });
    try {
      const response = await this.backend.requestJson({ method: 'POST', path, signal: pending.signal,
        body: { selection_key: request.selectionKey, candidate_id: request.candidateId, version_id: request.versionId } });
      if (!current() || response.generation !== generation) return;
      const receipt = selection({ selection: response.data }, request.sessionId);
      if (receipt?.candidateId !== request.candidateId || receipt.versionId !== request.versionId) throw invalid();
      unavailableCandidateId = null;
      const chosen = await this.backend.requestJson({ method: 'GET', path, signal: pending.signal });
      if (!current() || chosen.generation !== generation) return;
      const actual = selection(chosen.data, request.sessionId);
      if (actual?.candidateId === saved.candidateId
        && !saved.history.versions.some((item) => item.versionId === actual.versionId)) throw invalid();
      this.publish({ ...this.state, explicitCandidateSelection: { phase: 'ready', selection: actual } });
    } catch (error) {
      if (!current() && sourceUnavailable(error) && this.sourceScopeCurrent(request, generation)) {
        throw new AssistantCandidateSourceUnavailable(request, generation!, unavailableCandidateId);
      }
      if (current()) {
        const unavailable = sourceUnavailable(error), retain = !unavailable && error instanceof BackendRequestFailure;
        const failed: AssistantCandidateVersionState = { candidateVersions: { phase: 'failed', sessionId: request.sessionId,
          items: this.state.candidateVersions.items.map((item) => (unavailable && unavailableCandidateId === null)
            ? item : item.candidateId === request.candidateId
            ? { ...item, phase: 'failed', history: retain ? item.history : null,
              displayVersionId: retain ? item.displayVersionId : null } : item) },
          explicitCandidateSelection: { phase: 'failed', selection: retain ? previousSelection.selection : null } };
        if (unavailable) { this.state = failed; throw new AssistantCandidateSourceUnavailable(request, generation!, unavailableCandidateId); }
        this.publish(failed);
        throw invalid();
      }
    } finally { if (this.pending === pending) this.pending = undefined; }
  }
  private async load(request: ReplyCandidateVersionRead, edit?: ReplyCandidateVersionEdit,
    operationCurrent: () => boolean = () => true): Promise<void> {
    this.assertScope(request);
    this.pending?.abort();
    const pending = new AbortController(); this.pending = pending;
    const epoch = ++this.epoch, generation = this.backend.getConnectionGeneration();
    const current = () => operationCurrent() && !pending.signal.aborted && epoch === this.epoch
      && generation === this.backend.getConnectionGeneration();
    const retained = this.state.candidateVersions.items.filter((item) => item.candidateId !== request.candidateId);
    const previous = this.state.candidateVersions.items.find((item) => item.candidateId === request.candidateId);
    const previousSelection = this.state.explicitCandidateSelection;
    let unavailableCandidateId: string | null = request.candidateId;
    const base = `/api/contacts/${request.contactId}/assistant-sessions/${request.sessionId}`;
    this.publish({ candidateVersions: { phase: 'loading', sessionId: request.sessionId,
      items: [...retained, { candidateId: request.candidateId, phase: edit ? 'saving' : 'loading', history: null, displayVersionId: null }] },
      explicitCandidateSelection: { phase: 'loading', selection: null } });
    try {
      let receipt: { versionId: string; versionNumber: number } | undefined;
      if (edit) {
        const response = await this.backend.requestJson({ method: 'POST',
          path: `${base}/candidates/${request.candidateId}/versions?receipt=1`, signal: pending.signal,
          body: { edit_key: edit.editKey, parent_version_id: edit.parentVersionId,
          messages: edit.messages.map((message) => ({ message_id: message.messageId, text: message.text })),
            requirements: edit.requirements } });
        if (!current() || response.generation !== generation) return;
        receipt = editReceipt(response.data, edit);
      }
      const saved = await this.readPages(request, pending.signal, generation, current);
      if (!saved || !current()) return;
      if (receipt) {
        const written = saved.versions.find((version) => version.versionId === receipt.versionId);
        if (!written || written.versionNumber !== receipt.versionNumber
          || written.parentVersionId !== edit!.parentVersionId
          || written.requirements !== edit!.requirements
          || written.messages.length !== edit!.messages.length
          || written.messages.some((message, index) => message.messageId !== edit!.messages[index].messageId
            || message.text !== edit!.messages[index].text)) throw invalid();
      }
      this.publish({ ...this.state, candidateVersions: { phase: 'loading', sessionId: request.sessionId,
        items: [...this.state.candidateVersions.items.filter((item) => item.candidateId !== request.candidateId),
          { candidateId: saved.candidateId, phase: 'ready', history: saved, displayVersionId: saved.defaultDisplayVersionId }] } });
      unavailableCandidateId = null;
      const chosen = await this.backend.requestJson({ method: 'GET', path: `${base}/selections`, signal: pending.signal });
      if (!current() || chosen.generation !== generation) return;
      const actual = selection(chosen.data, request.sessionId);
      if (actual?.candidateId === saved.candidateId && !saved.versions.some((item) => item.versionId === actual.versionId)) throw invalid();
      saved.selectedVersionId = actual?.candidateId === saved.candidateId ? actual.versionId : null;
      // 选择重读只收尾实际指针；保留期间用户已明确展开的版本。
      const displayVersionId = this.state.candidateVersions.items.find((item) => item.candidateId === saved.candidateId)
        ?.displayVersionId ?? saved.defaultDisplayVersionId;
      this.publish({ candidateVersions: { phase: 'ready', sessionId: request.sessionId,
        items: [...this.state.candidateVersions.items.filter((item) => item.candidateId !== request.candidateId),
          { candidateId: saved.candidateId, phase: 'ready', history: saved, displayVersionId }] },
        explicitCandidateSelection: { phase: 'ready', selection: actual } });
    } catch (error) {
      if (!current() && sourceUnavailable(error) && this.sourceScopeCurrent(request, generation)) {
        throw new AssistantCandidateSourceUnavailable(request, generation!, unavailableCandidateId);
      }
      if (current()) {
        const unavailable = sourceUnavailable(error), retain = !unavailable && error instanceof BackendRequestFailure;
        const trusted = this.state.candidateVersions.items.find((item) => item.candidateId === request.candidateId);
        const retainedVersion = trusted?.history ? trusted : previous;
        const unknownCandidate = unavailable && unavailableCandidateId === null;
        const failed: AssistantCandidateVersionState = { candidateVersions: { phase: 'failed', sessionId: request.sessionId,
          items: [...this.state.candidateVersions.items.filter((item) => item.candidateId !== request.candidateId),
            { candidateId: request.candidateId, phase: unknownCandidate ? retainedVersion?.phase ?? 'failed' : 'failed',
              history: retain || unknownCandidate ? retainedVersion?.history ?? null : null,
              displayVersionId: retain || unknownCandidate ? retainedVersion?.displayVersionId ?? null : null }] },
          explicitCandidateSelection: { phase: 'failed', selection: retain ? previousSelection.selection : null } };
        if (unavailable) { this.state = failed; throw new AssistantCandidateSourceUnavailable(request, generation!, unavailableCandidateId); }
        this.publish(failed);
        throw invalid();
      }
    } finally { if (this.pending === pending) this.pending = undefined; }
  }
  private async readPages(request: ReplyCandidateVersionRead, signal: AbortSignal,
    generation: number | undefined, current: () => boolean): Promise<AssistantCandidateHistory | null> {
    const versions: unknown[] = [];
    let first: Record<string, unknown> | undefined;
    let pageNumber = 0;
    while (current()) {
      const through = first ? `&through=${first.default_display_version_id}` : '';
      const response = await this.backend.requestJson({ method: 'GET',
        path: `/api/contacts/${request.contactId}/assistant-sessions/${request.sessionId}/candidates/${request.candidateId}/versions?page=${pageNumber}${through}`,
        signal });
      if (!current() || response.generation !== generation) return null;
      const page = response.data;
      if (!exact(page, ['session_id', 'turn_id', 'candidate_id', 'candidate_group_id', 'candidate_number',
        'default_display_version_id', 'versions', 'page_number', 'version_count', 'next_page'])
        || page.session_id !== request.sessionId || page.candidate_id !== request.candidateId
        || page.page_number !== pageNumber || !Number.isSafeInteger(page.version_count)
        || (page.version_count as number) < 1 || pageNumber >= (page.version_count as number)
        || !isUuid(page.default_display_version_id) || !Array.isArray(page.versions) || page.versions.length !== 1
        || !isRecord(page.versions[0]) || page.versions[0].version_number !== pageNumber
        || page.next_page !== (pageNumber + 1 < (page.version_count as number) ? pageNumber + 1 : null)) throw invalid();
      if (first && ['session_id', 'turn_id', 'candidate_id', 'candidate_group_id', 'candidate_number',
        'default_display_version_id', 'version_count'].some((key) => page[key] !== first![key])) throw invalid();
      first ??= page;
      versions.push(page.versions[0]);
      if (page.next_page === null) {
        const { page_number: _pageNumber, version_count: _versionCount, next_page: _nextPage, ...header } = first;
        // 完整收齐后才进入受信视图；任意页失败让局部累积正文随此调用丢弃。
        return history({ ...header, selected_version_id: null, versions }, request);
      }
      pageNumber += 1;
    }
    return null;
  }
  private assertScope(request: VersionScope & { candidateId?: string }): void {
    if (this.backend.getConnectionGeneration() === undefined || this.scope?.contactId !== request.contactId
      || this.scope?.scopeRevision !== request.scopeRevision || this.scope?.sessionId !== request.sessionId
      || (request.candidateId !== undefined && !isUuid(request.candidateId))) throw invalid();
  }
  // 展示结果可被新操作接管；同范围已确认的来源失效仍须交给 Main 复验。
  private sourceScopeCurrent(scope: VersionScope, generation: number | undefined): boolean {
    return generation !== undefined && generation === this.backend.getConnectionGeneration()
      && this.scope?.contactId === scope.contactId && this.scope.scopeRevision === scope.scopeRevision
      && this.scope.sessionId === scope.sessionId;
  }
  private publish(state: AssistantCandidateVersionState): void {
    this.state = state;
    for (const listener of this.listeners) listener(this.getState());
  }
}
