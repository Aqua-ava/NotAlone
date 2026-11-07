import type { SavedContactBinding } from '../../contacts/sqlite/contracts.ts';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import type { HistoryCoverage } from './contracts.ts';
import type { SqliteHistoryService } from './service.ts';

type IncrementalBinding = Pick<SavedContactBinding, 'contact_id' | 'binding_id' | 'grant_id' | 'selection_generation' | 'status'>;
export interface IncrementalHistoryDirectoryPort {
  directory(): Promise<{ read_enabled: boolean; bindings: readonly IncrementalBinding[] }>;
}
export type IncrementalContactPhase = 'queued' | 'running' | 'caught_up' | 'waiting_new_messages' | 'degraded' | 'blocked' | 'stopped';
export interface IncrementalHistoryCoordinatorState {
  phase: 'idle' | 'scheduled' | 'running' | 'blocked' | 'closing' | 'closed';
  lastError: string | null;
  contacts: { contactId: string; phase: IncrementalContactPhase; lastError: string | null }[];
}
interface QueuedRead { contactId: string; key: string; continuation?: true }
interface ActiveRead extends QueuedRead { controller: AbortController; done: Promise<void>; cancelledAtWake?: number }

/** 范围/身份/语义变化不可自动重试；瞬时读取故障保留可见降级并在后续 tick 重试。 */
const fatalCodes = new Set(['history_source_continuity_unverified', 'history_support_unverified', 'history_support_unsupported', 'history_support_changed',
  'history_external_scope_changed', 'history_cursor_invalid', 'history_cursor_scope_changed', 'history_suppression_unverified',
  'history_suppression_changed', 'history_incremental_unavailable', 'history_incremental_not_ready', 'history_tail_unsupported',
  'history_tail_baseline_too_large',
  'history_target_unverified', 'history_target_invalid', 'history_scope_invalid', 'history_account_changed', 'history_source_changed',
  'history_scope_changed', 'read_not_authorized', 'read_eligibility_stale', 'history_contact_not_found', 'history_goal_closed',
  'history_goal_stale', 'history_page_invalid', 'history_capture_replay_conflict', 'history_deletion_in_progress']);
const transientCodes = new Set(['history_native_unavailable','history_source_unverified', 'history_native_timeout', 'history_native_cancelled',
  'history_interrupted', 'history_incremental_interrupted', 'history_closed', 'history_already_running',
  'history_page_budget_exhausted', 'history_first_read_failed', 'history_snapshot_closed', 'history_snapshot_unavailable',
  'history_snapshot_window_changed',
  'history_schema_changed', 'history_message_state_unverified', 'history_source_lifecycle_unverified',
  'history_snapshot_runtime_proof_required', 'history_partition_coverage_runtime_proof_required', 'history_contact_gateway_unavailable', 'history_incomplete']);
/** 只向界面投影已分类的可见错误码；未登记的内部失败统一收敛，避免泄露存储细节。 */
const visibleCodes = new Set([...fatalCodes, ...transientCodes]);
const emptyTargetProbeIntervalMs=300_000;
function safeError(error: unknown): string {
  if (error instanceof StorageFailure && /^[a-z][a-z0-9_]{0,79}$/.test(error.code) && visibleCodes.has(error.code)) return error.code;
  return 'history_incremental_failed';
}
const bindingKey = (binding: IncrementalBinding) => JSON.stringify([binding.contact_id, binding.binding_id, binding.grant_id, binding.selection_generation]);
const canContinueIncremental=(coverage:HistoryCoverage)=>coverage.phase==='complete'||Boolean(coverage.traversalComplete&&coverage.incremental?.cursorPresent&&['ready','incomplete'].includes(coverage.incremental.phase));
const replacedCheckpointErrors=new Set(['history_snapshot_replaced','history_runtime_revalidated']);
function notification() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/**
 * 增量读取协调器：仅由启动/开启/重选唤醒并定时运行；总开关关闭、退出、取消或范围变化时停止后续查询并取消在途。
 * 只读取已保存资格允许的联系人；历史未完成时先补齐历史，完整后才从持久检查点续读增量。
 * 单个联系人的失败只影响该人；范围失效显示可见错误并停止自动重试，等下一次明确唤醒。
 */
export class IncrementalHistoryCoordinator {
  readonly #directory: IncrementalHistoryDirectoryPort;
  readonly #history: SqliteHistoryService;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #firstHistoryManagedExternally: boolean;
  readonly #queued = new Map<string, QueuedRead>();
  readonly #active = new Map<string, ActiveRead>();
  readonly #attempted = new Map<string, string>();
  readonly #emptyProbeAt = new Map<string, { key: string; timestamp: number }>();
  readonly #stoppedContacts = new Set<string>();
  readonly #states = new Map<string, IncrementalHistoryCoordinatorState['contacts'][number]>();
  #wakeSerial = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #changed = notification();
  #wakePending = false;
  #revision = 0;
  #pump?: Promise<void>;
  #closed = false;
  #closeDone = false;
  #closing?: Promise<void>;
  #lastError: string | null = null;
  constructor(directory: IncrementalHistoryDirectoryPort, history: SqliteHistoryService, options: { intervalMs?: number; firstHistoryManagedExternally?: boolean; now?: () => number } = {}) {
    this.#directory = directory; this.#history = history; this.#intervalMs = options.intervalMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    this.#firstHistoryManagedExternally = options.firstHistoryManagedExternally ?? false;
  }
  /** 宿主在发布就绪后调用；定时只触发一次有界扫描，不改变持久资格。 */
  start(): void {
    if (this.#closed || this.#intervalMs <= 0 || this.#timer) return;
    this.#timer = setInterval(() => {
      if (this.#closed || this.#pump) return;
      this.#wakePending = true; this.#startPump();
    }, this.#intervalMs);
    this.#timer.unref?.();
  }
  /** 明确唤醒：清除既有阻塞/停读标记，重试所有仍选中且资格有效的联系人。 */
  wake(): void {
    if (this.#closed) return;
    ++this.#wakeSerial;
    this.#attempted.clear(); this.#emptyProbeAt.clear(); this.#stoppedContacts.clear();
    this.#lastError = null; this.#wakePending = true; this.#notify(); this.#startPump();
  }
  getState(): IncrementalHistoryCoordinatorState {
    const anyBlocked = [...this.#states.values()].some(state => state.phase === 'blocked');
    return {
      phase: this.#closed ? this.#closeDone ? 'closed' : 'closing' : this.#pump ? this.#active.size ? 'running' : 'scheduled' : anyBlocked ? 'blocked' : 'idle',
      // 全局错误只汇总残留的逐人/目录/停止失败；恢复成功后不再报告旧错误。
      lastError: this.#lastError ?? [...this.#states.values()].find(state => state.lastError !== null)?.lastError ?? null,
      contacts: [...this.#states.values()].map(state => ({ ...state })),
    };
  }
  async waitForIdle(): Promise<void> { while (this.#pump) await this.#pump; }
  #notify(): void { this.#changed.resolve(); this.#changed = notification(); }
  #state(contactId: string, phase: IncrementalContactPhase, error: string | null = null): void {
    // 逐人错误只留在联系人条目，避免恢复成功后全局残留旧失败。
    this.#states.set(contactId, { contactId, phase, lastError: error });
  }
  #startPump(): void {
    if (this.#pump || this.#closed) return;
    this.#pump = Promise.resolve().then(() => this.#drain()).catch(() => { this.#lastError = 'history_incremental_directory_failed'; }).finally(() => {
      this.#pump = undefined;
      if (this.#wakePending && !this.#closed) this.#startPump();
    });
  }
  async #scan(): Promise<void> {
    const revision = this.#revision;
    let directory: Awaited<ReturnType<IncrementalHistoryDirectoryPort['directory']>>;
    try { directory = await this.#directory.directory(); }
    catch { this.#lastError = 'history_incremental_directory_failed'; await this.#cancel(); return; }
    if (this.#lastError === 'history_incremental_directory_failed') this.#lastError = null;
    if (this.#closed || revision !== this.#revision) return;
    if (typeof directory.read_enabled !== 'boolean' || !Array.isArray(directory.bindings)) { this.#lastError = 'history_incremental_directory_failed'; await this.#cancel(); return; }
    // 总开关关闭时不再发起任何渠道查询，并取消所有在途读取。
    if (!directory.read_enabled) { await this.#cancel(); return; }
    const selected = new Map<string, IncrementalBinding>();
    for (const binding of directory.bindings) {
      if (binding.status !== 'active' || this.#stoppedContacts.has(binding.contact_id)) continue;
      if (selected.has(binding.contact_id)) { this.#lastError = 'history_incremental_directory_failed'; await this.#cancel(); return; }
      selected.set(binding.contact_id, binding);
    }
    for (const [contactId, queued] of this.#queued) {
      const current = selected.get(contactId);
      if (!current || bindingKey(current) !== queued.key) { this.#queued.delete(contactId); this.#state(contactId, 'stopped'); }
    }
    for (const active of [...this.#active.values()]) {
      const current = selected.get(active.contactId);
      if (!current || bindingKey(current) !== active.key) {
        await this.#cancel(active.contactId);
        this.#wakePending = true;
      }
    }
    for (const binding of selected.values()) {
      if (this.#closed || revision !== this.#revision) return;
      const key = bindingKey(binding), contactId = binding.contact_id;
      const attemptedKey=this.#attempted.get(contactId);
      if(attemptedKey!==undefined&&attemptedKey!==key){this.#attempted.delete(contactId);this.#emptyProbeAt.delete(contactId);}
      if(attemptedKey===key){
        const deadline=this.#emptyProbeAt.get(contactId);
        if(deadline?.key===key){
          if(this.#now()<deadline.timestamp)continue;
          this.#emptyProbeAt.delete(contactId);this.#attempted.delete(contactId);
        }else if(this.#states.get(contactId)?.phase==='blocked'&&replacedCheckpointErrors.has(this.#states.get(contactId)?.lastError??'')){
          // 新历史接续完成后绑定身份不变；以当前持久检查点解除旧快照的调度阻塞，不复用旧游标。
          let coverage:HistoryCoverage;
          try{coverage=await this.#history.coverage(contactId);}catch{continue;}
          if(!coverage.traversalComplete||!coverage.incremental?.cursorPresent||!['ready','incomplete'].includes(coverage.incremental.phase)){
            // 守卫后来失效时，旧增量阻塞也须让当前合法恢复资格接回首次读取。
            if(this.#firstHistoryManagedExternally)try{await this.#history.requestFirstHistoryRecovery?.(contactId);}
            catch{/* 本轮资格查询失败保留替换阻塞，下轮仍须重新经过持久资格门。 */}
            continue;
          }
          this.#attempted.delete(contactId);
        }else if(this.#states.get(contactId)?.phase==='blocked'&&this.#states.get(contactId)?.lastError==='history_incremental_unavailable'){
          // 只读本机持久覆盖，接住启动时旧empty目标先被看见、随后FirstHistory完成新证明的竞态。
          // 未出现明确证明时不触碰渠道，也不清除阻断。
          let coverage:HistoryCoverage;
          try{coverage=await this.#history.coverage(contactId);}catch{continue;}
          if(coverage.incremental?.emptyTargetAwaitingMessages!==true)continue;
          this.#attempted.delete(contactId);
        }else continue;
      }
      if (this.#active.has(contactId) || this.#queued.has(contactId)) continue;
      this.#queued.set(contactId, { contactId, key }); this.#state(contactId, 'queued');
    }
  }
  #run(job: QueuedRead): void {
    this.#queued.delete(job.contactId); this.#state(job.contactId, 'running');
    const active: ActiveRead = { ...job, controller: new AbortController(), done: Promise.resolve() };
    let previousIncremental: HistoryCoverage['incremental'];
    this.#active.set(job.contactId, active);
    let certifiedEmptyProbe=false;
    active.done = (async () => {
      let coverage = await this.#history.coverage(job.contactId);
      if (!canContinueIncremental(coverage)) {
        // 正式宿主有独立 FirstHistoryCoordinator；不能与它并发启动同一联系人的首次历史。
        if (this.#firstHistoryManagedExternally) {
          await this.#history.requestFirstHistoryRecovery?.(job.contactId);
          throw new StorageFailure('history_incomplete');
        }
        coverage = await this.#history.synchronize(job.contactId, active.controller.signal);
        if (!canContinueIncremental(coverage)) throw new StorageFailure(coverage.failureCode ?? 'history_incomplete');
      }
      // 交接不可证明（终页没有保守续读游标）时保持可见不可用，不发起渠道读取。
      if (coverage.incremental?.phase === 'unavailable') {
        if(coverage.incremental.emptyTargetAwaitingMessages===true)certifiedEmptyProbe=true;
        else throw new StorageFailure(coverage.incremental.failureCode ?? 'history_incremental_unavailable');
      }
      previousIncremental = coverage.incremental;
      return await this.#history.synchronizeIncremental(job.contactId, active.controller.signal);
    })().then((coverage: HistoryCoverage) => {
      if (active.controller.signal.aborted) { this.#state(job.contactId, 'stopped'); return; }
      const incremental = coverage.incremental;
      if(incremental?.phase==='unavailable'&&incremental.emptyTargetAwaitingMessages===true){
        this.#attempted.set(job.contactId,job.key);
        this.#emptyProbeAt.set(job.contactId,{key:job.key,timestamp:this.#now()+emptyTargetProbeIntervalMs});
        this.#state(job.contactId,'waiting_new_messages');return;
      }
      if (incremental?.phase === 'unavailable' || incremental?.phase === 'invalidated') {
        const code = incremental.failureCode ?? 'history_incremental_unavailable';
        this.#attempted.set(job.contactId, job.key); this.#state(job.contactId, 'blocked', code); return;
      }
      if (incremental?.phase === 'incomplete') {
        // 存储只接受未完成且游标推进的页；已接受页数增加证明本轮有进展。
        // 预算接续优先于尚未打开的会话，防止固定读者等待整个目录后空闲过期。
        const acceptedBefore = previousIncremental?.goalId === incremental.goalId ? previousIncremental?.pagesAccepted ?? 0 : 0;
        if (!this.#closed && incremental.failureCode === 'history_page_budget_exhausted' && incremental.cursorPresent
          && incremental.goalId && incremental.pagesAccepted > acceptedBefore) {
          this.#queued.set(job.contactId, { ...job, continuation: true });
          this.#state(job.contactId, 'queued'); return;
        }
        // 无进展或其他可恢复中断保持可见降级，由后续 tick 重试。
        this.#state(job.contactId, 'degraded', incremental.failureCode ?? 'history_incomplete'); return;
      }
      this.#attempted.delete(job.contactId); this.#state(job.contactId, 'caught_up');
    }).catch((error: unknown) => {
      if (active.controller.signal.aborted) { this.#state(job.contactId, 'stopped'); return; }
      const code = safeError(error);
      if (transientCodes.has(code)) {
        if(certifiedEmptyProbe){this.#attempted.set(job.contactId,job.key);this.#emptyProbeAt.set(job.contactId,{key:job.key,timestamp:this.#now()+emptyTargetProbeIntervalMs});}
        this.#state(job.contactId, 'degraded', code); return;
      }
      // 未分类与范围失效都保守停止自动重试，保留可见错误，等待下一次明确唤醒。
      this.#attempted.set(job.contactId, job.key); this.#state(job.contactId, 'blocked', code);
      if(certifiedEmptyProbe)this.#emptyProbeAt.set(job.contactId,{key:job.key,timestamp:this.#now()+emptyTargetProbeIntervalMs});
    }).finally(() => {
      this.#active.delete(job.contactId);
      if (!this.#closed && active.cancelledAtWake !== undefined && this.#wakeSerial > active.cancelledAtWake) this.#wakePending = true;
      this.#notify();
    });
  }
  async #drain(): Promise<void> {
    while (!this.#closed) {
      if (this.#wakePending) { this.#wakePending = false; await this.#scan(); }
      if (this.#closed) break;
      const queued = [...this.#queued.values()].sort((a, b) => Number(b.continuation === true) - Number(a.continuation === true));
      for (const job of queued) { if (this.#active.size >= 2) break; this.#run(job); }
      if (this.#wakePending) continue;
      if (!this.#active.size && !this.#queued.size) break;
      await Promise.race([...this.#active.values()].map(active => active.done).concat(this.#changed.promise));
    }
  }
  async #cancel(contactId?: string): Promise<void> {
    ++this.#revision;
    for (const queued of [...this.#queued.values()]) if (!contactId || queued.contactId === contactId) {
      this.#attempted.set(queued.contactId, queued.key); this.#queued.delete(queued.contactId); this.#state(queued.contactId, 'stopped');
    }
    const active = [...this.#active.values()].filter(entry => !contactId || entry.contactId === contactId);
    for (const entry of active) { this.#attempted.set(entry.contactId, entry.key); entry.cancelledAtWake = this.#wakeSerial; entry.controller.abort(); }
    this.#notify();
    await this.#history.stop(contactId); await Promise.all(active.map(entry => entry.done));
  }
  async stop(contactId?: string): Promise<void> {
    // 关闭流程也必须能取消在途读取：close() 先置 #closed，再调用本方法排空。
    if (this.#closeDone) return;
    if (contactId) { this.#stoppedContacts.add(contactId); this.#emptyProbeAt.delete(contactId); this.#state(contactId, 'stopped'); }
    else { this.#wakePending = false; this.#emptyProbeAt.clear(); }
    try { await this.#cancel(contactId); }
    catch { this.#lastError = 'history_incremental_stop_failed'; throw new StorageFailure('history_incremental_stop_failed'); }
    finally {
      if (contactId && this.#pump && !this.#closed) { this.#wakePending = true; this.#notify(); }
    }
  }
  close(): Promise<void> {
    this.#closed = true; this.#wakePending = false;
    if (this.#timer) { clearInterval(this.#timer); this.#timer = undefined; }
    return this.#closing ??= (async () => {
      await this.stop(); await this.waitForIdle(); this.#closeDone = true;
    })().catch(error => { this.#closing = undefined; throw error; });
  }
}
