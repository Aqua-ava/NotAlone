import { randomUUID } from 'node:crypto';
import type { ContactDeletionItem, ContactDeletionRequest, ContactDeletionRetry, ContactDeletionState } from '../../shared/contact-deletion-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure, requestTimeoutLimitMs } from '../backend/json-client';
import type { ContactSession } from '../contacts/session';
import { deletionOperation, deletionOperations, deletionReceipt } from './read';
import { isUuid } from '../uuid';

type Operation = { generation: number; epoch: number };
/**
 * 确认一次后由本机后台推进：同一原任务按退避间隔自动续跑；延迟为空数组即关闭自动续跑。
 * 单次请求受运输层上限约束；清理未结束时由控制器找回原任务并轮询终态，不依赖一个长请求返回。
 */
export interface ContactDeletionOptions {
  autoRetryDelaysMs?: number[]; autoResume?: boolean; contactPollMs?: number;
  operationWaitMs?: number; operationPollMs?: number; discoverPollMs?: number; discoverTimeoutMs?: number;
}
const defaultAutoRetryDelaysMs = [1_000, 3_000, 8_000];
/** 覆盖规格要求的“不低于 10 分钟、随库增长”维护预算，并给清理与状态读取留余量；超时后保留原任务。 */
const defaultOperationWaitMs = 15 * 60_000;
const defaultOperationPollMs = 2_000;
const defaultDiscoverPollMs = 500;
/** 计划与清理进行中名单读取可能排队；发现窗口覆盖首次清理排队，读不到才保守标记未知。 */
const defaultDiscoverTimeoutMs = 90_000;
/** 请求已超时后再给一轮短暂发现，覆盖计划排队、原任务在超时后才建立或才可读的情况。 */
const recoveryDiscoverTimeoutMs = 30_000;
const discoverRequestMs = 5_000;
class ScopeMismatch extends Error {}
/** 只外露后端已分类的机器错误码，未知失败统一为结果未知。 */
function failureCode(error: unknown): string {
  return error instanceof BackendRequestFailure && typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(error.code)
    ? error.code : 'deletion_unconfirmed';
}
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
  private readonly operationWaitMs: number;
  private readonly operationPollMs: number;
  private readonly discoverPollMs: number;
  private readonly discoverTimeoutMs: number;
  private readonly listeners = new Set<(state: ContactDeletionState) => void>();
  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession,
    private readonly beginReadingScopeChange: () => (() => void) = () => () => {},
    private readonly invalidateContact: (contactId: string) => void = () => {},
    options: ContactDeletionOptions = {}) {
    this.autoRetryDelaysMs = options.autoRetryDelaysMs ?? defaultAutoRetryDelaysMs;
    this.autoResumeEnabled = options.autoResume ?? true;
    this.contactPollMs = options.contactPollMs ?? 1_500;
    this.operationWaitMs = options.operationWaitMs ?? defaultOperationWaitMs;
    this.operationPollMs = options.operationPollMs ?? defaultOperationPollMs;
    this.discoverPollMs = options.discoverPollMs ?? defaultDiscoverPollMs;
    this.discoverTimeoutMs = options.discoverTimeoutMs ?? defaultDiscoverTimeoutMs;
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
      const advance = await this.startAdvance(item, operation, pending);
      if (!advance || !this.current(operation)) return;
      const operationId = advance.operationId;
      this.replace(item.id, { operationId });
      this.resumed.add(`${operation.generation}:${operationId}`);
      // 单次运行的轮询窗口有界；续跑与到期后的状态读取共用同一截止时间，避免多层等待叠加。
      const settleDeadline = Date.now() + this.operationWaitMs;
      let confirmed: ContactDeletionItem | undefined;
      let running = false;
      if (advance.polling) {
        const polled = await this.pollOperation(item, operationId, operation, pending, settleDeadline);
        if (!polled || !this.current(operation)) return;
        confirmed = polled.confirmed; running = polled.running;
      } else {
        try {
          // 202回执不代表完成，必须读取原任务的权威终态及最终复核。
          confirmed = await this.readOperation(item, operationId, operation, pending);
        } catch (error) {
          if (error instanceof ScopeMismatch) throw error;
          if (!this.current(operation)) return;
          if (!this.transientFailure(error)) throw error;
          // 状态读取的连接中断不证明失败；原任务若仍存在，按权威状态继续核验。
          const polled = await this.pollOperation(item, operationId, operation, pending, settleDeadline);
          if (!polled || !this.current(operation)) return;
          confirmed = polled.confirmed; running = polled.running;
        }
      }
      if (!this.current(operation)) return;
      if (!confirmed) {
        // 有界窗口内始终读不到权威状态：保留原任务并保守标记结果未知，完成与否不由客户端猜测。
        this.replace(item.id, { phase: 'unconfirmed', errorCode: 'deletion_unconfirmed' });
        this.publish({ phase: 'ready', error: unknownResult });
        return;
      }
      this.confirm(item, confirmed);
      // 未到终态时只对同一原任务自动续跑，次数有限；仍未完成再交给用户明确重试。
      for (const delay of running ? [] : this.autoRetryDelaysMs) {
        if (confirmed.phase === 'completed') break;
        await pause(delay, pending.signal);
        if (!this.current(operation)) return;
        try {
          const again = await this.backend.requestJson({ method: 'POST', path: `/api/deletions/${operationId}/retry`, body: { confirmed: true },
            timeoutMs: requestTimeoutLimitMs, maxResponseBytes: 2_000_000, signal: pending.signal });
          if (!this.current(operation) || again.generation !== operation.generation) return;
          confirmed = await this.readOperation(item, operationId, operation, pending, requestTimeoutLimitMs);
          if (!this.current(operation)) return;
          this.confirm(item, confirmed);
        } catch (error) {
          if (error instanceof ScopeMismatch) throw error;
          if (!this.current(operation)) return;
          if (!this.transientFailure(error)) continue;
          // 续跑请求超时只说明回执丢失；原任务可能仍在推进，转入权威状态轮询而不是静默放弃。
          const polled = await this.pollOperation(item, operationId, operation, pending, settleDeadline);
          if (!polled || !this.current(operation)) return;
          if (polled.confirmed) {
            confirmed = polled.confirmed;
            this.confirm(item, confirmed);
          }
          if (polled.running || confirmed.phase === 'completed') break;
        }
      }
      this.publish({ phase: 'ready' });
    } catch (error) {
      if (this.current(operation)) {
        this.replace(item.id, { phase: 'unconfirmed', errorCode: failureCode(error) });
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
  /** 发出删除/续跑请求；回执丢失时只找回原任务，不重放删除。 */
  private async startAdvance(item: ContactDeletionItem, operation: Operation, pending: AbortController):
    Promise<{ operationId: string; polling: boolean } | undefined> {
    const discovery = !item.operationId && item.contactId ? this.discoverContactOperation(item.contactId, operation, pending) : undefined;
    let requestError: unknown;
    let operationId = item.operationId;
    try {
      const result = item.operationId
        ? await this.backend.requestJson({ method: 'POST', path: `/api/deletions/${item.operationId}/retry`, body: { confirmed: true },
          timeoutMs: requestTimeoutLimitMs, maxResponseBytes: 2_000_000, signal: pending.signal })
        : await this.backend.requestJson({ method: 'DELETE', path: `/api/contacts/${item.contactId}`,
          body: { confirmed: true, confirm_contact_id: item.contactId }, timeoutMs: requestTimeoutLimitMs, signal: pending.signal });
      discovery?.stop();
      if (!this.current(operation) || result.generation !== operation.generation) return undefined;
      operationId = item.operationId ?? deletionReceipt(result.data);
      return { operationId, polling: false };
    } catch (error) { requestError = error; }
    if (!this.current(operation) || pending.signal.aborted) { discovery?.stop(); return undefined; }
    // 运输层超时只说明回执可能丢失；请求发出后操作可能已提交，先按本人范围找回原任务编号，不重放删除。
    let discoveredOperationId = discovery && !this.definitiveRejection(requestError) ? await discovery.promise : undefined;
    discovery?.stop();
    if (!this.current(operation) || pending.signal.aborted) return undefined;
    // 首轮发现可能在请求返回前到期；超时后原任务才建立或才可读时再补一轮，避免把可确认的任务误判为未知。
    if (!discoveredOperationId && item.contactId && !this.definitiveRejection(requestError)) {
      const recovery = this.discoverContactOperation(item.contactId, operation, pending,
        Math.min(recoveryDiscoverTimeoutMs, this.discoverTimeoutMs));
      discoveredOperationId = await recovery.promise;
      recovery.stop();
      if (!this.current(operation) || pending.signal.aborted) return undefined;
    }
    if (discoveredOperationId) return { operationId: discoveredOperationId, polling: true };
    if (operationId && !this.definitiveRejection(requestError)) return { operationId, polling: true };
    throw requestError;
  }
  /** 与请求并行按本人范围轮询名单，找回后端已建的原任务编号；完成态不返回联系人标识，不能据此猜测。 */
  private discoverContactOperation(contactId: string, operation: Operation, pending: AbortController,
    timeoutMs = this.discoverTimeoutMs): { promise: Promise<string | undefined>; stop: () => void } {
    const controller = new AbortController();
    const abort = () => controller.abort();
    pending.signal.addEventListener('abort', abort, { once: true });
    const stop = () => { pending.signal.removeEventListener('abort', abort); controller.abort(); };
    const expected = contactId.toLowerCase();
    const promise = (async () => {
      const deadline = Date.now() + timeoutMs;
      try {
        while (this.current(operation) && !controller.signal.aborted && Date.now() < deadline) {
          try {
            const result = await this.backend.requestJson({ method: 'GET', path: '/api/deletions', signal: controller.signal,
              timeoutMs: discoverRequestMs, maxResponseBytes: 2_000_000 });
            if (!this.current(operation) || controller.signal.aborted) return undefined;
            const found = deletionOperations(result.data).find(entry => entry.phase !== 'completed'
              && entry.contactId !== null && entry.contactId.toLowerCase() === expected);
            if (found) return found.operationId ?? undefined;
          } catch { /* 清理进行中名单读取可能排队超时，有界重试。 */ }
          await pause(this.discoverPollMs, controller.signal);
        }
      } finally { pending.signal.removeEventListener('abort', abort); }
      return undefined;
    })();
    return { promise, stop };
  }
  /** 请求回执丢失/超时后，原任务由后端继续推进；有界轮询权威状态直到终态。 */
  private async pollOperation(item: ContactDeletionItem, operationId: string, operation: Operation, pending: AbortController,
    deadline: number): Promise<{ confirmed?: ContactDeletionItem; running: boolean } | undefined> {
    let confirmed: ContactDeletionItem | undefined;
    while (this.current(operation) && !pending.signal.aborted) {
      try {
        confirmed = await this.readOperation(item, operationId, operation, pending, requestTimeoutLimitMs);
        if (!this.current(operation) || pending.signal.aborted) return undefined;
        this.confirm(item, confirmed);
        // 终态和可续跑态立即交回；cleaning/verifying 代表后端仍在推进，继续有界等待。
        if (confirmed.phase === 'completed' || confirmed.phase === 'blocked' || confirmed.phase === 'fenced') {
          return { confirmed, running: false };
        }
      } catch (error) {
        if (error instanceof ScopeMismatch) throw error;
        if (!this.current(operation) || pending.signal.aborted) return undefined;
        if (!this.transientFailure(error)) throw error;
      }
      if (Date.now() >= deadline) return { confirmed, running: true };
      await pause(this.operationPollMs, pending.signal);
    }
    return undefined;
  }
  private transientFailure(error: unknown): boolean {
    return error instanceof BackendRequestFailure
      && (error.kind === 'connection' || error.status !== undefined
        && (error.status >= 500 || error.status === 409 || error.status === 429));
  }
  private definitiveRejection(error: unknown): boolean {
    return error instanceof BackendRequestFailure && error.kind === 'response' && error.status !== undefined
      && error.status >= 400 && error.status < 500 && error.status !== 409 && error.status !== 429;
  }
  private async readOperation(item: ContactDeletionItem, operationId: string, operation: Operation, pending: AbortController,
    timeoutMs?: number): Promise<ContactDeletionItem> {
    const status = await this.backend.requestJson({ method: 'GET', path: `/api/deletions/${operationId}`, signal: pending.signal,
      timeoutMs, maxResponseBytes: 2_000_000 });
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
  /** 只把权威终态回写到原任务；完成态不再保留姓名和联系人标识。 */
  private confirm(item: ContactDeletionItem, confirmed: ContactDeletionItem): void {
    this.replace(item.id, { ...confirmed, id: item.id, displayName: confirmed.phase === 'completed' ? null : item.displayName });
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
