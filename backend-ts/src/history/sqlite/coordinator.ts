import type { SavedContactBinding } from '../../contacts/sqlite/contracts.ts';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import type { SqliteHistoryService } from './service.ts';

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
interface QueuedRead { contactId: string; key: string }
interface ActiveRead extends QueuedRead { cancelledAtWake?: number; controller: AbortController; done: Promise<void> }
const allowedErrors = new Set(['history_source_continuity_unverified', 'history_support_unverified', 'history_support_unsupported', 'history_support_changed',
  'history_external_scope_changed', 'history_interrupted', 'history_page_budget_exhausted', 'history_cursor_invalid',
  'history_target_invalid', 'history_target_unverified', 'history_snapshot_closed', 'history_snapshot_unavailable',
  'history_native_timeout', 'history_native_cancelled', 'history_native_unavailable', 'history_source_changed',
  'history_schema_changed', 'history_scope_changed', 'history_message_state_unverified', 'read_not_authorized',
  'read_eligibility_stale', 'history_contact_gateway_unavailable', 'history_contact_not_found', 'history_closed',
  'history_identity_conflict', 'history_identity_insufficient', 'history_partitions_missing', 'history_incomplete',
  'message_identity_conflict', 'message_identity_insufficient', 'history_first_read_failed', 'history_first_directory_failed']);
function safeError(error: unknown): string {
  return error instanceof StorageFailure && allowedErrors.has(error.code) ? error.code : 'history_first_read_failed';
}
const bindingKey = (binding: FirstHistoryBinding) => JSON.stringify([binding.contact_id, binding.binding_id, binding.grant_id, binding.selection_generation]);
function notification() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/** 仅由启动、明确确认或开启操作唤醒；首次历史结束后不派发增量，也不轮询。 */
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
  #revision = 0;
  #pump?: Promise<void>;
  #closed = false;
  #closeDone = false;
  #closing?: Promise<void>;
  #lastError: string | null = null;
  constructor(directory: FirstHistoryDirectoryPort, history: SqliteHistoryService) { this.#directory = directory; this.#history = history; }
  wake(): void {
    if (this.#closed) return;
    ++this.#wakeSerial;
    for (const key of this.#cancelledKeys) this.#attempted.delete(key);
    this.#cancelledKeys.clear(); this.#stoppedContacts.clear();
    this.#wakePending = true; this.#notify(); this.#startPump();
  }
  getState(): FirstHistoryCoordinatorState {
    return { phase: this.#closed ? this.#closeDone ? 'closed' : 'closing' : this.#pump ? this.#active.size ? 'running' : 'scheduled' : this.#lastError ? 'blocked' : 'idle',
      lastError: this.#lastError, contacts: [...this.#states.values()].map(state => ({ ...state })) };
  }
  async waitForIdle(): Promise<void> { while (this.#pump) await this.#pump; }
  #notify(): void { this.#changed.resolve(); this.#changed = notification(); }
  #state(contactId: string, phase: FirstHistoryContactPhase, error: string | null = null): void {
    this.#states.set(contactId, { contactId, phase, lastError: error }); if (error) this.#lastError = error;
  }
  #startPump(): void {
    if (this.#pump || this.#closed) return;
    this.#attempted.clear(); this.#lastError = null;
    this.#pump = Promise.resolve().then(() => this.#drain()).catch(() => { this.#lastError = 'history_first_directory_failed'; }).finally(() => {
      this.#pump = undefined;
      if (this.#wakePending && !this.#closed) this.#startPump();
    });
  }
  async #scan(): Promise<void> {
    const revision = this.#revision;
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
      }
    }
    for (const active of [...this.#active.values()]) {
      const current = selected.get(active.contactId);
      if (!current || bindingKey(current) !== active.key) {
        await this.#cancel(active.contactId);
        // 取消会使整个扫描修订失效；无论该人是否仍选中，都须处理其余新范围。
        this.#wakePending = true;
      }
    }
    for (const binding of selected.values()) {
      if (this.#closed || revision !== this.#revision) return;
      const key = bindingKey(binding), contactId = binding.contact_id;
      if (this.#attempted.has(key) || this.#active.has(contactId) || this.#queued.has(contactId)) continue;
      try {
        const coverage = await this.#history.coverage(contactId);
        if (this.#closed || revision !== this.#revision) return;
        if (coverage.phase === 'complete') { this.#state(contactId, 'complete'); continue; }
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
      else if (coverage.phase === 'complete') this.#state(job.contactId, 'complete');
      else this.#state(job.contactId, 'incomplete', safeError(new StorageFailure(coverage.failureCode ?? 'history_incomplete')));
    }).catch(error => {
      if (active.controller.signal.aborted) this.#state(job.contactId, 'stopped');
      else this.#state(job.contactId, 'blocked', safeError(error));
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
      for (const job of [...this.#queued.values()]) { if (this.#active.size >= 2) break; this.#run(job); }
      if (this.#wakePending) continue;
      if (!this.#active.size && !this.#queued.size) break;
      await Promise.race([...this.#active.values()].map(active => active.done).concat(this.#changed.promise));
    }
  }
  async #cancel(contactId?: string): Promise<void> {
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
