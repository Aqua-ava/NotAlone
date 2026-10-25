/** 任务控制只提交已核验的固定动作，不代理任意URL或创建新任务。 */
import {LegacyControlError} from './legacy-backend.ts';
import type {ExtractionTaskStore} from './extraction-task-store.ts';
import type {ExtractionWorker} from './extraction-worker.ts';

export interface TaskScope {ownerId:string;contactId:string|null}
export interface TaskControlPort {
  run(scope:TaskScope,taskId:string):Promise<'started'|'busy'>;
  retry(scope:TaskScope,taskId:string):Promise<{task_id:string;status:'queued'}>;
  wake(scope:TaskScope,taskId:string):Promise<'started'|'busy'|'queued'>;
  stop?(scope:TaskScope,taskId:string):Promise<boolean>;
}
export interface TaskControlTarget {
  control(endpoint:string,method:string,body?:Record<string,unknown>,timeoutMs?:number,signal?:AbortSignal):
    Promise<Record<string,unknown>>;
}

export class TaskControlError extends Error {
  readonly code:string;
  readonly status:number;
  readonly deferredReason:'worker_unavailable'|'model_configuration_unavailable'|'wake_failed';
  constructor(code:string,status=503){
    super(code);
    this.code=code;
    this.status=status;
    this.deferredReason=code==='model_configuration_unavailable'
      ? 'model_configuration_unavailable'
      : code==='worker_unavailable' ? 'worker_unavailable' : 'wake_failed';
    this.name='TaskControlError';
  }
}

const publicCode=(value:unknown):string|undefined=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value)
  ? value : undefined;
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);

/**
 * 当前生产执行者仍是Python TaskHost。这里仅暴露三个固定命令：
 * run/retry 原任务，以及导入提交后的 wake 原任务。
 */
export class PythonTaskControlGateway {
  private target:TaskControlTarget|undefined;
  private closed=false;
  private closing:Promise<void>|undefined;
  private readonly inFlight=new Set<Promise<unknown>>();

  bind(target:TaskControlTarget):void {
    if(this.closed)throw new TaskControlError('worker_unavailable');
    if(this.target)throw new Error('TASK_CONTROL_ALREADY_BOUND');
    this.target=target;
  }

  run(scope:TaskScope,taskId:string):Promise<'started'|'busy'> {
    return this.invoke('/api/tasks/run',scope,taskId).then(response=>{
      if(response.status!=='started'&&response.status!=='busy')throw new TaskControlError('task_control_invalid');
      return response.status;
    });
  }

  retry(scope:TaskScope,taskId:string):Promise<{task_id:string;status:'queued'}> {
    return this.invoke('/api/tasks/retry',scope,taskId).then(response=>{
      if(response.task_id!==taskId||response.status!=='queued')throw new TaskControlError('task_control_invalid');
      return {task_id:taskId,status:'queued'};
    });
  }

  wake(scope:TaskScope,taskId:string):Promise<'started'|'busy'|'queued'> {
    return this.invoke('/internal/tasks/wake',scope,taskId).then(response=>{
      if(!['started','busy','queued'].includes(response.status as string)){
        throw new TaskControlError('task_control_invalid');
      }
      return response.status as 'started'|'busy'|'queued';
    });
  }

  close():Promise<void> {
    if(this.closing)return this.closing;
    this.closed=true;
    this.closing=(async()=>{
      while(this.inFlight.size)await Promise.allSettled([...this.inFlight]);
    })();
    return this.closing;
  }

  private async invoke(endpoint:string,scope:TaskScope,taskId:string):Promise<Record<string,unknown>> {
    if(this.closed||!this.target)throw new TaskControlError('worker_unavailable');
    const operation=this.target.control(endpoint,'POST',{
      contact_id:scope.contactId,task_id:taskId,
    }).then(value=>{
      if(!record(value))throw new TaskControlError('task_control_invalid');
      return value;
    });
    this.inFlight.add(operation);
    try{return await operation;}
    catch(error){
      if(error instanceof TaskControlError)throw error;
      if(error instanceof LegacyControlError){
        throw new TaskControlError(publicCode(error.code)??'task_unavailable',error.status);
      }
      throw new TaskControlError('task_unavailable');
    }finally{this.inFlight.delete(operation);}
  }
}

/** 本地TaskApi与导入wake共用同一宿主内唯一提取Worker，不再代理Python。 */
export class ExtractionWorkerTaskControl implements TaskControlPort {
 private readonly store:Pick<ExtractionTaskStore,'resume'>;
 private readonly worker:Pick<ExtractionWorker,'wake'|'cancel'>;
 private closed=false;
 private closing:Promise<void>|undefined;
 private readonly inFlight=new Set<Promise<unknown>>();

 constructor(options:{store:Pick<ExtractionTaskStore,'resume'>;worker:Pick<ExtractionWorker,'wake'|'cancel'>}){
  this.store=options.store;this.worker=options.worker;
 }

 run(scope:TaskScope,taskId:string):Promise<'started'|'busy'>{
  return this.invoke(async()=>{
   if(!this.worker.wake(scope,taskId))throw new TaskControlError('worker_unavailable');
   return 'started' as const;
  });
 }

 retry(scope:TaskScope,taskId:string):Promise<{task_id:string;status:'queued'}>{
  return this.invoke(async()=>{
   try{
    const resumed=await this.store.resume(scope,taskId,'resume');
    if(resumed.status!=='queued')throw new TaskControlError('task_retry_conflict',409);
   }catch(error){
    if(error instanceof TaskControlError)throw error;
    const code=record(error)&&typeof error.code==='string'?error.code:'task_unavailable';
    throw new TaskControlError(code==='task_not_found'?'task_not_found':'task_retry_conflict',
     code==='task_not_found'?404:409);
   }
   if(!this.worker.wake(scope,taskId))throw new TaskControlError('worker_unavailable');
   return {task_id:taskId,status:'queued'};
  });
 }

 wake(scope:TaskScope,taskId:string):Promise<'started'|'busy'|'queued'>{
  return this.invoke(async()=>{
   if(!this.worker.wake(scope,taskId))throw new TaskControlError('worker_unavailable');
   return 'started' as const;
  });
 }

 /** 持久任务已取消后尽量中断匹配的在途调用；返回值不代替已提交状态。 */
 stop(scope:TaskScope,taskId:string):Promise<boolean>{
  return this.invoke(async()=>{
   if(this.closed)throw new TaskControlError('worker_unavailable');
   return this.worker.cancel({ownerId:scope.ownerId,contactId:scope.contactId},taskId);
  });
 }

 close():Promise<void>{
  if(this.closing)return this.closing;
  this.closed=true;
  this.closing=(async()=>{while(this.inFlight.size)await Promise.allSettled([...this.inFlight]);})();
  return this.closing;
 }

 private async invoke<T>(operation:()=>Promise<T>):Promise<T>{
  if(this.closed)throw new TaskControlError('worker_unavailable');
  const pending=Promise.resolve().then(operation);
  this.inFlight.add(pending);
  try{return await pending;}finally{this.inFlight.delete(pending);}
 }
}

/** 模型尚未装配时仍保留稳定控制接口，所有动作在改库前失败关闭。 */
export class UnavailableTaskControl implements TaskControlPort {
 private readonly reason:'worker_unavailable'|'model_configuration_unavailable';
 constructor(reason:'worker_unavailable'|'model_configuration_unavailable'='worker_unavailable'){
  this.reason=reason;
 }
 async run():Promise<'started'|'busy'>{throw new TaskControlError(this.reason);}
 async retry():Promise<{task_id:string;status:'queued'}>{throw new TaskControlError(this.reason);}
 async wake():Promise<'started'|'busy'|'queued'>{throw new TaskControlError(this.reason);}
 async stop():Promise<boolean>{throw new TaskControlError(this.reason);}
 close():Promise<void>{return Promise.resolve();}
}
