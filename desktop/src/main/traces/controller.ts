import type { ContactSelection } from '../../shared/contact-session-bridge';
import type { TraceBatchRequest, TraceFindRequest, TraceListRequest, TraceResource, TraceState } from '../../shared/trace-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import type { ContactSession } from '../contacts/session';
import { isUuid } from '../uuid';
import { batchId, batches, document } from './read';

type Scope = { generation: number; contactId: string; scopeRevision: number };
const empty = (): Pick<TraceState, 'batches' | 'nextBefore' | 'availability' | 'detail'> => ({ batches: [], nextBefore: null, availability: null, detail: null });

// 正文只停留在当前管理窗口的内存；范围、来源与连接变化取消旧请求并清除快照。
export class TraceController {
  private state: TraceState = { revision: 0, contactId: null, scopeRevision: 0, resource: 'memory-traces', phase: 'idle', message: '', ...empty() };
  private scope: Scope | undefined;
  private operation: { abort: AbortController; mutation: boolean } | undefined;
  private readonly listeners = new Set<(state: TraceState) => void>();
  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession) {}
  getState(): TraceState { return structuredClone(this.state); }
  onStateChanged(listener: (state: TraceState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  synchronizeScope(): void {
    const generation = this.backend.getConnectionGeneration();
    const contact = this.contacts.getState();
    const allowed = generation !== undefined && contact.selectedContactId !== null
      && ['ready', 'loading'].includes(contact.directoryPhase)
      && contact.contacts.some((entry) => entry.contactId === contact.selectedContactId);
    const next = allowed ? { generation, contactId: contact.selectedContactId!, scopeRevision: contact.scopeRevision } : undefined;
    if (next?.generation === this.scope?.generation && next?.contactId === this.scope?.contactId && next?.scopeRevision === this.scope?.scopeRevision) return;
    this.operation?.abort.abort(); this.operation = undefined; this.scope = next;
    this.publish({ contactId: next?.contactId ?? null, scopeRevision: contact.scopeRevision, phase: 'idle', message: '', ...empty() });
  }
  invalidateSource(): void {
    this.operation?.abort.abort(); this.operation = undefined;
    this.publish({ phase: 'idle', message: '来源已变化，请重新读取过程。', ...empty() });
  }
  private requireScope(request: ContactSelection): Scope {
    this.synchronizeScope();
    if (!this.scope || request.contactId !== this.scope.contactId || request.scopeRevision !== this.scope.scopeRevision) throw new Error('过程范围已失效，请重新确认联系人。');
    if (this.operation?.mutation) throw new Error('正在删除过程记录，请稍后再试。');
    return this.scope;
  }
  private path(scope: Scope, resource: TraceResource): string { return `/api/contacts/${scope.contactId}/${resource}`; }
  async list(request: TraceListRequest): Promise<void> {
    const scope = this.requireScope(request);
    const older = request.older === true;
    if (older && (this.state.resource !== request.resource || this.state.phase !== 'ready' || !this.state.nextBefore)) throw new Error('更早批次暂不可用，请刷新列表。');
    const previous = older ? this.state.batches : [];
    const before = older ? `&before=${this.state.nextBefore}` : '';
    await this.run(scope, request.resource, 'GET', `${this.path(scope, request.resource)}?limit=20${before}`, false, (value) => {
      const result = document(value);
      const items = batches(request.resource, result.batches, scope.contactId);
      if (result.next_before !== null && !isUuid(result.next_before)) throw new Error('批次游标暂不可用。');
      this.publish({ batches: [...previous, ...items], nextBefore: result.next_before as string | null });
    });
  }
  async find(request: TraceFindRequest): Promise<void> {
    const scope = this.requireScope(request);
    await this.run(scope, request.resource, 'GET', `${this.path(scope, request.resource)}/records/${request.kind}/${request.recordId}`, false, (value) => {
      const result = document(value);
      if (!['recorded', 'deleted', 'not_recorded', 'not_applicable'].includes(result.availability as string)) throw new Error('过程状态暂不可用。');
      this.publish({ batches: batches(request.resource, result.batches, scope.contactId), availability: result.availability as TraceState['availability'] });
    });
  }
  async show(request: TraceBatchRequest): Promise<void> {
    const scope = this.requireScope(request);
    const previous = this.state.resource === request.resource ? this.state.batches : [];
    const nextBefore = this.state.resource === request.resource ? this.state.nextBefore : null;
    await this.run(scope, request.resource, 'GET', `${this.path(scope, request.resource)}/${request.batchId}`, false, (value) => {
      const detail = document(value);
      if (detail.contact_id !== scope.contactId || batchId(request.resource, detail) !== request.batchId
        || !Array.isArray(detail[request.resource === 'memory-traces' ? 'events' : 'records'])) throw new Error('过程详情暂不可用。');
      for (const row of detail[request.resource === 'memory-traces' ? 'events' : 'records'] as unknown[]) document(row);
      this.publish({ detail, batches: previous, nextBefore, availability: detail.status === 'deleted' ? 'deleted' : 'recorded' });
    });
  }
  async remove(request: TraceBatchRequest): Promise<void> {
    const scope = this.requireScope(request);
    if (this.state.resource !== request.resource || !this.state.detail || batchId(request.resource, this.state.detail) !== request.batchId
      || this.state.phase !== 'ready' || this.state.availability !== 'recorded') throw new Error('请重新查看过程后再删除。');
    await this.run(scope, request.resource, 'DELETE', `${this.path(scope, request.resource)}/${request.batchId}`, true, (value) => {
      const receipt = document(value);
      if (receipt.availability !== 'deleted' || receipt.batch_id !== request.batchId) throw new Error('删除结果尚未核对。');
      this.publish({ availability: 'deleted', message: '过程记录已删除，权威记忆仍保留。' });
    });
  }
  private async run(scope: Scope, resource: TraceResource, method: 'GET' | 'DELETE', path: string, mutation: boolean, consume: (value: unknown) => void): Promise<void> {
    this.operation?.abort.abort();
    const operation = { abort: new AbortController(), mutation }; this.operation = operation;
    this.publish({ resource, phase: 'loading', message: '', ...empty() });
    const current = () => { this.synchronizeScope(); return this.scope === scope && this.operation === operation; };
    try {
      const result = await this.backend.requestJson({ method, path, signal: operation.abort.signal, maxResponseBytes: 8_388_608 });
      if (!current() || result.generation !== scope.generation) return;
      consume(result.data); this.publish({ phase: 'ready' });
    } catch (error) {
      if (current()) this.publish({ phase: 'error', ...empty(), message: mutation
        ? '删除结果尚未核对，请重新读取后确认。'
        : error instanceof BackendRequestFailure && error.status === 404 ? '当前联系人范围内没有这项记录，或记录已不可用。' : '过程读取失败，请重试。' });
    } finally { if (this.operation === operation) this.operation = undefined; }
  }
  private publish(patch: Partial<TraceState>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
