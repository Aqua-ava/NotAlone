import { randomUUID } from 'node:crypto';
import type { ContactDeletionItem, ContactDeletionRequest, ContactDeletionRetry, ContactDeletionState } from '../../shared/contact-deletion-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { deletionOperation, deletionOperations, deletionReceipt } from './read';
import { isUuid } from '../uuid';

type Operation = { generation: number; epoch: number };
/** 确认一次后由本机后台推进：同一原任务按退避间隔自动续跑；延迟为空数组即关闭自动续跑。 */
export interface ContactDeletionOptions { autoRetryDelaysMs?: number[]; autoResume?: boolean; contactPollMs?: number }
const defaultAutoRetryDelaysMs = [1_000, 3_000, 8_000];
const longRequestMs = 300_000;
class ScopeMismatch extends Error {}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (ms <= 0 || signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
const unknownResult = '删除结果尚未确认。请刷新状态或重试原删除操作，未确认完成前不会显示已删除。';

// 删除任务按当前本人连接跟踪，不依赖已被删除的联系人仍在目录中。
export class ContactDeletionController {
  private state: ContactDeletionState = { revision: 0, scopeRevision: 0, phase: 'offline', operations: [], busyId: null, error: null };
  private generation: number | undefined;
  private ownerId: string | undefined;
  private previousScope: { ownerId: string; operations: ContactDeletionItem[] } | undefined;
  private epoch = 0;
  private pending: AbortController | undefined;
  private disposed = false;
  private readonly resumed = new Set<string>();
  private readonly autoRetryDelaysMs: number[];
  private readonly autoResumeEnabled: boolean;
  private readonly contactPollMs: number;
  private readonly listeners = new Set<(state: ContactDeletionState) => void>();
  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession,
    private readonly beginReadingScopeChange: () => (() => void) = () => () => {},
    private readonly invalidateContact: (contactId: string) => void = () => {},
    options: ContactDeletionOptions = {}) {
    this.autoRetryDelaysMs = options.autoRetryDelaysMs ?? defaultAutoRetryDelaysMs;
    this.autoResumeEnabled = options.autoResume ?? true;
    this.contactPollMs = options.contactPollMs ?? 1_500;
    backend.onStateChanged(() => this.synchronize());
    this.synchronize();
  }
  getState(): ContactDeletionState { return structuredClone(this.state); }
  onStateChanged(listener: (state: ContactDeletionState) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  dispose(): void { this.disposed = true; this.cancel(); this.listeners.clear(); }
  private synchronize(): boolean {
    const generation = this.backend.getConnectionGeneration();
    if (this.disposed || generation === this.generation) return false;
    if (this.ownerId) this.previousScope = { ownerId: this.ownerId, operations: this.state.operations.map(item => item.phase === 'requesting'
      ? { ...item, phase: 'unconfirmed', errorCode: 'deletion_unconfirmed' } : item) };
    this.ownerId = undefined;
    this.cancel(); this.generation = generation;
    this.publish({ phase: generation === undefined ? 'offline' : 'loading', scopeRevision: this.state.scopeRevision + 1,
      operations: [], busyId: null, error: null });
    if (generation !== undefined) void this.refresh();
    return true;
  }
  async refresh(): Promise<void> {
    if (this.synchronize()) return;
    if (this.disposed || this.generation === undefined || this.state.busyId) return;
    this.cancel();
    const operation = { generation: this.generation, epoch: this.epoch };
    const pending = new AbortController(); this.pending = pending;
    this.publish({ phase: 'loading', error: null });
    try {
      if (!this.ownerId) {
        const identity = await this.backend.requestJson({ method: 'GET', path: '/api/setup/status', signal: pending.signal, maxResponseBytes: 4096 });
        if (!this.current(operation) || identity.generation !== operation.generation) return;
        const owner = identity.data as { runtime_owner_configured?: unknown; owner_id?: unknown } | null;
        if (!owner || owner.runtime_owner_configured !== true || !isUuid(owner.owner_id)) throw new Error('本人删除范围尚未核验。');
        this.ownerId = owner.owner_id.toLowerCase();
        if (this.previousScope?.ownerId === this.ownerId) this.publish({ operations: this.previousScope.operations });
        this.previousScope = undefined;
      }
      const result = await this.backend.requestJson({ method: 'GET', path: '/api/deletions', signal: pending.signal, maxResponseBytes: 2_000_000 });
      if (!this.current(operation) || result.generation !== operation.generation) return;
      const previous = this.state.operations;
      const found = new Set<string>();
      const items = deletionOperations(result.data).flatMap(item => {
        const old = previous.find(entry => entry.operationId === item.operationId
          || entry.operationId === null && entry.contactId !== null && entry.contactId === item.contactId);
        if (item.phase === 'completed' && !old) return [];
        if (old) found.add(old.id);
        return [{ ...item, id: old?.id ?? item.id, displayName: item.phase === 'completed' ? null : old?.displayName ?? null }];
      });
      // 名单缺项不能证明删除完成，响应丢失的原意图保留至明确核验或重试。
      for (const old of previous) if (!found.has(old.id) && !items.some(item => item.id === old.id)) items.push(old);
      this.publish({ phase: 'ready', operations: items, error: null });
      this.autoResume();
    } catch {
      if (this.current(operation)) this.publish({ phase: 'failed', error: '删除任务状态暂时无法读取，请刷新重试。' });
    } finally { if (this.pending === pending) this.pending = undefined; }
  }
  async delete(request: ContactDeletionRequest): Promise<void> {
    this.synchronize();
    const directory = this.contacts.getState();
    const contact = directory.contacts.find(item => item.contactId === request.contactId);
    if (request.confirmed !== true || this.disposed || this.generation === undefined || !this.ownerId || this.state.busyId
      || !['ready', 'loading'].includes(directory.directoryPhase) || directory.selectedContactId !== request.contactId
      || directory.scopeRevision !== request.scopeRevision || !contact
      || this.state.operations.some(item => item.contactId === request.contactId && item.phase !== 'completed')) {
      throw new Error('联系人已变化，请重新选择并确认删除。');
    }
    const item: ContactDeletionItem = { id: randomUUID(), operationId: null, contactId: contact.contactId,
      displayName: contact.displayName, phase: 'requesting', errorCode: null };
    this.publish({ operations: [...this.state.operations.filter(entry => entry.phase !== 'completed'), item] });
    await this.run(item);
  }
  async retry(request: ContactDeletionRetry): Promise<void> {
    this.synchronize();
    const item = this.state.operations.find(entry => entry.id === request.id);
    if (request.confirmed !== true || this.disposed || this.generation === undefined || !this.ownerId || this.state.busyId
      || request.scopeRevision !== this.state.scopeRevision || !item || item.phase === 'completed' || item.phase === 'requesting'
      || !item.operationId && !item.contactId) throw new Error('删除任务已变化，请刷新后重新确认。');
    await this.run(item);
  }
  private async run(item: ContactDeletionItem): Promise<void> {
    this.cancel();
    const operation = { generation: this.generation!, epoch: this.epoch };
    const pending = new AbortController(); this.pending = pending;
    if (item.operationId) this.resumed.add(`${operation.generation}:${item.operationId}`);
    let finish = () => {};
    let stopPolling = () => {};
    this.publish({ phase: 'ready', busyId: item.id, error: null });
    try {
      finish = this.beginReadingScopeChange();
      if (item.contactId) this.invalidateContact(item.contactId);
      // 原请求要等清理结束才返回；期间轮询名单，让后端封禁后的联系人尽早离开列表。
      if (!item.operationId && item.contactId) stopPolling = this.pollContacts(operation);
      const result = item.operationId
        ? await this.backend.requestJson({ method: 'POST', path: `/api/deletions/${item.operationId}/retry`, body: { confirmed: true },
          timeoutMs: longRequestMs, maxResponseBytes: 2_000_000, signal: pending.signal })
        : await this.backend.requestJson({ method: 'DELETE', path: `/api/contacts/${item.contactId}`,
          body: { confirmed: true, confirm_contact_id: item.contactId }, timeoutMs: longRequestMs, signal: pending.signal });
      stopPolling();
      if (!this.current(operation) || result.generation !== operation.generation) return;
      const operationId = item.operationId ?? deletionReceipt(result.data);
      // 202回执不代表完成，必须读取原任务的权威终态及最终复核。
      this.replace(item.id, { operationId });
      this.resumed.add(`${operation.generation}:${operationId}`);
      let confirmed = await this.readOperation(item, operationId, operation, pending);
      if (!this.current(operation)) return;
      this.replace(item.id, { ...confirmed, id: item.id, displayName: confirmed.phase === 'completed' ? null : item.displayName });
      // 未到终态时只对同一原任务自动续跑，次数有限；仍未完成再交给用户明确重试。
      for (const delay of this.autoRetryDelaysMs) {
        if (confirmed.phase === 'completed') break;
        await pause(delay, pending.signal);
        if (!this.current(operation)) return;
        try {
          const again = await this.backend.requestJson({ method: 'POST', path: `/api/deletions/${operationId}/retry`, body: { confirmed: true },
            timeoutMs: longRequestMs, maxResponseBytes: 2_000_000, signal: pending.signal });
          if (!this.current(operation) || again.generation !== operation.generation) return;
          confirmed = await this.readOperation(item, operationId, operation, pending);
          if (!this.current(operation)) return;
          this.replace(item.id, { ...confirmed, id: item.id, displayName: confirmed.phase === 'completed' ? null : item.displayName });
        } catch (error) {
          if (error instanceof ScopeMismatch) throw error;
          if (!this.current(operation)) return;
        }
      }
      this.publish({ phase: 'ready' });
    } catch {
      if (this.current(operation)) {
        this.replace(item.id, { phase: 'unconfirmed', errorCode: 'deletion_unconfirmed' });
        this.publish({ phase: 'ready', error: unknownResult });
      }
    } finally {
      stopPolling();
      try { finish(); }
      finally {
        if (this.current(operation)) {
          // 范围封禁后联系人可先离开目录，但任务仍由本控制器保留并核验。
          try { await this.contacts.refreshContacts(); }
          finally { if (this.current(operation)) this.publish({ busyId: null }); }
        }
        if (this.pending === pending) this.pending = undefined;
      }
    }
    if (this.current(operation)) this.autoResume();
  }
  private async readOperation(item: ContactDeletionItem, operationId: string, operation: Operation, pending: AbortController): Promise<ContactDeletionItem> {
    const status = await this.backend.requestJson({ method: 'GET', path: `/api/deletions/${operationId}`, signal: pending.signal, maxResponseBytes: 2_000_000 });
    if (!this.current(operation) || status.generation !== operation.generation) throw new Error('删除任务已变化。');
    const confirmed = deletionOperation(status.data);
    if (confirmed.operationId !== operationId || confirmed.phase !== 'completed' && item.contactId !== null && confirmed.contactId !== item.contactId) {
      // 不把不属于原对象的回执变成下一次重试的删除权限。
      this.replace(item.id, { operationId: null });
      throw new ScopeMismatch('删除任务范围不一致。');
    }
    return confirmed;
  }
  /** 只续跑已有任务编号的未完成任务；未取得回执的删除意图和换本人后的任务不在此列。每个连接内每个任务只自动续跑一次。 */
  private autoResume(): void {
    if (!this.autoResumeEnabled || this.disposed || this.generation === undefined || !this.ownerId || this.state.busyId || this.state.phase !== 'ready') return;
    const item = this.state.operations.find(entry => entry.operationId !== null && ['fenced', 'cleaning', 'verifying', 'blocked'].includes(entry.phase)
      && !this.resumed.has(`${this.generation}:${entry.operationId}`));
    if (!item) return;
    this.resumed.add(`${this.generation}:${item.operationId}`);
    void this.run(item);
  }
  private pollContacts(operation: Operation): () => void {
    if (this.contactPollMs <= 0) return () => {};
    let running = false;
    const timer = setInterval(() => {
      if (running || !this.current(operation)) return;
      running = true;
      void Promise.resolve(this.contacts.refreshContacts()).catch(() => {}).finally(() => { running = false; });
    }, this.contactPollMs);
    return () => clearInterval(timer);
  }
  private replace(id: string, patch: Partial<ContactDeletionItem>): void {
    this.publish({ operations: this.state.operations.map(item => item.id === id ? { ...item, ...patch } : item) });
  }
  private current(operation: Operation): boolean {
    return !this.disposed && operation.generation === this.backend.getConnectionGeneration() && operation.epoch === this.epoch;
  }
  private cancel(): void { ++this.epoch; this.pending?.abort(); this.pending = undefined; }
  private publish(update: Partial<ContactDeletionState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
