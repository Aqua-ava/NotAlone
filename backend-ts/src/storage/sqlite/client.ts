import { Worker } from 'node:worker_threads';
import {currentDiagnosticTrace,diagnose,newTraceId} from '../../diagnostics/context.ts';
import {publishStorageDiagnostics} from '../../diagnostics/storage-events.ts';
import {statSync} from 'node:fs';
import { sqliteActionTimeoutMs, sqliteMaintenanceTimeoutMs, sqliteOpenTimeoutMs } from './timeouts.ts';
import {controlledFiles} from './files.ts';
import {SqliteReadonlyReader} from './readonly-client.ts';
import { StorageFailure, type OpenStorageOptions, type StorageLease, type StorageStatus, type StorageReader } from './contracts.ts';
export type { OpenStorageOptions, StorageStatus, StorageLease } from './contracts.ts';
export type {StorageReader} from './contracts.ts';

export interface StorageFailureDiagnostic {
  cause: 'action_timeout' | 'worker_error' | 'worker_exit' | 'post_message_failed';
  action?: string;
  pendingCount: number;
  queuedCount: number;
}

export interface StorageActionTiming {
  action: string;
  queuedMs: number;
  executionMs: number;
  totalMs: number;
  ok: boolean;
}
const monotonicMs=()=>Number(process.hrtime.bigint())/1e6;
const milliseconds=(value:number)=>Math.round(Math.max(0,value)*1000)/1000;
/**
 * 前台回复链路的动作：与后台提取、同步共用唯一写者线程，但优先出队。
 * 白名单只含回复、助手讨论、运行副本、Skill 核验、只读分组范围与手动确认；分组管理写入和未知动作走后台通道。
 */
const foregroundAction=/^(?:reply|discussion|runtime|skills)\.|^(?:identity\.manualConfirm|skillGroups\.scope)$/;
const actionName=(value:string)=>/^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]{0,95}$/.test(value)&&value.length<=128?value:'invalid_action';

export class SqliteStorage {
  readonly status: StorageStatus;
  private nextId = 0;
  private failed = false;
  private closing?: Promise<void>;
  private diagnostic: Readonly<StorageFailureDiagnostic> | null = null;
  private writeGeneration = 0;
  private readonly pending = new Map<number, { name: string; input: unknown; lease: StorageLease; traceId:string; started: boolean; mutates?: boolean; enqueuedAt:number; startedAt?:number; resolve: (value: any) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();
  // 一次只放一个动作进入 Worker，其余在此按通道排队：前台动作最多等待当前正在执行的那一个。
  private readonly foregroundQueue:number[]=[];
  private readonly backgroundQueue:number[]=[];
  private inFlight:number|undefined;
  private readonly timings:(StorageActionTiming&{finishedAt:number})[]=[];
  private readonly worker: Worker;
  private readonly readers=new Set<SqliteReadonlyReader>();
  private readonly files:ReturnType<typeof controlledFiles>;
  private readonly options:OpenStorageOptions;
  get failureDiagnostic(): Readonly<StorageFailureDiagnostic> | null { return this.diagnostic; }
  /**
   * 库内容代次：本连接打开以来开始执行过的可写动作数。动作在唯一 Worker 内串行，只读动作以 query_only 执行，
   * 所以两次取到相同代次时，其间库内容未变。有可写动作或尚未确认模式的动作在途、或存储已失效时返回 undefined。
   */
  get quiescentWriteGeneration(): number | undefined {
    if (this.failed || this.closing) return undefined;
    const active = this.inFlight === undefined ? undefined : this.pending.get(this.inFlight);
    if (active && (!active.started || active.mutates !== false)) return undefined;
    return this.writeGeneration;
  }
  get timingDiagnostic(): {pendingCount:number;queuedCount:number;active:{action:string;executionMs:number}|null;recent:StorageActionTiming[]} {
    const now=monotonicMs(),pending=[...this.pending.values()],active=pending.find(row=>row.started);
    // 只保留动作名称与时间；既不收集输入，也不扩大状态接口的运输预算。
    return {pendingCount:pending.length,queuedCount:pending.filter(row=>!row.started).length,
      active:active?{action:actionName(active.name),executionMs:milliseconds(now-(active.startedAt??now))}:null,
      recent:this.timings.filter(row=>now-row.finishedAt<=60_000).sort((a,b)=>b.totalMs-a.totalMs).slice(0,3)
        .map(({finishedAt:_,...row})=>({...row}))};
  }
  private constructor(worker: Worker, status: StorageStatus,options:OpenStorageOptions) {
    this.worker = worker;
    this.options=options;
    this.status = Object.freeze(status);
    this.files=controlledFiles(options.userData,false);
    worker.on('message', message => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.started === true) {
        if (!pending.started) {
          pending.started = true;
          pending.startedAt=message.startedAt;
          pending.mutates = message.mutates !== false;
          if (pending.mutates) this.writeGeneration++;
          pending.timer = setTimeout(() => { this.fail('action_timeout', pending.name); void this.worker.terminate(); },
            message.maintenance === true ? this.maintenanceBudget() : (this.options.actionTimeoutMs ?? sqliteActionTimeoutMs));
        }
        return;
      }
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if(this.inFlight===message.id){
        this.inFlight=undefined;
        // 延到本轮微任务之后再出队，让刚完成动作的调用方先入队其紧随的下一次前台请求。
        setImmediate(()=>this.pump());
      }
      if(typeof message.startedAt==='number'&&typeof message.finishedAt==='number'){
        this.timings.push({action:actionName(pending.name),queuedMs:milliseconds(message.startedAt-pending.enqueuedAt),
          executionMs:milliseconds(message.finishedAt-message.startedAt),totalMs:milliseconds(message.finishedAt-pending.enqueuedAt),
          ok:!message.code,finishedAt:message.finishedAt});
        if(this.timings.length>64)this.timings.shift();
      }
      publishStorageDiagnostics(message.diagnostics,pending.traceId,{observedAt:message.diagnosticObservedAt,observedNs:message.diagnosticObservedMonotonicNs});
      if (message.code) pending.reject(new StorageFailure(message.code)); else pending.resolve(message.value);
    });
    worker.on('error', () => this.fail('worker_error'));
    worker.on('exit', () => this.fail('worker_exit'));
  }
  static async open(options: OpenStorageOptions): Promise<SqliteStorage> {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {workerData: options, execArgv: ['--experimental-strip-types']});
    const status=await new Promise<StorageStatus>((resolve, reject) => {
      const timer = setTimeout(() => { void worker.terminate(); reject(new StorageFailure('storage_timeout')); }, sqliteOpenTimeoutMs);
      const fail = () => { clearTimeout(timer); reject(new StorageFailure('worker_failed')); };
      worker.once('error', fail); worker.once('exit', fail);
      worker.once('message', message => {
        clearTimeout(timer); worker.off('error', fail); worker.off('exit', fail);
        if (message.code) { void worker.terminate(); reject(new StorageFailure(message.code)); }
        else resolve(message.value);
      });
    }).catch(async error=>{await worker.terminate();throw error;});
    try{return new SqliteStorage(worker,status,{...options});}catch(error){await worker.terminate();throw error;}
  }
  /** 维护动作预算：按动作开始时的库与 WAL 体积估算；读取失败时退回固定下限，不影响动作本身。 */
  private maintenanceBudget(): number {
    if (this.options.maintenanceTimeoutMs !== undefined) return this.options.maintenanceTimeoutMs;
    let bytes = 0;
    for (const suffix of ['', '-wal']) { try { bytes += statSync(this.files.database + suffix).size; } catch { /* 缺失的旁路文件不计入。 */ } }
    return sqliteMaintenanceTimeoutMs(bytes);
  }
  execute<T = unknown>(name: string, input: unknown, lease: StorageLease = this.status): Promise<T> {
    if (this.failed || this.closing) return Promise.reject(new StorageFailure('worker_failed'));
    return this.request(name, input, lease);
  }
  /** 持久runner先完成专用日志清理，再在宿主协调两进程统一日志；Worker不持有第二写者。 */
  async eraseDiagnostics(input:{ownerId:string;operationId:string;token:string;planRevision:bigint}):Promise<void>{
    const scope=await this.execute<{kind:'contact'|'account';contactPrefixes:string[]}>('storage.eraseContinuityDiagnostics',input);
    const {eraseDiagnosticRecords}=await import('../../diagnostics/unified-log.mjs');
    if(!await eraseDiagnosticRecords(this.options.userData,scope))throw new StorageFailure('diagnostic_cleanup_unavailable');
  }
  check(): Promise<{ integrity: 'ok'; foreignKeys: 'ok' }> { return this.execute('storage.check', {}); }
  /** 运行状态只核验当前句柄及文件身份；不排队查询或重复全库完整性检查。 */
  verifyIdentity():void {
    if(this.failed||this.closing)throw new StorageFailure('worker_failed');
    this.files.verify();
  }
  async openReader(actions:readonly string[]):Promise<StorageReader>{
    if(this.failed||this.closing)throw new StorageFailure('worker_failed');
    this.files.verify();const identity=statSync(this.files.database);
    const reader=new SqliteReadonlyReader({userData:this.options.userData,registryModule:this.options.registryModule,status:this.status,actions:[...actions],fileIdentity:{dev:identity.dev,ino:identity.ino}},()=>{this.readers.delete(reader);});
    this.readers.add(reader);
    try{await reader.ready;if(this.failed||this.closing)throw new StorageFailure('worker_failed');return reader;}
    catch(error){await reader.close();throw error;}
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      await Promise.all([...this.readers].map(reader=>reader.close()));
      try { if (!this.failed) await this.request('storage.close', {}, this.status); }
      finally { this.fail(); await this.worker.terminate(); }
    })();
  }
  private request<T>(name: string, input: unknown, lease: StorageLease): Promise<T> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {name, input, lease, traceId:currentDiagnosticTrace()??newTraceId(), started: false, enqueuedAt:monotonicMs(), resolve, reject});
      (foregroundAction.test(name) ? this.foregroundQueue : this.backgroundQueue).push(id);
      this.pump();
    });
  }
  /** Worker 空闲时取下一项：前台通道优先，各通道内保持先进先出。 */
  private pump(): void {
    if (this.failed || this.inFlight !== undefined) return;
    for (;;) {
      const id = this.foregroundQueue.shift() ?? this.backgroundQueue.shift();
      if (id === undefined) return;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.inFlight = id;
      try { this.worker.postMessage({id, name: pending.name, input: pending.input, lease: pending.lease,traceId:pending.traceId}); }
      catch { this.fail('post_message_failed', pending.name); }
      return;
    }
  }
  private fail(cause?: StorageFailureDiagnostic['cause'], action?: string): void {
    if (this.failed) return;
    if (cause) {
      const active = [...this.pending.values()].find(pending => pending.started);
      const current = action ?? active?.name;
      this.diagnostic = Object.freeze({cause, ...(typeof current === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(current) ? {action: current} : {}),
        pendingCount: this.pending.size, queuedCount: [...this.pending.values()].filter(pending => !pending.started).length});
      // 存储线程失效后本进程不会自行恢复，必须在日志中留下是哪个受控动作、持续多久；不含输入或业务内容。
      diagnose({event: 'storage.failed', reasonCode: cause, count: this.pending.size,
        ...(this.diagnostic.action ? {action: this.diagnostic.action} : {}),
        ...(active?.startedAt !== undefined ? {durationMs: milliseconds(monotonicMs() - active.startedAt)} : {}),
        ...(active ? {traceId: active.traceId} : {})});
    }
    this.failed = true;
    this.foregroundQueue.length = 0; this.backgroundQueue.length = 0; this.inFlight = undefined;
    for(const reader of this.readers)void reader.close().catch(()=>{});
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new StorageFailure('worker_failed')); }
    this.pending.clear();
  }
}
