import { randomUUID } from 'node:crypto';
/** 单一进程持有许可状态；取消与断线都不能证明已发送的供应商调用结算。 */
export type ModelWorkKind = 'foreground' | 'background';
export interface ModelPermit {
  /** 关联该整轮/后台许可与物理attempt台账，不表示一次实际发送。 */
  readonly id: string;
  /** 只在全部物理调用真正返回后调用；整轮前台跨工具轮次持有。 */
  settle(): void;
  /** 丢失执行者时保留容量并冻结同类；必须由宿主停止整代执行者后重建仲裁。 */
  orphan(): void;
}
interface Waiter {
  kind: ModelWorkKind;
  resolve: (permit: ModelPermit) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  cancel: () => void;
}
/** 退出排空结果：计数只含固定数字，不含任何业务内容。 */
export interface ModelDrainReport { timedOut: boolean; inFlight: number; orphaned: number }
export class ModelPermitArbiter {
  private queue: Waiter[] = [];
  private active = new Map<string, { kind: ModelWorkKind; orphan: boolean }>();
  private paused = false;
  private stopped = false;
  private drainWaiters: { ignoreOrphans: boolean; resolve: () => void }[] = [];
  readonly backgroundLimit: number;
  constructor(backgroundLimit = 1) {
    this.backgroundLimit = backgroundLimit;
    if (!Number.isSafeInteger(backgroundLimit) || backgroundLimit < 1) throw new Error('model_permit_limit_invalid');
  }
  /** 仅返回已经因执行者断开成为孤儿的ID副本，不包括活跃调用。 */
  orphanedPermitIds(): string[] { return [...this.active].filter(([,value])=>value.orphan).map(([id])=>id); }
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
  acquire(kind: ModelWorkKind, signal?: AbortSignal): Promise<ModelPermit> {
    if (kind !== 'foreground' && kind !== 'background') return Promise.reject(new Error('model_permit_kind_invalid'));
    if (this.stopped || signal?.aborted) return Promise.reject(new Error('model_work_stopped'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { kind, resolve, reject, signal, cancel: () => {
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
  /**
   * 退出专用排空：只等待真正在途的调用，孤儿不再等待（进程内没有任何路径会结算孤儿，其权威记录在 SQLite 台账，
   * 下次启动仍按未知调用阻塞，退出本身即证明执行者已停止）；真实在途调用也有上限，到期返回而不是无限等待。
   * 排空期间在途调用转为孤儿会立即解除等待。
   */
  drainForExit(timeoutMs: number): Promise<ModelDrainReport> {
    this.paused = true;
    if (this.drainedFor(true)) return Promise.resolve(this.drainReport(false));
    return new Promise(resolve => {
      const waiter = { ignoreOrphans: true, resolve: () => { clearTimeout(timer); resolve(this.drainReport(false)); } };
      const timer = setTimeout(() => {
        const index = this.drainWaiters.indexOf(waiter);
        if (index >= 0) this.drainWaiters.splice(index, 1);
        resolve(this.drainReport(true));
      }, timeoutMs);
      this.drainWaiters.push(waiter);
    });
  }
  private drainedFor(ignoreOrphans: boolean): boolean {
    for (const value of this.active.values()) if (!(ignoreOrphans && value.orphan)) return false;
    return true;
  }
  private drainReport(timedOut: boolean): ModelDrainReport {
    const values = [...this.active.values()];
    return { timedOut, inFlight: values.filter(x => !x.orphan).length, orphaned: values.filter(x => x.orphan).length };
  }
  private flushDrainWaiters(): void {
    if (!this.drainWaiters.length) return;
    const ready = this.drainWaiters.filter(waiter => this.drainedFor(waiter.ignoreOrphans));
    if (!ready.length) return;
    this.drainWaiters = this.drainWaiters.filter(waiter => !ready.includes(waiter));
    for (const waiter of ready) waiter.resolve();
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
    if (this.stopped || this.paused) return;
    for (const kind of ['foreground', 'background'] as const) {
      const active = [...this.active.values()].filter(item => item.kind === kind);
      // 未知调用只冻结所属类别；前台固定一路，后台保留配置容量，互不借槽。
      if (active.some(item => item.orphan)) continue;
      const limit = kind === 'foreground' ? 1 : this.backgroundLimit;
      for (let available = limit - active.length; available > 0 && !this.stopped && !this.paused; available--) {
        const index = this.queue.findIndex(waiter => waiter.kind === kind);
        if (index < 0) break;
        this.grant(index);
      }
    }
  }
  private grant(index: number): void {
    const waiter = this.queue.splice(index, 1)[0];
    waiter.signal?.removeEventListener('abort', waiter.cancel);
    const id = randomUUID();
    const state = { kind: waiter.kind, orphan: false };
    this.active.set(id, state);
    waiter.resolve({
      id,
      settle: () => {
        if (!this.active.has(id)) return;
        this.active.delete(id);
        this.flushDrainWaiters();
        this.dispatch();
      },
      orphan: () => { if (this.active.has(id)) { state.orphan = true; this.flushDrainWaiters(); } },
    });
  }
}
