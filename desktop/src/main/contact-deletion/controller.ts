import { randomUUID } from 'node:crypto';
import type { ContactDeletionItem, ContactDeletionRequest, ContactDeletionRetry, ContactDeletionState } from '../../shared/contact-deletion-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure, requestTimeoutLimitMs } from '../backend/json-client';
import type { ContactSession } from '../contacts/session';
import { ContactDeletionQuiet } from '../contacts/deletion-quiet';
import { deletionOperation, deletionOperations, deletionReceipt } from './read';
import { StateStore } from '../state-store';
import { isUuid } from '../uuid';

type Operation = { generation: number; epoch: number };
/**
 * 确认一次后由本机后台推进：同一原任务按退避间隔自动续跑；延迟为空数组即关闭自动续跑。
 * 单次请求受运输层上限约束；清理未结束时由控制器找回原任务并轮询终态，不依赖一个长请求返回。
 */
export interface ContactDeletionOptions {
  autoRetryDelaysMs?: number[]; autoResume?: boolean; contactPollMs?: number;
  operationWaitMs?: number; operationPollMs?: number; discoverPollMs?: number; discoverTimeoutMs?: number;
  /** 本地未知回执（未取得任务编号）时确认后端已无可推进删除的有界探针间隔。 */
  settleProbeDelaysMs?: number[]; /** 删除窗口兜底上限：超时强制结束窗口并补读一次。 */
  quietMaxMs?: number;
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
/** 回执丢失且名单暂时读不到原任务时，按有界间隔确认后端是否仍有未完成删除；用尽后强制恢复无关读取。 */
const defaultSettleProbeDelaysMs = [2_000, 5_000, 10_000, 20_000, 30_000];
/** 窗口兜底：即使本地状态一直无法确认，也不能无限期保留删除窗口。 */
const defaultQuietMaxMs = 10 * 60_000;
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
export class ContactDeletionController extends StateStore<ContactDeletionState> {
  private generation: number | undefined;
  private ownerId: string | undefined;
  private previousScope: { ownerId: string; operations: ContactDeletionItem[] } | undefined;
  private epoch = 0;
  private pending: AbortController | undefined;
  private disposed = false;
  private quietWindow: (() => void) | undefined;
  private quietMaxTimer: ReturnType<typeof setTimeout> | undefined;
  private settleProbeTimer: ReturnType<typeof setTimeout> | undefined;
  /** 有界探针尚未给出结论时窗口保持；与 quietProbe（重连探针）共用“读取完成前不提前恢复”的语义。 */
  private settleProbeHolding = false;
  private settleProbeAttempt = 0;
  /** 重连时打开的窗口要等新连接的删除状态读取给出结论，不能只凭旧连接状态结束。 */
  private quietProbe = false;
  private readonly resumed = new Set<string>();
  private readonly autoRetryDelaysMs: number[];
  private readonly autoResumeEnabled: boolean;
  private readonly contactPollMs: number;
  private readonly operationWaitMs: number;
  private readonly operationPollMs: number;
  private readonly discoverPollMs: number;
  private readonly discoverTimeoutMs: number;
  private readonly settleProbeDelaysMs: number[];
  private readonly quietMaxMs: number;
  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession,
    private readonly beginReadingScopeChange: () => (() => void) = () => () => {},
    private readonly invalidateContact: (contactId: string) => void = () => {},
    private readonly quiet: ContactDeletionQuiet = new ContactDeletionQuiet(),
    options: ContactDeletionOptions = {}) {
    super({ revision: 0, scopeRevision: 0, phase: 'offline', operations: [], busyId: null, error: null });
    this.autoRetryDelaysMs = options.autoRetryDelaysMs ?? defaultAutoRetryDelaysMs;
    this.autoResumeEnabled = options.autoResume ?? true;
    this.contactPollMs = options.contactPollMs ?? 1_500;
    this.operationWaitMs = options.operationWaitMs ?? defaultOperationWaitMs;
    this.operationPollMs = options.operationPollMs ?? defaultOperationPollMs;
    this.discoverPollMs = options.discoverPollMs ?? defaultDiscoverPollMs;
    this.discoverTimeoutMs = options.discoverTimeoutMs ?? defaultDiscoverTimeoutMs;
    this.settleProbeDelaysMs = options.settleProbeDelaysMs ?? defaultSettleProbeDelaysMs;
    this.quietMaxMs = options.quietMaxMs ?? defaultQuietMaxMs;
    backend.onStateChanged(() => this.synchronize());
    this.synchronize();
  }
  override getState(): ContactDeletionState { return structuredClone(this.state); }
  dispose(): void { this.disposed = true; this.cancel(); this.endQuietWindow(); this.clearListeners(); }
  /**
   * 后端只要还有未完成的联系人删除就整体关闭名单服务，因此窗口覆盖整个未完成期间，而不只是单次请求。
   * 删除被重试、续跑或重连打断时继续保留窗口；全部完成、确认没有未完成任务或兜底超时后才恢复无关读取。
   */
  private beginQuietWindow(): void {
    if (this.quietWindow) return;
    this.quietWindow = this.quiet.begin();
    this.armQuietMax();
  }
  private endQuietWindow(): void {
    this.cancelQuietMax();
    this.cancelSettleProbe();
    const finish = this.quietWindow;
    this.quietWindow = undefined;
    finish?.();
  }
  /** 窗口兜底：超过 quietMaxMs 仍无法确认删除结束时强制恢复无关读取并在结束时补读一次。 */
  private armQuietMax(): void {
    this.cancelQuietMax();
    if (this.quietMaxMs <= 0) return;
    this.quietMaxTimer = setTimeout(() => {
      this.quietMaxTimer = undefined;
      this.forceEndQuietWindow();
    }, this.quietMaxMs);
    this.quietMaxTimer.unref?.();
  }
  private cancelQuietMax(): void {
    clearTimeout(this.quietMaxTimer); this.quietMaxTimer = undefined;
  }
  private forceEndQuietWindow(): void {
    this.quietProbe = false;
    this.cancelSettleProbe();
    this.cancelQuietMax();
    this.endQuietWindow();
  }
  private endQuietWindowIfSettled(): void {
    // 重连探针或有界结算探针尚未给出结论时不能提前恢复读取，否则读取仍会撞上关闭的名单服务。
    if (this.quietProbe || this.settleProbeHolding) return;
    // 已知任务编号且未完成：后端仍在删除，继续保持窗口，由运行、重试、自动续跑或兜底超时结束。
    if (this.state.operations.some(item => item.operationId !== null && item.phase !== 'completed')) return;
    // 本地未知回执（回执丢失/未取得编号）不能证明后端仍在删除：有界探针确认无未完成任务后结束。
    if (this.state.operations.some(item => item.operationId === null && item.phase !== 'completed')) {
      if (this.quietWindow) this.scheduleSettleProbe();
      return;
    }
    this.endQuietWindow();
  }
  /**
   * 本地未知回执的有界结算探针：按 settleProbeDelaysMs 定时读取权威删除列表。
   * 读取成功且没有未完成任务编号后结束窗口并补读；读取失败保持窗口继续下一档；用尽后强制结束。
   */
  private scheduleSettleProbe(): void {
    if (this.disposed || this.settleProbeHolding || this.settleProbeDelaysMs.length === 0) return;
    this.settleProbeHolding = true;
    this.settleProbeAttempt = 0;
    this.armSettleProbe();
  }
  private armSettleProbe(): void {
    if (this.disposed || !this.settleProbeHolding) return;
    if (this.settleProbeAttempt >= this.settleProbeDelaysMs.length) { this.forceEndQuietWindow(); return; }
    const delay = this.settleProbeDelaysMs[this.settleProbeAttempt++];
    this.settleProbeTimer = setTimeout(() => {
      this.settleProbeTimer = undefined;
      void this.probeSettledBackend();
    }, delay);
    this.settleProbeTimer.unref?.();
  }
  private cancelSettleProbe(): void {
    this.settleProbeHolding = false;
    this.settleProbeAttempt = 0;
    clearTimeout(this.settleProbeTimer);
    this.settleProbeTimer = undefined;
  }
  private async probeSettledBackend(): Promise<void> {
    const generation = this.generation;
    if (this.disposed || !this.settleProbeHolding || generation === undefined) {
      this.cancelSettleProbe();
      return;
    }
    if (generation !== this.generation || generation !== this.backend.getConnectionGeneration()) {
      this.cancelSettleProbe();
      return;
    }
    // 状态读取允许，不重放删除；刷新成功后由 refresh 按权威列表结束或保持窗口。
    const settled = await this.refresh();
    if (this.disposed || !this.settleProbeHolding) return;
    if (generation !== this.generation || generation !== this.backend.getConnectionGeneration()) {
      this.cancelSettleProbe();
      return;
    }
    if (!this.quiet.deleting) { this.cancelSettleProbe(); return; }
    if (!settled) { this.armSettleProbe(); return; }
    // 权威读取成功：列表里已没有可推进的任务编号，窗口可以结束并补读；已知未完成则由运行/重试继续。
    const knownUnfinished = this.state.operations.some(item => item.operationId !== null && item.phase !== 'completed');
    this.settleProbeHolding = false;
    if (knownUnfinished) { this.endQuietWindowIfSettled(); return; }
    this.endQuietWindow();
  }
  private synchronize(): boolean {
    const generation = this.backend.getConnectionGeneration();
    if (this.disposed || generation === this.generation) return false;
    if (this.ownerId) this.previousScope = { ownerId: this.ownerId, operations: this.state.operations.map(item => item.phase === 'requesting'
      ? { ...item, phase: 'unconfirmed', errorCode: 'deletion_unconfirmed' } : item) };
    this.ownerId = undefined;
    this.cancel(); this.generation = generation;
    // 重连时先保留窗口，等新连接的删除状态读取完成后再决定是否恢复无关读取。
    this.quietProbe = generation !== undefined;
    // 旧的本地结算探针结论随连接代次作废；窗口若延续由新连接的权威读取重新判定。
    this.cancelSettleProbe();
    if (generation !== undefined) this.beginQuietWindow(); else this.endQuietWindow();
    this.publish({ phase: generation === undefined ? 'offline' : 'loading', scopeRevision: this.state.scopeRevision + 1,
      operations: [], busyId: null, error: null });
    if (generation !== undefined) void this.refresh();
    return true;
  }
  async refresh(): Promise<boolean> {
    if (this.synchronize()) return false;
    if (this.disposed || this.generation === undefined || this.state.busyId) return false;
    this.cancel();
    const operation = { generation: this.generation, epoch: this.epoch };
    const pending = new AbortController(); this.pending = pending;
    this.publish({ phase: 'loading', error: null });
    try {
      if (!this.ownerId) {
        const identity = await this.backend.requestJson({ method: 'GET', path: '/api/setup/status', signal: pending.signal, maxResponseBytes: 4096 });
        if (!this.current(operation) || identity.generation !== operation.generation) return false;
        const owner = identity.data as { runtime_owner_configured?: unknown; owner_id?: unknown } | null;
        if (!owner || owner.runtime_owner_configured !== true || !isUuid(owner.owner_id)) throw new Error('本人删除范围尚未核验。');
        this.ownerId = owner.owner_id.toLowerCase();
        if (this.previousScope?.ownerId === this.ownerId) this.publish({ operations: this.previousScope.operations });
        this.previousScope = undefined;
      }
      const result = await this.backend.requestJson({ method: 'GET', path: '/api/deletions', signal: pending.signal, maxResponseBytes: 2_000_000 });
      if (!this.current(operation) || result.generation !== operation.generation) return false;
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
      this.quietProbe = false;
      const unfinished = items.filter(item => item.phase !== 'completed');
      if (unfinished.some(item => item.operationId !== null)) {
        // 权威列表里仍有可继续推进的任务编号：后端仍在删除，继续保持窗口。
        this.cancelSettleProbe();
        this.beginQuietWindow();
      } else if (unfinished.some(item => item.operationId === null) && this.quietWindow) {
        // 本地未知回执：即使本次列表为空，也不能排除旧连接在途请求尚未建立任务；保持窗口等有界探针二次确认。
        this.scheduleSettleProbe();
      } else {
        // 权威列表已读到且没有未完成任务：本地未知回执不再需要保持窗口，结束并补读。
        this.cancelSettleProbe();
        this.endQuietWindow();
      }
      this.autoResume();
      return true;
    } catch {
      if (this.current(operation)) {
        this.publish({ phase: 'failed', error: '删除任务状态暂时无法读取，请刷新重试。' });
        // 重连探针失败不长期暂停无关读取；已知未完成任务或本地未知回执由窗口生命周期与有界探针收敛。
        if (this.quietProbe) { this.quietProbe = false; this.endQuietWindowIfSettled(); }
      }
      return false;
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
    // 名单服务在删除期间整体关闭：读取方仍尝试读取，失败保留旧状态，窗口结束时补读一次。
    // 本次运行接管窗口生命周期，旧的本地未知探针与重连探针结论由本任务完成后统一给出。
    this.cancelSettleProbe();
    this.quietProbe = false;
    this.beginQuietWindow();
    const operation = { generation: this.generation!, epoch: this.epoch };
    const pending = new AbortController(); this.pending = pending;
    if (item.operationId) this.resumed.add(`${operation.generation}:${item.operationId}`);
    let finish = () => {};
    let stopPolling = () => {};
    try {
      this.publish({ phase: 'ready', busyId: item.id, error: null });
      finish = this.beginReadingScopeChange();
      if (item.contactId) {
        this.invalidateContact(item.contactId);
        // 删除请求发出即撤下该联系人，不等名单服务恢复；其他联系人的选择与草稿保持不变。
        this.contacts.removeContact(item.contactId);
      }
      // 原请求要等清理结束才返回；期间只做保留式后台刷新，名单服务关闭时不清空界面。
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
      try {
        if (this.current(operation)) {
          // 范围封禁后联系人已先从内存撤下；收尾对账用保留式后台刷新，失败也不清空目录。
          try { await this.contacts.refreshContactsInBackground(); }
          finally { if (this.current(operation)) this.publish({ busyId: null }); }
        }
      } finally {
        try { finish(); }
        finally {
          if (this.pending === pending) this.pending = undefined;
          // 已知未完成任务继续保留窗口；本地未知回执转入有界结算探针；确认无未完成任务后结束并补读。
          this.endQuietWindowIfSettled();
        }
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
      // 名单服务在删除期间关闭：只做失败保留现有目录的后台刷新，不进入错误态。
      void Promise.resolve(this.contacts.refreshContactsInBackground()).catch(() => {}).finally(() => { running = false; });
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
}
