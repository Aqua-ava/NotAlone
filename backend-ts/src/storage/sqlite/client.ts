import { Worker } from 'node:worker_threads';
import { sqliteOpenTimeoutMs } from './timeouts.ts';
import { StorageFailure, type OpenStorageOptions, type StorageLease, type StorageStatus } from './contracts.ts';
export type { OpenStorageOptions, StorageStatus, StorageLease } from './contracts.ts';

export interface StorageFailureDiagnostic {
  cause: 'action_timeout' | 'worker_error' | 'worker_exit' | 'post_message_failed';
  action?: string;
  pendingCount: number;
  queuedCount: number;
}

export class SqliteStorage {
  readonly status: StorageStatus;
  private nextId = 0;
  private failed = false;
  private closing?: Promise<void>;
  private diagnostic: Readonly<StorageFailureDiagnostic> | null = null;
  private readonly pending = new Map<number, { name: string; started: boolean; resolve: (value: any) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();
  private readonly worker: Worker;
  get failureDiagnostic(): Readonly<StorageFailureDiagnostic> | null { return this.diagnostic; }
  private constructor(worker: Worker, status: StorageStatus) {
    this.worker = worker;
    this.status = Object.freeze(status);
    worker.on('message', message => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.started === true) {
        if (!pending.started) {
          pending.started = true;
          pending.timer = setTimeout(() => { this.fail('action_timeout', pending.name); void this.worker.terminate(); }, 15_000);
        }
        return;
      }
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.code) pending.reject(new StorageFailure(message.code)); else pending.resolve(message.value);
    });
    worker.on('error', () => this.fail('worker_error'));
    worker.on('exit', () => this.fail('worker_exit'));
  }
  static async open(options: OpenStorageOptions): Promise<SqliteStorage> {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {workerData: options, execArgv: ['--experimental-strip-types']});
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void worker.terminate(); reject(new StorageFailure('storage_timeout')); }, sqliteOpenTimeoutMs);
      const fail = () => { clearTimeout(timer); reject(new StorageFailure('worker_failed')); };
      worker.once('error', fail); worker.once('exit', fail);
      worker.once('message', message => {
        clearTimeout(timer); worker.off('error', fail); worker.off('exit', fail);
        if (message.code) { void worker.terminate(); reject(new StorageFailure(message.code)); }
        else resolve(new SqliteStorage(worker, message.value));
      });
    });
  }
  execute<T = unknown>(name: string, input: unknown, lease: StorageLease = this.status): Promise<T> {
    if (this.failed || this.closing) return Promise.reject(new StorageFailure('worker_failed'));
    return this.request(name, input, lease);
  }
  check(): Promise<{ integrity: 'ok'; foreignKeys: 'ok' }> { return this.execute('storage.check', {}); }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      try { if (!this.failed) await this.request('storage.close', {}, this.status); }
      finally { this.fail(); await this.worker.terminate(); }
    })();
  }
  private request<T>(name: string, input: unknown, lease: StorageLease): Promise<T> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {name, started: false, resolve, reject});
      try { this.worker.postMessage({id, name, input, lease}); }
      catch { this.fail('post_message_failed', name); }
    });
  }
  private fail(cause?: StorageFailureDiagnostic['cause'], action?: string): void {
    if (this.failed) return;
    if (cause) {
      const current = action ?? [...this.pending.values()].find(pending => pending.started)?.name;
      this.diagnostic = Object.freeze({cause, ...(typeof current === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(current) ? {action: current} : {}),
        pendingCount: this.pending.size, queuedCount: [...this.pending.values()].filter(pending => !pending.started).length});
    }
    this.failed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new StorageFailure('worker_failed')); }
    this.pending.clear();
  }
}
