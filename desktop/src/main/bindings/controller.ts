import type { BindingConfirmation, BindingConsentState, BindingRevocation, BindingSelection, BindingSummary, CliSessionSummary } from '../../shared/binding-consent-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import { runtimeOwnerConfigured } from '../contacts/directory';
import type { ContactSession } from '../contacts/session';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error('授权目录不可用。');
  return value.toLowerCase();
};
const locator = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f]/.test(value)) throw new Error('会话元数据不可用。');
  return value;
};
export function bindingSummary(value: unknown): BindingSummary {
  if (!record(value) || (value.status !== 'active' && value.status !== 'revoked')
    || (value.display_name !== null && typeof value.display_name !== 'string')) throw new Error('授权目录不可用。');
  return { bindingId: identifier(value.binding_id), contactId: identifier(value.contact_id),
    locator: locator(value.conversation_locator), displayName: value.display_name, status: value.status };
}
function bindings(value: unknown): BindingSummary[] {
  if (!record(value) || !Array.isArray(value.bindings)) throw new Error('授权目录不可用。');
  const items = value.bindings.map(bindingSummary);
  if (items.some((item) => item.status !== 'active') || new Set(items.map((item) => item.locator)).size !== items.length) throw new Error('授权目录不可用。');
  return items;
}
function sessions(value: unknown): CliSessionSummary[] {
  if (!record(value) || !Array.isArray(value.sessions)) throw new Error('会话元数据不可用。');
  const items = value.sessions.map((entry): CliSessionSummary => {
    if (!record(entry) || typeof entry.display_name !== 'string' || !entry.display_name.trim()
      || (entry.last_timestamp !== null && (!Number.isSafeInteger(entry.last_timestamp) || typeof entry.last_timestamp !== 'number'))) throw new Error('会话元数据不可用。');
    return { locator: locator(entry.username), displayName: entry.display_name, lastTimestamp: entry.last_timestamp as number | null,
      boundContactId: entry.bound_contact_id === null ? null : identifier(entry.bound_contact_id) };
  });
  if (new Set(items.map((item) => item.locator)).size !== items.length) throw new Error('会话元数据不可用。');
  return items;
}
type Operation = { generation: number; epoch: number };
class SelectionStale extends Error {}

// 认证传输复用 BackendHost，读取范围始终由服务端的运行身份决定。
export class BindingConsentController {
  private state: BindingConsentState = { revision: 0, scopeRevision: 0, phase: 'offline',
    sessions: [], bindings: [], syncEnabled: null, sessionIssue: null, busy: null, errorCode: null, notice: null };
  private generation: number | undefined;
  private epoch = 0;
  private readonly listeners = new Set<(state: BindingConsentState) => void>();
  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession) {
    backend.onStateChanged(() => {
      const generation = backend.getConnectionGeneration();
      if (generation === this.generation) return;
      this.generation = generation; ++this.epoch;
      this.publish({ phase: 'offline', sessions: [], bindings: [], syncEnabled: null, sessionIssue: null,
        busy: null, errorCode: null, notice: null,
        scopeRevision: this.state.scopeRevision + 1 });
      if (generation !== undefined) void this.refresh();
    });
  }
  getState(): BindingConsentState { return { ...this.state, sessions: this.state.sessions.map((item) => ({ ...item })),
    bindings: this.state.bindings.map((item) => ({ ...item })) }; }
  onStateChanged(listener: (state: BindingConsentState) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  async refresh(): Promise<void> {
    if (this.state.busy) return;
    const generation = this.backend.getConnectionGeneration();
    if (generation === undefined) return;
    const operation = { generation, epoch: ++this.epoch };
    this.publish({ errorCode: null, notice: null });
    await this.load(operation);
  }
  private async load(operation: Operation): Promise<void> {
    this.publish({ phase: 'loading' });
    try {
      const setup = await this.backend.requestJson({ method: 'GET', path: '/api/setup/status', maxResponseBytes: 4096 });
      if (!this.current(operation)) return;
      if (!runtimeOwnerConfigured(setup.data)) {
        this.publish({ phase: 'owner-unconfigured', sessions: [], bindings: [], syncEnabled: null }); return;
      }
      const directory = await this.backend.requestJson({ method: 'GET', path: '/api/sync/cli-bindings' });
      const active = bindings(directory.data);
      const list = await Promise.allSettled([
        this.backend.requestJson({ method: 'GET', path: '/api/sync/cli-sessions' }),
        this.backend.requestJson({ method: 'GET', path: '/api/sync/status' }),
      ]);
      if (!this.current(operation)) return;
      let sessionList: CliSessionSummary[] = [];
      let sessionIssue: BindingConsentState['sessionIssue'] = null;
      if (list[0].status === 'fulfilled') sessionList = sessions(list[0].value.data);
      else sessionIssue = list[0].reason instanceof BackendRequestFailure && list[0].reason.status === 503 ? 'unavailable' : 'failed';
      const status = list[1].status === 'fulfilled' ? list[1].value.data : null;
      this.publish({ phase: 'ready', bindings: active, sessions: sessionList, sessionIssue,
        syncEnabled: record(status) && typeof status.sync_enabled === 'boolean' ? status.sync_enabled : null });
    } catch (error) {
      if (!this.current(operation)) return;
      const unavailable = error instanceof BackendRequestFailure && error.code === 'sync_unavailable';
      this.publish({ phase: unavailable ? 'unavailable' : 'failed', sessions: [], bindings: [], syncEnabled: null });
    }
  }
  async confirmSelections(confirmation: BindingConfirmation): Promise<void> {
    const generation = this.backend.getConnectionGeneration();
    if (generation === undefined || this.state.busy || this.state.phase !== 'ready'
      || confirmation.scopeRevision !== this.state.scopeRevision) throw new Error('本次授权选择已失效，请刷新后重新确认。');
    const operation = { generation, epoch: ++this.epoch };
    this.publish({ busy: 'confirm', errorCode: null, notice: null });
    try {
      this.validateSelections(confirmation.selections, this.state.sessions, this.state.bindings);
      // 最终提交前重新读取元数据与授权，不把旧列表或名称当作新的确认。
      const [metadata, directory] = await Promise.all([
        this.backend.requestJson({ method: 'GET', path: '/api/sync/cli-sessions' }),
        this.backend.requestJson({ method: 'GET', path: '/api/sync/cli-bindings' }),
      ]);
      if (!this.current(operation)) return;
      this.validateSelections(confirmation.selections, sessions(metadata.data), bindings(directory.data));
      const result = await this.backend.requestJson({ method: 'POST', path: '/api/sync/cli-bindings/confirm', body: {
        selections: confirmation.selections.map((item) => ({ locator: item.locator, display_name: item.displayName,
          observed_display_name: item.displayName,
          ...(item.contactId === null ? {} : { contact_id: item.contactId }) })),
      } });
      if (!this.current(operation)) return;
      if (!record(result.data) || typeof result.data.sync_enabled !== 'boolean') throw new Error('授权确认结果不可用。');
      this.publish({ notice: 'confirmed', syncEnabled: result.data.sync_enabled, scopeRevision: this.state.scopeRevision + 1 });
      await this.contacts.refreshContacts();
      if (this.current(operation)) await this.load(operation);
    } catch (error) {
      if (!this.current(operation)) return;
      const stale = error instanceof SelectionStale || (error instanceof BackendRequestFailure && error.status === 409);
      this.publish({ errorCode: stale ? 'selection-stale' : 'confirmation-failed',
        ...(stale ? { scopeRevision: this.state.scopeRevision + 1 } : {}) });
      await this.load(operation);
    } finally { if (this.current(operation)) this.publish({ busy: null }); }
  }
  private validateSelections(selected: BindingSelection[], metadata: CliSessionSummary[], active: BindingSummary[]): void {
    const contacts = this.contacts.getState();
    if (!selected.length || new Set(selected.map((item) => item.locator)).size !== selected.length
      || (contacts.directoryPhase !== 'ready' && contacts.directoryPhase !== 'loading')) throw new SelectionStale();
    for (const choice of selected) {
      const candidate = metadata.find((item) => item.locator === choice.locator);
      if (!candidate || candidate.displayName !== choice.displayName || candidate.boundContactId !== null
        || active.some((binding) => binding.locator === choice.locator)
        || (choice.contactId !== null && !contacts.contacts.some((contact) => contact.contactId === choice.contactId))) throw new SelectionStale();
    }
  }
  async revokeBinding(revocation: BindingRevocation): Promise<void> {
    const generation = this.backend.getConnectionGeneration();
    if (generation === undefined || this.state.busy || this.state.phase !== 'ready'
      || revocation.scopeRevision !== this.state.scopeRevision
      || !this.state.bindings.some((item) => item.bindingId === revocation.bindingId && item.contactId === revocation.contactId)) {
      throw new Error('本次授权范围已失效，请刷新后重新确认。');
    }
    const operation = { generation, epoch: ++this.epoch };
    this.publish({ busy: 'revoke', errorCode: null, notice: null });
    try {
      const response = await this.backend.requestJson({ method: 'POST', path: '/api/sync/cli-bindings/revoke',
        body: { contact_id: revocation.contactId, binding_id: revocation.bindingId } });
      if (!this.current(operation)) return;
      const result = bindingSummary(response.data);
      if (result.status !== 'revoked' || result.bindingId !== revocation.bindingId || result.contactId !== revocation.contactId) throw new Error('撤销结果尚未确认。');
      this.publish({ notice: 'revoked', bindings: this.state.bindings.filter((item) => item.bindingId !== result.bindingId),
        scopeRevision: this.state.scopeRevision + 1 });
      await this.load(operation);
    } catch (error) {
      if (!this.current(operation)) return;
      const busy = error instanceof BackendRequestFailure && error.code === 'cli_binding_revoke_busy';
      this.publish({ errorCode: busy ? 'revoke-busy' : 'revoke-failed' });
      // 取得锁前超时保证没有写入，直接保留授权供显式重试；其他失败需复核真实目录。
      if (!busy) await this.load(operation);
    } finally { if (this.current(operation)) this.publish({ busy: null }); }
  }
  private current(operation: Operation): boolean {
    return operation.generation === this.backend.getConnectionGeneration() && operation.epoch === this.epoch;
  }
  private publish(update: Partial<BindingConsentState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
