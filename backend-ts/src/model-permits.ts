import { randomUUID } from 'node:crypto';
import type { ProcessIdentity } from './process-identity.ts';
/** 单一进程持有许可状态；取消与断线都不能证明已发送的供应商调用结算。 */
export type ModelWorkKind = 'foreground' | 'background';
export interface ModelPermit {
  /** 关联该整轮/后台许可与物理attempt台账，不表示一次实际发送。 */
  readonly id: string;
  /** 只在全部物理调用真正返回后调用；整轮前台跨工具轮次持有。 */
  settle(): void;
  /** 丢失执行者时保留容量，必须由宿主停止整代执行者后重建仲裁。 */
  orphan(): void;
}
export interface ModelPermitRecord { id: string; kind: ModelWorkKind; worker: ProcessIdentity; attempt_id?: string; }
interface Waiter {
  worker?: ProcessIdentity;
  attempt_id?: string;
  kind: ModelWorkKind;
  resolve: (permit: ModelPermit) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  cancel: () => void;
}
export class ModelPermitArbiter {
  private queue: Waiter[] = [];
  private active = new Map<string, { kind: ModelWorkKind; orphan: boolean; worker?: ProcessIdentity; attempt_id?: string }>();
  private journal?: {host: ProcessIdentity; record: (active: ModelPermitRecord[]) => void};
  attachJournal(journal: {host: ProcessIdentity; record: (active: ModelPermitRecord[]) => void}) {
    if (this.active.size || this.queue.length || this.journal) throw new Error('model_permit_journal_attachment_invalid');
    this.journal = journal;
  }
  private persist() {
    this.journal?.record([...this.active].map(([id, item]) => ({id,kind:item.kind,worker:item.worker ?? this.journal!.host,...item.attempt_id ? {attempt_id:item.attempt_id} : {}})));
  }
  private paused = false;
  private stopped = false;
  private drainWaiters: (() => void)[] = [];
  readonly backgroundLimit: number;
  constructor(backgroundLimit = 1) {
    this.backgroundLimit = backgroundLimit;
    if (!Number.isSafeInteger(backgroundLimit) || backgroundLimit < 1) throw new Error('model_permit_limit_invalid');
  }
  snapshot() {
    const values = [...this.active.values()];
    return {
      foregroundActive: values.some(x => x.kind === 'foreground'),
      backgroundActive: values.filter(x => x.kind === 'background').length,
      foregroundWaiting: this.queue.filter(x => x.kind === 'foreground').length,
      backgroundWaiting: this.queue.filter(x => x.kind === 'background').length,
      orphaned: values.filter(x => x.orphan).length,
      paused: this.paused, stopped: this.stopped,
    };
  }
  acquire(kind: ModelWorkKind, signal?: AbortSignal, worker?: ProcessIdentity, attempt_id?: string): Promise<ModelPermit> {
    if (kind !== 'foreground' && kind !== 'background') return Promise.reject(new Error('model_permit_kind_invalid'));
    if (this.stopped || signal?.aborted) return Promise.reject(new Error('model_work_stopped'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { kind, worker, attempt_id, resolve, reject, signal, cancel: () => {
        const index = this.queue.indexOf(waiter);
        // 已发放许可后，signal 不再有释放权。
        if (index < 0) return;
        this.queue.splice(index, 1);
        signal?.removeEventListener('abort', waiter.cancel);
        reject(new Error('model_work_stopped'));
        this.dispatch();
      } };
      signal?.addEventListener('abort', waiter.cancel, { once: true });
      this.queue.push(waiter);
      this.dispatch();
    });
  }
  pauseAndDrain(): Promise<void> {
    this.paused = true;
    return this.active.size === 0 ? Promise.resolve() : new Promise(resolve => this.drainWaiters.push(resolve));
  }
  resume(): void {
    if (this.stopped) throw new Error('model_work_stopped');
    this.paused = false;
    this.dispatch();
  }
  stop(): void {
    this.stopped = true;
    for (const waiter of this.queue.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.cancel);
      waiter.reject(new Error('model_work_stopped'));
    }
  }
  private dispatch(): void {
    if (this.stopped || this.paused || [...this.active.values()].some(x => x.orphan || x.kind === 'foreground')) return;
    const foreground = this.queue.findIndex(x => x.kind === 'foreground');
    if (foreground >= 0) {
      if (this.active.size === 0) this.grant(foreground);
      return;
    }
    while (this.queue.length && this.active.size < this.backgroundLimit) this.grant(0);
  }
  private grant(index: number): void {
    const waiter = this.queue.splice(index, 1)[0];
    waiter.signal?.removeEventListener('abort', waiter.cancel);
    const id = randomUUID();
    const state = { kind: waiter.kind, orphan: false, worker: waiter.worker, attempt_id: waiter.attempt_id };
    this.active.set(id, state);
    try { this.persist(); } catch (error) {
      this.stop();
      waiter.reject(error instanceof Error ? error : new Error('model_permit_journal_failed'));
      return;
    }
    waiter.resolve({
      id,
      settle: () => {
        if (!this.active.has(id)) return;
        this.active.delete(id);
        try { this.persist(); } catch (error) { this.active.set(id,state); this.stop(); throw error; }
        if (!this.active.size) for (const resolve of this.drainWaiters.splice(0)) resolve();
        this.dispatch();
      },
      orphan: () => { if (this.active.has(id)) state.orphan = true; },
    });
  }
}
