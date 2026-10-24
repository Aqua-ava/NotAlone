/** 原 PostgreSQL 队列的唯一提取 Worker；只领取一个步骤，不起第二个计时循环。 */
import {randomUUID} from 'node:crypto';
import {ExtractionTaskError,type ExtractionClaim,type ExtractionScope,type ExtractionTaskStore} from './extraction-task-store.ts';

export interface ExtractionWorkerResult {
  processedCount:number;
  totalCount?:number;
}

/**
 * 执行器必须在同一 claim 围栏内完成 B 段、追踪与水位提交，再返回真实处理量。
 * Worker 只负责原任务/步骤租约、心跳与最终 complete/fail，不据此伪造采纳。
 */
export interface ExtractionWorkerRunner {
  run(claim:ExtractionClaim,signal:AbortSignal):Promise<ExtractionWorkerResult>;
}

export interface ExtractionWorkerOptions {
  store:ExtractionTaskStore;
  ownerId:string;
  runner:ExtractionWorkerRunner;
  organizationRunner?:ExtractionWorkerRunner;
  workerId?:string;
  leaseMs?:number;
  heartbeatMs?:number;
  idleMs?:number;
}

type Wake = {scope?:ExtractionScope;taskId?:string};
type WorkerState = 'idle'|'running'|'stopping'|'stopped';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function positiveInteger(value:number,name:string,maximum:number):number {
  if(!Number.isSafeInteger(value)||value<1||value>maximum)throw new ExtractionTaskError(name);
  return value;
}

function errorCode(error:unknown):string {
  const raw=error&&typeof error==='object'&&'code' in error?String(error.code):'';
  return /^[A-Za-z0-9_]{1,64}$/.test(raw)?raw:'extraction_worker_failed';
}

function retryable(error:unknown):boolean {
  return Boolean(error&&typeof error==='object'&&'retryable' in error&&error.retryable===true);
}

/** 单进程、单 owner 的唯一 Worker；全局 advisory lock 在使用期始终由本实例持有。 */
export class ExtractionWorker {
  private readonly store:ExtractionTaskStore;
  private readonly ownerId:string;
  private readonly runner:ExtractionWorkerRunner;
  private readonly organizationRunner:ExtractionWorkerRunner|undefined;
  private readonly workerId:string;
  private readonly leaseMs:number;
  private readonly heartbeatMs:number;
  private readonly idleMs:number;
  private state:WorkerState='idle';
  private abort:AbortController|null=null;
  private release:null|(()=>Promise<void>)=null;
  private loop:Promise<void>|null=null;
  private starting:Promise<boolean>|null=null;
  private wakeSignal:Promise<void>|null=null;
  private wakeResolve:(()=>void)|null=null;
  private wakeTimer:NodeJS.Timeout|null=null;
  private readonly wakes=new Map<string|undefined,Wake>();

  constructor(options:ExtractionWorkerOptions){
    if(!uuid.test(options.ownerId))throw new ExtractionTaskError('worker_scope_invalid');
    this.workerId=(options.workerId??randomUUID()).toLowerCase();
    if(!uuid.test(this.workerId))throw new ExtractionTaskError('worker_identity_invalid');
    this.leaseMs=positiveInteger(options.leaseMs??30_000,'worker_lease_invalid',300_000);
    this.heartbeatMs=positiveInteger(options.heartbeatMs??Math.max(250,Math.floor(this.leaseMs/3)),'worker_heartbeat_invalid',this.leaseMs);
    this.idleMs=positiveInteger(options.idleMs??1_000,'worker_idle_invalid',60_000);
    this.store=options.store;this.ownerId=options.ownerId.toLowerCase();this.runner=options.runner;
    this.organizationRunner=options.organizationRunner;
  }

  status():{state:WorkerState;worker_id:string}{
    return {state:this.state,worker_id:this.workerId};
  }

  /** 返回 false 表示另一个进程或实例已经持有原 global-worker 会话锁。 */
  start():Promise<boolean>{
    if(this.starting)return this.starting;
    if(this.loop)return Promise.resolve(true);
    this.starting=(async()=>{
      const held=await this.store.acquireWorker();
      if(!held){this.state='stopped';return false;}
      this.release=held.release;this.abort=new AbortController();this.state='running';
      this.loop=this.runLoop(this.abort.signal).finally(async()=>{
        this.state='stopped';this.loop=null;this.abort=null;
        const release=this.release;this.release=null;
        if(release)await release();
      });
      void this.loop.catch(()=>{});
      this.notify();
      return true;
    })().finally(()=>{this.starting=null;});
    return this.starting;
  }

  /** 事件只是提示；持久回执和 due_at 已先提交，通知丢失仍由轮询补偿。 */
  wake(scope?:ExtractionScope,taskId?:string):boolean{
    if(this.state!=='running')return false;
    if(scope&&(scope.ownerId.toLowerCase()!==this.ownerId
      ||scope.contactId!==null&&!uuid.test(scope.contactId)))return false;
    if(scope){
      const contactId=scope.contactId?.toLowerCase()??null;
      this.wakes.set(`${this.ownerId}:${contactId??'owner'}`,{scope:{ownerId:this.ownerId,contactId},...(taskId?{taskId}:{})});
    }
    else this.wakes.set(undefined,{...(taskId?{taskId}:{})});
    this.notify();
    return true;
  }

  /** 超时不会强抢运行中的模型调用；未排空时仍由原租约在进程退出后恢复。 */
  async stop(timeoutMs=4_000):Promise<boolean>{
    if(!this.loop)return true;
    if(this.state==='running')this.state='stopping';
    this.abort?.abort();this.notify();
    let timer:NodeJS.Timeout|undefined;
    try{
      const drained=await Promise.race([
        this.loop.then(()=>true),
        new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs);}),
      ]);
      return drained;
    }finally{if(timer)clearTimeout(timer);}
  }

  private notify():void{
    if(this.wakeTimer){clearTimeout(this.wakeTimer);this.wakeTimer=null;}
    const resolve=this.wakeResolve;this.wakeResolve=null;this.wakeSignal=null;resolve?.();
  }

  private async waitForWake(signal:AbortSignal):Promise<void>{
    if(signal.aborted)return;
    this.wakeSignal??=new Promise(resolve=>{this.wakeResolve=resolve;});
    this.wakeTimer??=setTimeout(()=>this.notify(),this.idleMs);
    await Promise.race([
      this.wakeSignal,
      new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true})),
    ]);
  }

  private async runLoop(signal:AbortSignal):Promise<void>{
    while(!signal.aborted){
      try{
        if(await this.runOne(signal))continue;
      }catch(error){
        if(signal.aborted)break;
        // 扫描或租约存储故障不解锁另一个 Worker；短暂退避后仍在同一全局锁内重试。
        if(!(error instanceof ExtractionTaskError))throw error;
      }
      await this.waitForWake(signal);
    }
  }

  private async runOne(signal:AbortSignal):Promise<boolean>{
    const hinted=[...this.wakes.entries()];
    this.wakes.clear();
    const hintedScopes=hinted.flatMap(([,value])=>value.scope?[value.scope]:[]);
    let scopes=await this.store.readyScopes(
      this.ownerId,64,['legacy','bounded-runtime-v1'],this.organizationRunner!==undefined,
    );
    if(hintedScopes.length){
      const ordered=[...hintedScopes,...scopes];
      scopes=[...new Map(ordered.map(scope=>[scope.contactId??'owner',scope])).values()];
    }
    const taskHint=hinted.find(([key])=>key===undefined)?.[1].taskId;
    const scopedHints=new Map(hinted.flatMap(([,value])=>value.scope&&value.taskId?[[value.scope.contactId,value.taskId] as const]:[]));
    for(const scope of scopes){
      if(signal.aborted)return false;
      let claim:ExtractionClaim|null;
      try{
        if(scope.contactId!==null)await this.store.claimScheduled(scope);
        const taskId=scopedHints.get(scope.contactId)??taskHint;
        const supportedSteps=['parse','normalize','extract_memory',
          ...(this.organizationRunner?['organize_memory']:[])];
        claim=await this.store.claim(scope,{
          ...(taskId?{taskId}:{}),workerId:this.workerId,leaseMs:this.leaseMs,
          supportedSteps,
        });
      }catch(error){
        // 一个联系人的配置或来源冲突不能饿死其他联系人；真实PG故障仍由外层停止交付。
        if(error instanceof ExtractionTaskError)continue;
        throw error;
      }
      if(!claim)continue;
      await this.execute(claim,signal);
      return true;
    }
    return false;
  }

  private async execute(claim:ExtractionClaim,globalSignal:AbortSignal):Promise<void>{
    if(claim.stepName==='parse'||claim.stepName==='normalize'){
      await this.store.complete(claim,claim.messageCount,claim.messageCount);
      return;
    }
    const runner=claim.stepName==='organize_memory'?this.organizationRunner
      :claim.stepName==='extract_memory'?this.runner:undefined;
    if(!runner)throw new ExtractionTaskError('worker_step_unsupported');
    const stepAbort=new AbortController();
    const signal=AbortSignal.any([globalSignal,stepAbort.signal]);
    let heartbeatError:unknown;
    const heartbeat=setInterval(()=>{
      if(signal.aborted)return;
      void this.store.renew(claim,this.leaseMs).catch(error=>{
        heartbeatError=error;stepAbort.abort();
        void this.store.pause(claim).catch(()=>{});
      });
    },this.heartbeatMs);
    try{
      const result=await runner.run(claim,signal);
      if(heartbeatError)throw heartbeatError;
      if(signal.aborted)throw new ExtractionTaskError('worker_stopped');
      if(!Number.isSafeInteger(result.processedCount)||result.processedCount<0
       ||result.totalCount!==undefined&&(!Number.isSafeInteger(result.totalCount)||result.totalCount<0)){
        throw new ExtractionTaskError('worker_result_invalid');
      }
      await this.store.complete(claim,result.processedCount,result.totalCount??claim.messageCount);
    }catch(error){
      if(signal.aborted){
        await this.store.pause(claim).catch(()=>{});
        return;
      }
      if(error instanceof ExtractionTaskError&&error.code==='lease_stale')return;
      await this.store.fail(claim,errorCode(error),retryable(error)).catch(()=>{});
    }finally{clearInterval(heartbeat);}
  }
}
