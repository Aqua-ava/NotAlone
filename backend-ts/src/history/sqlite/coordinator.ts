import type { SavedContactBinding } from '../../contacts/sqlite/contracts.ts';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import { resumableHistorySlice,type SqliteHistoryService } from './service.ts';

type FirstHistoryBinding = Pick<SavedContactBinding, 'contact_id' | 'binding_id' | 'grant_id' | 'selection_generation' | 'status'>;
export interface FirstHistoryDirectoryPort {
  directory(): Promise<{ read_enabled: boolean; bindings: readonly FirstHistoryBinding[] }>;
}
export type FirstHistoryContactPhase = 'queued' | 'running' | 'complete' | 'incomplete' | 'blocked' | 'stopped';
export interface FirstHistoryCoordinatorState {
  phase: 'idle' | 'scheduled' | 'running' | 'blocked' | 'closing' | 'closed';
  lastError: string | null;
  contacts: { contactId: string; phase: FirstHistoryContactPhase; lastError: string | null }[];
}
interface QueuedRead { contactId: string; key: string; continuationCursor?: string; resumableSlice?:boolean }
interface ActiveRead extends QueuedRead { cancelledAtWake?: number; controller: AbortController; done: Promise<void> }
const allowedErrors = new Set(['history_source_continuity_unverified', 'history_support_unverified', 'history_support_unsupported', 'history_support_changed',
  'history_snapshot_window_changed',
  'history_external_scope_changed', 'history_interrupted', 'history_page_budget_exhausted', 'history_cursor_invalid',
  'history_target_invalid', 'history_target_unverified', 'history_snapshot_closed', 'history_snapshot_unavailable',
  'history_native_timeout', 'history_native_cancelled', 'history_native_unavailable', 'history_source_changed',
  'history_schema_changed', 'history_scope_changed', 'history_message_state_unverified', 'history_source_lifecycle_unverified',
  'history_snapshot_runtime_proof_required', 'history_partition_coverage_runtime_proof_required', 'read_not_authorized',
  'read_eligibility_stale', 'history_contact_gateway_unavailable', 'history_contact_not_found', 'history_closed',
  'history_identity_conflict', 'history_identity_insufficient', 'history_identity_quarantined', 'history_partitions_missing', 'history_incomplete',
  'message_identity_conflict', 'message_identity_insufficient', 'history_first_read_failed', 'history_first_directory_failed']);
function safeError(error: unknown): string {
  return error instanceof StorageFailure && allowedErrors.has(error.code) ? error.code : 'history_first_read_failed';
}
const bindingKey = (binding: FirstHistoryBinding) => JSON.stringify([binding.contact_id, binding.binding_id, binding.grant_id, binding.selection_generation]);
function keyContact(key:string):string|null {
 try{const value=JSON.parse(key);return Array.isArray(value)&&typeof value[0]==='string'?value[0]:null;}catch{return null;}
}
function notification() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const retryableErrors=new Set(['history_native_timeout','history_native_unavailable','history_native_cancelled',
  'history_snapshot_closed','history_snapshot_unavailable','history_snapshot_window_changed']);

/** 启动、确认或开启发起首次历史；瞬时失败退避重试，完成后不轮询历史。 */
export class FirstHistoryCoordinator {
  readonly #directory: FirstHistoryDirectoryPort;
  readonly #history: SqliteHistoryService;
  readonly #queued = new Map<string, QueuedRead>();
  readonly #active = new Map<string, ActiveRead>();
  readonly #attempted = new Set<string>();
  readonly #cancelledKeys = new Set<string>();
  readonly #stoppedContacts = new Set<string>();
  #wakeSerial = 0;
  readonly #states = new Map<string, FirstHistoryCoordinatorState['contacts'][number]>();
  #changed = notification();
  #wakePending = false;
  #wakeAllPending = false;
  readonly #contactWakes = new Set<string>();
  #resetAttemptsOnStart = false;
  #revision = 0;
  #pump?: Promise<void>;
  #closed = false;
  #closeDone = false;
  #closing?: Promise<void>;
  #lastError: string | null = null;
  readonly #retryTimers=new Map<string,{timer:ReturnType<typeof setTimeout>;key:string}>();
  readonly #retryAttempts=new Map<string,number>();
  readonly #retryMinMs:number;readonly #retryMaxMs:number;
  constructor(directory: FirstHistoryDirectoryPort, history: SqliteHistoryService,options:{retryMinMs?:number;retryMaxMs?:number}={}) {
    this.#directory = directory; this.#history = history;
    this.#retryMinMs=options.retryMinMs??1000;this.#retryMaxMs=options.retryMaxMs??60_000;
    if(!Number.isSafeInteger(this.#retryMinMs)||this.#retryMinMs<1||!Number.isSafeInteger(this.#retryMaxMs)
      ||this.#retryMaxMs<this.#retryMinMs||this.#retryMaxMs>60_000)throw new StorageFailure('history_request_invalid');
  }
  #clearRetry(contactId?:string):void {
    for(const [id,entry] of this.#retryTimers)if(!contactId||id===contactId){clearTimeout(entry.timer);this.#retryTimers.delete(id);}
    if(contactId)this.#retryAttempts.delete(contactId);else this.#retryAttempts.clear();
  }
  #retry(job:QueuedRead,code:string):boolean {
    if(!retryableErrors.has(code)||this.#closed||this.#stoppedContacts.has(job.contactId))return false;
    const attempt=(this.#retryAttempts.get(job.contactId)??0)+1;this.#retryAttempts.set(job.contactId,attempt);
    const previous=this.#retryTimers.get(job.contactId);if(previous)clearTimeout(previous.timer);
    const delay=Math.min(this.#retryMaxMs,this.#retryMinMs*2**Math.min(attempt-1,16));
    const entry={key:job.key,timer:setTimeout(()=>{
      if(this.#retryTimers.get(job.contactId)!==entry)return;this.#retryTimers.delete(job.contactId);
      if(this.#closed||this.#stoppedContacts.has(job.contactId))return;
      // 每次重探重新读取目录与授权；不复活其他已停止联系人或旧原生游标。
      this.#attempted.delete(job.key);this.#contactWakes.add(job.contactId);this.#wakePending=true;this.#notify();this.#startPump();
    },delay)};
    entry.timer.unref();this.#retryTimers.set(job.contactId,entry);return true;
  }
  wake(): void {
    if (this.#closed) return;
    this.#clearRetry();
    ++this.#wakeSerial;
    for (const key of this.#cancelledKeys) this.#attempted.delete(key);
    this.#cancelledKeys.clear(); this.#stoppedContacts.clear();
    this.#resetAttemptsOnStart = true;
    this.#wakeAllPending = true;
    this.#wakePending = true; this.#notify(); this.#startPump();
  }
  /** 新增的delta历史仅重试指定联系人，不重试其他失败/已停止联系人。 */
  wakeContact(contactId:string):void {
    if(this.#closed||typeof contactId!=='string'||!contactId)return;
    this.#clearRetry(contactId);
    for(const key of this.#attempted)if(keyContact(key)===contactId)this.#attempted.delete(key);
    for(const key of this.#cancelledKeys)if(keyContact(key)===contactId){this.#cancelledKeys.delete(key);this.#attempted.delete(key);}
    this.#stoppedContacts.delete(contactId);++this.#wakeSerial;
    this.#contactWakes.add(contactId);
    this.#wakePending=true;this.#notify();this.#startPump();
  }
  getState(): FirstHistoryCoordinatorState {
    return { phase: this.#closed ? this.#closeDone ? 'closed' : 'closing' : this.#pump ? this.#active.size ? 'running' : 'scheduled' : this.#retryTimers.size?'scheduled':this.#lastError ? 'blocked' : 'idle',
      lastError: this.#lastError, contacts: [...this.#states.values()].map(state => ({ ...state })) };
  }
  async waitForIdle(): Promise<void> { while (this.#pump) await this.#pump; }
  #notify(): void { this.#changed.resolve(); this.#changed = notification(); }
  #state(contactId: string, phase: FirstHistoryContactPhase, error: string | null = null): void {
    const previous=this.#states.get(contactId)?.lastError;
    this.#states.set(contactId, { contactId, phase, lastError: error }); if (error) this.#lastError = error;
    else if(previous===this.#lastError)this.#lastError=[...this.#states.values()].find(state=>state.lastError!==null)?.lastError??null;
  }
  #startPump(): void {
    if (this.#pump || this.#closed) return;
    if(this.#resetAttemptsOnStart){this.#attempted.clear();this.#lastError=null;this.#resetAttemptsOnStart=false;}
    this.#pump = Promise.resolve().then(() => this.#drain()).catch(() => { this.#lastError = 'history_first_directory_failed'; }).finally(() => {
      this.#pump = undefined;
      if (this.#wakePending && !this.#closed) this.#startPump();
    });
  }
  async #scan(): Promise<void> {
    const revision = this.#revision;
    // 定点唤醒只限制覆盖查询；仍核对全部排队和在途读取的当前授权。
    const focused = this.#wakeAllPending || !this.#contactWakes.size ? undefined : new Set(this.#contactWakes);
    this.#wakeAllPending = false;this.#contactWakes.clear();
    let directory: Awaited<ReturnType<FirstHistoryDirectoryPort['directory']>>;
    try { directory = await this.#directory.directory(); }
    catch { this.#lastError = 'history_first_directory_failed'; await this.#cancel(); return; }
    if (this.#closed || revision !== this.#revision) return;
    if (typeof directory.read_enabled !== 'boolean' || !Array.isArray(directory.bindings)) { this.#lastError = 'history_first_directory_failed'; await this.#cancel(); return; }
    if (!directory.read_enabled) { await this.#cancel(); return; }
    const selected = new Map<string, FirstHistoryBinding>();
    for (const binding of directory.bindings) {
      if (binding.status !== 'active' || this.#stoppedContacts.has(binding.contact_id)) continue;
      if (selected.has(binding.contact_id)) { this.#lastError = 'history_first_directory_failed'; await this.#cancel(); return; }
      selected.set(binding.contact_id, binding);
    }
    for (const [contactId, queued] of this.#queued) {
      const current = selected.get(contactId);
      if (!current || bindingKey(current) !== queued.key) {
        this.#queued.delete(contactId); this.#state(contactId, 'stopped');
        if (current) focused?.add(contactId);
      }
    }
    for (const active of [...this.#active.values()]) {
      const current = selected.get(active.contactId);
      if (!current || bindingKey(current) !== active.key) {
        await this.#cancel(active.contactId);
        // 取消会使整个扫描修订失效；无论该人是否仍选中，都须处理其余新范围。
        this.#wakeAllPending = true;this.#wakePending = true;
      }
    }
    for (const binding of selected.values()) {
      if (this.#closed || revision !== this.#revision) return;
      const key = bindingKey(binding), contactId = binding.contact_id;
      if (focused && !focused.has(contactId)) continue;
      if (this.#attempted.has(key) || this.#active.has(contactId) || this.#queued.has(contactId)) continue;
      try {
        const coverage = await this.#history.coverage(contactId);
        if (this.#closed || revision !== this.#revision) return;
        if (coverage.phase === 'complete') { this.#state(contactId, 'complete'); continue; }
        if(coverage.traversalComplete&&coverage.incremental?.cursorPresent&&['ready','incomplete'].includes(coverage.incremental.phase)){
          this.#attempted.add(key);this.#state(contactId,'incomplete',coverage.failureCode??'history_incomplete');continue;
        }
        this.#queued.set(contactId, { contactId, key }); this.#state(contactId, 'queued');
      } catch (error) { this.#attempted.add(key); this.#state(contactId, 'blocked', safeError(error)); }
    }
  }
  #run(job: QueuedRead): void {
    this.#queued.delete(job.contactId); this.#attempted.add(job.key); this.#state(job.contactId, 'running');
    const active: ActiveRead = { ...job, controller: new AbortController(), done: Promise.resolve() };
    this.#active.set(job.contactId, active);
    active.done = Promise.resolve().then(() => this.#history.synchronize(job.contactId, active.controller.signal)).then(coverage => {
      if (active.controller.signal.aborted) this.#state(job.contactId, 'stopped');
      else if (coverage.phase === 'complete') {this.#clearRetry(job.contactId);this.#state(job.contactId, 'complete');}
      else if (!this.#closed && !coverage.traversalComplete && typeof coverage.cursor === 'string'
        && coverage.cursor.length > 0 && coverage.cursor !== job.continuationCursor) {
        // 持久片段进入队尾；旧读取器的进程内快照仍优先接续，避免等待时过期。
        this.#queued.set(job.contactId, { ...job, continuationCursor: coverage.cursor, resumableSlice:coverage[resumableHistorySlice]===true });
        this.#state(job.contactId, 'queued');
      }
      else {const code=safeError(new StorageFailure(coverage.failureCode??'history_incomplete'));this.#retry(job,code);this.#state(job.contactId,'incomplete',code);}
    }).catch(error => {
      if (active.controller.signal.aborted) this.#state(job.contactId, 'stopped');
      else {const code=safeError(error);this.#state(job.contactId,this.#retry(job,code)?'incomplete':'blocked',code);}
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
      const queued = [...this.#queued.values()].sort((a, b) => Number(b.continuationCursor !== undefined&&!b.resumableSlice) - Number(a.continuationCursor !== undefined&&!a.resumableSlice));
      for (const job of queued) { if (this.#active.size >= 2) break; this.#run(job); }
      if (this.#wakePending) continue;
      if (!this.#active.size && !this.#queued.size) break;
      await Promise.race([...this.#active.values()].map(active => active.done).concat(this.#changed.promise));
    }
  }
  async #cancel(contactId?: string): Promise<void> {
    this.#clearRetry(contactId);
    ++this.#revision;
    for (const queued of [...this.#queued.values()]) if (!contactId || queued.contactId === contactId) {
      this.#attempted.add(queued.key); this.#cancelledKeys.add(queued.key); this.#queued.delete(queued.contactId); this.#state(queued.contactId, 'stopped');
    }
    const active = [...this.#active.values()].filter(active => !contactId || active.contactId === contactId);
    for (const entry of active) { this.#attempted.add(entry.key); this.#cancelledKeys.add(entry.key); entry.cancelledAtWake = this.#wakeSerial; entry.controller.abort(); }
    this.#notify();
    await this.#history.stop(contactId); await Promise.all(active.map(entry => entry.done));
  }
  async stop(contactId?: string): Promise<void> {
    if (contactId) { this.#stoppedContacts.add(contactId); this.#state(contactId, 'stopped'); }
    else this.#wakePending = false;
    try { await this.#cancel(contactId); }
    catch { this.#lastError = 'history_first_stop_failed'; throw new StorageFailure('history_first_stop_failed'); }
    finally {
      // 单人停读使在途扫描失效；重扫其余范围，内部唤醒不解除该人的停读。
      if (contactId && this.#pump && !this.#closed) { this.#wakePending = true; this.#notify(); }
    }
  }
  close(): Promise<void> {
    this.#closed = true; this.#wakePending = false;
    return this.#closing ??= (async () => {
      await this.stop(); await this.waitForIdle(); this.#closeDone = true;
    })().catch(error => { this.#closing = undefined; throw error; });
  }
}
