import type { ContactSelection } from '../../shared/contact-session-bridge';
import { randomUUID } from 'node:crypto';
import type { ExpressionPreferenceRemoval, ExpressionPreferenceSave, ExpressionPreferenceState, ExpressionPreferenceUpdate } from '../../shared/expression-preference-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { readExpressionPreference } from './client';

type Scope = { generation: number; contactId: string; scopeRevision: number };

export class ExpressionPreferenceController {
  private state: ExpressionPreferenceState = { revision: 0, erasureRevision: 0, contactId: null,
    scopeRevision: 0, phase: 'idle', preferences: [], busy: false, error: null };
  private scope: Scope | undefined;
  private reading: AbortController | undefined;
  private writing: AbortController | undefined;
  private retry: { signature: string; operationKey: string } | undefined;
  private readonly listeners = new Set<(state: ExpressionPreferenceState) => void>();

  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession,
    private readonly deletion?: { started(): void; settled(): Promise<void> }) {}
  getState(): ExpressionPreferenceState { this.synchronizeScope(); return structuredClone(this.state); }
  onStateChanged(listener: (state: ExpressionPreferenceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  synchronizeScope(): void {
    const generation = this.backend.getConnectionGeneration();
    const contact = this.contacts.getState();
    const allowed = generation !== undefined && contact.selectedContactId !== null
      && ['ready', 'loading'].includes(contact.directoryPhase)
      && contact.contacts.some((item) => item.contactId === contact.selectedContactId);
    const next = allowed ? { generation, contactId: contact.selectedContactId!, scopeRevision: contact.scopeRevision } : undefined;
    if (next?.generation === this.scope?.generation && next?.contactId === this.scope?.contactId
      && next?.scopeRevision === this.scope?.scopeRevision) return;
    this.reading?.abort();
    this.reading = undefined;
    this.writing?.abort();
    this.writing = undefined;
    this.retry = undefined;
    this.scope = next;
    this.publish({ erasureRevision: this.state.erasureRevision + 1, contactId: next?.contactId ?? null,
      scopeRevision: contact.scopeRevision, phase: 'idle', preferences: [], busy: false, error: null });
  }
  async refresh(selection: ContactSelection): Promise<void> {
    if (this.writing) throw new Error('长期偏好操作尚未完成，请稍后刷新。');
    await this.readDirectory(selection);
  }
  private async readDirectory(selection: ContactSelection): Promise<void> {
    this.synchronizeScope();
    const scope = this.requireScope(selection);
    this.reading?.abort();
    const pending = new AbortController();
    this.reading = pending;
    const current = () => {
      this.synchronizeScope();
      return this.scope === scope && this.reading === pending && !pending.signal.aborted;
    };
    this.publish({ phase: 'loading', preferences: [], error: null });
    try {
      const result = await this.backend.requestJson({ method: 'GET', path: this.path(scope), signal: pending.signal });
      if (!current() || result.generation !== scope.generation) return;
      const value = result.data as Record<string, unknown>;
      if (!value || !Array.isArray(value.preferences)) throw new Error('长期偏好目录无效。');
      const preferences = value.preferences.map(readExpressionPreference);
      if (preferences.some((item) => item.scope.contactId !== null && item.scope.contactId !== scope.contactId)) {
        throw new Error('长期偏好目录越出当前联系人范围。');
      }
      if (new Set(preferences.map((item) => item.preferenceId)).size !== preferences.length) throw new Error('长期偏好目录无效。');
      this.publish({ phase: 'ready', preferences });
    } catch {
      if (current()) this.publish({ phase: 'error', preferences: [], error: '长期偏好暂时无法读取，请刷新重试。' });
    } finally { if (this.reading === pending) this.reading = undefined; }
  }
  async invalidateSource(_contactId: string): Promise<void> {
    this.synchronizeScope();
    this.reading?.abort(); this.reading = undefined;
    this.writing?.abort(); this.writing = undefined;
    this.retry = undefined;
    this.publish({ erasureRevision: this.state.erasureRevision + 1, preferences: [], busy: false, phase: 'idle', error: null });
    if (this.scope) await this.refresh(this.scope);
  }
  async save(request: ExpressionPreferenceSave): Promise<void> {
    this.synchronizeScope();
    const scope = this.requireScope(request);
    const body = this.confirmedContent(request, scope);
    await this.write(scope, request, 'POST', this.path(scope), { ...body, origin: { kind: 'manual' } });
  }
  async update(request: ExpressionPreferenceUpdate): Promise<void> {
    this.synchronizeScope();
    const scope = this.requireScope(request);
    const body = this.confirmedContent(request, scope);
    const path = this.path(scope, request.preferenceId);
    const update = { ...body, expected_revision: request.expectedRevision };
    if (!this.retryIs('PATCH', path, update)) this.requireVersion(request);
    await this.write(scope, request, 'PATCH', path, update);
  }
  async remove(request: ExpressionPreferenceRemoval): Promise<void> {
    this.synchronizeScope();
    const scope = this.requireScope(request);
    const path = this.path(scope, request.preferenceId);
    const body = { expected_revision: request.expectedRevision };
    if (!this.retryIs('DELETE', path, body)) this.requireVersion(request);
    if (this.writing) throw new Error('长期偏好操作尚未完成。');
    this.publish({ erasureRevision: this.state.erasureRevision + 1, preferences: [] });
    this.deletion?.started();
    try { await this.write(scope, request, 'DELETE', path, body); }
    finally { await this.deletion?.settled(); }
  }
  private requireVersion(request: ExpressionPreferenceRemoval): void {
    const previous = this.state.preferences.find((item) => item.preferenceId === request.preferenceId);
    if (this.state.phase !== 'ready' || !previous || previous.revision !== request.expectedRevision) {
      throw new Error('长期偏好范围或版本已变化，请刷新后再操作。');
    }
  }
  private confirmedContent(request: ExpressionPreferenceSave, scope: Scope): Record<string, unknown> {
    if (this.writing || request.confirmLongTerm !== true || typeof request.text !== 'string'
      || !request.text.trim() || request.text.trim().length > 512
      || !['owner', 'contact'].includes(request.appliesTo)
      || request.replyMode !== null && !['reply_to_message', 'rewrite_draft', 'initiate_conversation'].includes(request.replyMode)) {
      throw new Error('请明确长期保存，并核对偏好内容与适用范围。');
    }
    return { text: request.text.trim(),
      scope: { contact_id: request.appliesTo === 'contact' ? scope.contactId : null, reply_mode: request.replyMode },
      confirm_long_term: true };
  }
  private async write(scope: Scope, selection: ContactSelection, method: 'POST' | 'PATCH' | 'DELETE', path: string,
    body: Record<string, unknown>): Promise<void> {
    this.reading?.abort();
    this.reading = undefined;
    const pending = new AbortController();
    this.writing = pending;
    // 仅在本次可信范围的内存中保留未确认动作；恢复时先重读，不自动重放正文。
    const signature = `${method} ${path} ${JSON.stringify(body)}`;
    const action = this.retry?.signature === signature ? this.retry : { signature, operationKey: randomUUID() };
    this.retry = action;
    const current = () => { this.synchronizeScope(); return this.scope === scope && this.writing === pending; };
    this.publish({ busy: true, error: null });
    try {
      const result = await this.backend.requestJson({ method, path,
        signal: pending.signal, body: { ...body, operation_key: action.operationKey } });
      if (!current() || result.generation !== scope.generation) return;
      if (method !== 'DELETE') readExpressionPreference((result.data as Record<string, unknown>)?.preference);
      else if ((result.data as Record<string, unknown>)?.state !== 'deleted') throw new Error('删除回执无效。');
      await this.readDirectory(selection);
      if (current() && this.state.phase !== 'ready') throw new Error('偏好已提交，请刷新核对。');
      if (current()) this.retry = undefined;
    } catch {
      if (current()) {
        this.publish({ error: '长期偏好操作或核对未完成，请刷新确认后重试。' });
        throw new Error('长期偏好操作或核对未完成，请刷新确认后重试。');
      }
    } finally { if (this.writing === pending) { this.writing = undefined; this.publish({ busy: false }); } }
  }
  private retryIs(method: string, path: string, body: Record<string, unknown>): boolean {
    return this.retry?.signature === `${method} ${path} ${JSON.stringify(body)}`;
  }
  private requireScope(selection: ContactSelection): Scope {
    const scope = this.scope;
    if (!scope || selection.contactId !== scope.contactId || selection.scopeRevision !== scope.scopeRevision) {
      throw new Error('长期偏好操作范围已变化，请重新选择联系人。');
    }
    return scope;
  }
  private path(scope: Scope, preferenceId?: string): string {
    return `/api/expression-preferences${preferenceId ? `/${preferenceId}` : ''}?contact_id=${scope.contactId}`;
  }
  private publish(change: Partial<ExpressionPreferenceState>): void {
    this.state = { ...this.state, ...change, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(structuredClone(this.state));
  }
}
