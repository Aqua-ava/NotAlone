/** 桌面后台任务的TS状态/控制适配层；run/retry只承接已迁移的导入任务。 */
import type pg from 'pg';
import type {TaskControlPort,TaskScope} from './task-control.ts';
import {TaskControlError} from './task-control.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const requestInvalid=()=>({status:400,body:{error:'import_request_invalid'}});
const taskNotFound=()=>({status:404,body:{error:'task_not_found'}});
const taskConflict=()=>({status:409,body:{error:'task_retry_conflict'}});
const recoverableTaskErrors=new Set(['model_configuration_unavailable','runtime_stopping','worker_unavailable','task_unavailable']);

interface TaskRow {
  task_id:string;
  task_type:string;
  status:string;
  current_step:string;
  message_count:number;
  retry_count:number;
  last_error_code:string|null;
  extraction_runtime_config:unknown;
  step_name:string|null;
  step_status:string|null;
  attempt_count:number|null;
  processed_count:number|null;
  total_count:number|null;
  step_error_code:string|null;
}

export interface TaskStatus {
  task_id:string;
  task_type:string;
  status:string;
  step:string;
  message_count:number;
  retry_count:number;
  error_code:string|null;
  steps:Array<{
    name:string;
    status:string;
    attempt_count:number;
    processed_count:number;
    total_count:number;
    error_code:string|null;
  }>;
  extraction_runtime_config?:Record<string,unknown>;
}

export interface TaskStatusSource {
  read(scope:TaskScope,taskId:string):Promise<TaskStatus|null>;
  readImportControl(scope:TaskScope,taskId:string):Promise<{sourceActive:boolean}|null>;
}

const safeCount=(value:unknown):number=>{
  const count=Number(value);
  if(!Number.isSafeInteger(count)||count<0)throw new Error('TASK_STATUS_INVALID');
  return count;
};

/** 只读同一 owner/contact/task 的PostgreSQL行，不按联系人扫描队列。 */
export class PostgresTaskStatusStore implements TaskStatusSource {
  private readonly pool:pg.Pool;
  constructor(pool:pg.Pool){this.pool=pool;}

  async read(scope:TaskScope,taskId:string):Promise<TaskStatus|null>{
    const result=await this.pool.query<TaskRow>(`SELECT
      task.id AS task_id,task.task_type,task.status,task.current_step,
      task.message_count,task.retry_count,task.last_error_code,
      task.extraction_runtime_config,
      step.step_name,step.status AS step_status,step.attempt_count,
      step.processed_count,step.total_count,step.last_error_code AS step_error_code
      FROM public.background_task AS task
      LEFT JOIN public.source_document AS source
        ON source.id=task.source_document_id
       AND source.owner_id=task.owner_id
       AND source.contact_id=task.contact_id
      LEFT JOIN public.background_task_step AS step ON step.task_id=task.id
      WHERE task.owner_id=$1 AND task.contact_id=$2 AND task.id=$3
      ORDER BY step.step_order NULLS LAST`,[scope.ownerId,scope.contactId,taskId]);
    if(!result.rowCount)return null;
    const first=result.rows[0];
    const payload:TaskStatus={
      task_id:first.task_id,task_type:first.task_type,status:first.status,step:first.current_step,
      message_count:safeCount(first.message_count),retry_count:safeCount(first.retry_count),
      error_code:first.last_error_code,
      steps:result.rows.filter(row=>row.step_name!==null).map(row=>({
        name:row.step_name!,status:row.step_status!,
        attempt_count:safeCount(row.attempt_count),processed_count:safeCount(row.processed_count),
        total_count:safeCount(row.total_count),error_code:row.step_error_code,
      })),
    };
    if(record(first.extraction_runtime_config))payload.extraction_runtime_config=first.extraction_runtime_config;
    return payload;
  }

  async readImportControl(scope:TaskScope,taskId:string):Promise<{sourceActive:boolean}|null>{
    const result=await this.pool.query<{source_status:string|null}>(`SELECT source.status AS source_status
      FROM public.background_task AS task
      LEFT JOIN public.source_document AS source
        ON source.id=task.source_document_id
       AND source.owner_id=task.owner_id
       AND source.contact_id=task.contact_id
      WHERE task.owner_id=$1 AND task.contact_id=$2 AND task.id=$3
        AND task.task_type='import'`,[scope.ownerId,scope.contactId,taskId]);
    if(!result.rowCount)return null;
    return {sourceActive:result.rows[0].source_status==='active'};
  }
}

export interface TaskApiOptions {
  ownerId:string;
  store:TaskStatusSource;
  control:TaskControlPort;
}
export interface TaskApiResponse {status:number;body:Record<string,unknown>}

export class TaskApi {
  private readonly options:TaskApiOptions;
  constructor(options:TaskApiOptions){
    this.options=options;
    if(!uuid.test(options.ownerId))throw new Error('TASK_OWNER_INVALID');
  }

  async handle(method:string,pathname:string,query:URLSearchParams,body?:unknown):Promise<TaskApiResponse|null>{
    if(!['/api/tasks/status','/api/tasks/run','/api/tasks/retry'].includes(pathname))return null;
    try{
      // status读取已落库的任何任务类型；run/retry只承接本票的导入任务。
      if(pathname==='/api/tasks/status'){
        if(method!=='GET')return requestInvalid();
        const request=this.statusRequest(query);
        const status=await this.options.store.read(request.scope,request.taskId);
        return status?{status:200,body:{...status}}:taskNotFound();
      }
      if(method!=='POST'||query.size)return requestInvalid();
      const request=this.controlRequest(body);
      const task=await this.options.store.readImportControl(request.scope,request.taskId);
      if(!task)return taskNotFound();
      if(!task.sourceActive)return taskConflict();
      if(pathname==='/api/tasks/run'){
        return {status:200,body:{status:await this.options.control.run(request.scope,request.taskId)}};
      }
      // retry先在原任务表内完成来源、租约和恢复动作复核，再唤醒同一TS Worker。
      return {status:200,body:await this.options.control.retry(request.scope,request.taskId)};
    }catch(error){
      if(error instanceof TaskControlError)return this.controlError(error);
      if(error instanceof Error&&error.message==='TASK_REQUEST_INVALID')return requestInvalid();
      return {status:503,body:{error:'task_unavailable'}};
    }
  }

  private statusRequest(query:URLSearchParams):{scope:TaskScope;taskId:string}{
    const names=[...query.keys()];
    if(names.length!==2||names.includes('')||new Set(names).size!==2
      ||query.getAll('contact_id').length!==1||query.getAll('task_id').length!==1){
      throw new Error('TASK_REQUEST_INVALID');
    }
    const contactId=this.identifier(query.get('contact_id'));
    const taskId=this.identifier(query.get('task_id'));
    return {scope:{ownerId:this.options.ownerId,contactId},taskId};
  }

  private controlRequest(value:unknown):{scope:TaskScope;taskId:string}{
    if(!record(value)||Object.keys(value).sort().join(',')!=='contact_id,task_id')throw new Error('TASK_REQUEST_INVALID');
    const contactId=this.identifier(value.contact_id);
    const taskId=this.identifier(value.task_id);
    return {scope:{ownerId:this.options.ownerId,contactId},taskId};
  }

  private identifier(value:unknown):string{
    if(typeof value!=='string'||!uuid.test(value))throw new Error('TASK_REQUEST_INVALID');
    return value.toLowerCase();
  }

  private controlError(error:TaskControlError):TaskApiResponse{
    if(error.code==='task_not_found')return taskNotFound();
    if(error.code==='task_retry_conflict')return taskConflict();
    if(error.status===503&&recoverableTaskErrors.has(error.code))return {status:503,body:{error:error.code}};
    return {status:503,body:{error:'task_unavailable'}};
  }
}
