/** 全部业务任务的只读投影与显式生命周期动作；不创建 Agent 或计划工具。 */
import type pg from 'pg';

export type BusinessTaskType =
  | 'import'
  | 'observation'
  | 'delete'
  | 'skill_learning'
  | 'layered_memory'
  | 'memory_upgrade';
export type BusinessTaskStatus =
  | 'queued'
  | 'running'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'paused'
  | 'interrupted';
export type BusinessTaskAction =
  | {kind:'stop'}
  | {kind:'recover';target:'tasks'|'skill_learning'}
  | {kind:'recover';target:'layered_memory';work_revision:number;settings_generation:number};

export interface BusinessTaskStep {
  name:string;
  status:string;
  attempt_count:number;
  processed_count:number;
  total_count:number|null;
  error_code:string|null;
  lease_expires_at:string|null;
}

export interface BusinessTask {
  task_id:string;
  task_type:BusinessTaskType;
  contact_id:string|null;
  scope_kind:'owner'|'contact';
  status:BusinessTaskStatus;
  phase:string;
  message_count:number;
  retry_count:number;
  error_code:string|null;
  processed_count:number;
  total_count:number|null;
  work_revision:number|null;
  settings_generation:number|null;
  updated_at:string;
  steps:BusinessTaskStep[];
  actions:BusinessTaskAction[];
}

export interface BusinessTaskList {
  tasks:BusinessTask[];
  has_more:boolean;
}

export interface BusinessTaskListOptions {
  contactId?:string|null;
  scope?:'owner';
  limit?:number;
}
export interface BusinessTaskReference {
  contactId?:string|null;
  scope?:'owner';
  taskId:string;
}
export interface BusinessTaskStopResult {
  task_id:string;
  status:'stopped'|'completed'|'failed';
}
export interface BusinessTaskRecoveryRequest extends BusinessTaskReference {
  action:'resume'|'restart';
}
export interface BusinessTaskRecoveryResult {
  task_id:string;
  status:'queued'|'completed';
}

export class BusinessTaskError extends Error {
  readonly code:string;
  readonly status:number;
  constructor(code:string,status=409){
    super(code);this.code=code;this.status=status;this.name='BusinessTaskError';
  }
}

export interface BusinessTaskManagerPort {
  list(ownerId:string,options?:BusinessTaskListOptions):Promise<BusinessTaskList>;
  stop(ownerId:string,request:BusinessTaskReference):Promise<BusinessTaskStopResult>;
  recover(ownerId:string,request:BusinessTaskRecoveryRequest):Promise<BusinessTaskRecoveryResult>;
}

export interface BusinessTaskApiResponse {status:number;body:Record<string,unknown>}
export interface BusinessTaskApiOptions {
  ownerId:string;
  manager:BusinessTaskManagerPort;
  onStopped?:(request:BusinessTaskReference)=>void|Promise<void>;
}

interface TaskRow extends pg.QueryResultRow {
  task_id:string;
  task_type:BusinessTaskType;
  contact_id:string|null;
  status:string;
  current_step:string;
  message_count:number;
  retry_count:number;
  last_error_code:string|null;
  task_updated_at:Date|string;
  source_status:string|null;
  deletion_error_code:string|null;
  binding_active:boolean|null;
  learning_enabled:boolean|null;
  layered_enabled:boolean|null;
  job_state:string|null;
  job_revision:string|number|null;
  settings_generation:string|number|null;
  step_name:string|null;
  step_status:string|null;
  attempt_count:number|null;
  processed_count:number|null;
  total_count:number|null;
  step_error_code:string|null;
  lease_expires_at:Date|string|null;
  lease_live:boolean|null;
}

interface MutableTask {
  task_id:string;
  task_type:BusinessTaskType;
  contact_id:string|null;
  scope_kind:'owner'|'contact';
  status:string;
  phase:string;
  message_count:number;
  retry_count:number;
  last_error_code:string|null;
  updated_at:string;
  work_revision:number|null;
  settings_generation:number|null;
  source_status:string|null;
  deletion_error_code:string|null;
  binding_active:boolean|null;
  learning_enabled:boolean|null;
  layered_enabled:boolean|null;
  job_state:string|null;
  steps:BusinessTaskStep[];
  running:boolean;
}

const taskTypes=new Set<BusinessTaskType>([
  'import','observation','delete','skill_learning','layered_memory','memory_upgrade',
]);
const unifiedMemoryTypes=new Set<BusinessTaskType>(['import','observation','layered_memory']);
const activeStatuses=new Set(['queued','running','verifying']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUnifiedMemoryTask=(type:BusinessTaskType)=>unifiedMemoryTypes.has(type);

function count(value:unknown):number {
  const result=Number(value??0);
  if(!Number.isSafeInteger(result)||result<0)throw new Error('TASK_COUNT_INVALID');
  return result;
}
function iso(value:Date|string):string {
  const parsed=value instanceof Date?value:new Date(value);
  if(!Number.isFinite(parsed.getTime()))throw new Error('TASK_TIME_INVALID');
  return parsed.toISOString();
}
function normalizedStatus(taskType:BusinessTaskType,raw:string,live:boolean,jobState:string|null):BusinessTaskStatus {
  if(['succeeded','failed','cancelled'].includes(raw))return raw as BusinessTaskStatus;
  if(raw==='queued')return 'queued';
  if(taskType==='layered_memory'&&jobState==='paused')return 'paused';
  if(live&&['running','verifying'].includes(raw))return raw as BusinessTaskStatus;
  return 'interrupted';
}
function recoveryEligible(task:MutableTask):boolean {
  return task.task_type==='skill_learning'
    &&task.binding_active===true&&task.learning_enabled===true;
}
function actions(task:MutableTask,status:BusinessTaskStatus):BusinessTaskAction[] {
  if(task.task_type==='memory_upgrade')return [];
  if(isUnifiedMemoryTask(task.task_type))return [];
  if(task.last_error_code==='model_call_outcome_unknown'
    ||task.steps.some(step=>step.error_code==='model_call_outcome_unknown'))return [];
  if(['queued','running','verifying'].includes(status))return [{kind:'stop'}];
  if(!['failed','cancelled','paused','interrupted'].includes(status)||!recoveryEligible(task))return [];
  if(task.task_type==='delete')return [];
  if(task.task_type==='skill_learning')return [{kind:'recover',target:'skill_learning'}];
  return [];
}
function currentStep(task:MutableTask,phase:string):BusinessTaskStep|undefined {
  return task.steps.find(step=>step.name===phase)
    ??task.steps.find(step=>step.status==='running')
    ??task.steps.find(step=>step.status==='retryable'||step.status==='failed')
    ??task.steps.at(-1);
}
function project(task:MutableTask):BusinessTask {
  const status=normalizedStatus(task.task_type,task.status,task.running,task.job_state);
  const current=currentStep(task,task.phase);
  return {
    task_id:task.task_id,task_type:task.task_type,contact_id:task.contact_id,
    scope_kind:task.scope_kind,status,phase:task.phase,message_count:task.message_count,
    retry_count:task.retry_count,
    error_code:task.last_error_code??task.deletion_error_code??current?.error_code??null,
    processed_count:current?.processed_count??0,total_count:current?.total_count??null,
    work_revision:task.work_revision,settings_generation:task.settings_generation,
    updated_at:task.updated_at,steps:task.steps,actions:actions(task,status),
  };
}

export class PostgresBusinessTaskManager {
  private readonly database:Pick<pg.Pool,'query'>|Pick<pg.Client,'query'>;
  constructor(database:Pick<pg.Pool,'query'>|Pick<pg.Client,'query'>){
    this.database=database;
  }

  /** 只读 owner 范围；不给旧宿主或页面读操作附加唤醒副作用。 */
  async list(ownerId:string,options:BusinessTaskListOptions={}):Promise<BusinessTaskList> {
    const contactId=options.contactId??null;
    const ownerOnly=options.scope==='owner';
    const limit=options.limit??100;
    if(!uuid.test(ownerId)||contactId!==null&&!uuid.test(contactId)
      ||ownerOnly&&contactId!==null
      ||options.scope!==undefined&&options.scope!=='owner'
      ||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('TASK_LIST_INVALID');
    const rows=(await this.database.query<TaskRow>(`WITH selected AS (
      SELECT t.* FROM public.background_task t
      WHERE t.owner_id=$1 AND ($2::uuid IS NULL OR t.contact_id=$2)
        AND ($4::boolean=false OR t.contact_id IS NULL)
      ORDER BY CASE WHEN t.status IN ('queued','running','verifying') THEN 0 ELSE 1 END,
        t.updated_at DESC,t.id
      LIMIT $3
    )
      SELECT
      t.id AS task_id,t.task_type,t.contact_id,t.status,t.current_step,t.message_count,
      t.retry_count,t.last_error_code,t.updated_at AS task_updated_at,
      source.status AS source_status,source.deletion_error_code,
      EXISTS(SELECT 1 FROM public.conversation_binding binding
        WHERE binding.owner_id=t.owner_id AND binding.contact_id=t.contact_id
          AND binding.status='active') AS binding_active,
      setting.enabled AS learning_enabled,state.enabled AS layered_enabled,
      job.state AS job_state,job.revision AS job_revision,
      job.settings_generation,
      step.step_name,step.status AS step_status,step.attempt_count,step.processed_count,
      step.total_count,step.last_error_code AS step_error_code,step.lease_expires_at,
      step.lease_expires_at>clock_timestamp() AS lease_live
      FROM selected t
      LEFT JOIN public.source_document source
        ON source.id=t.source_document_id AND source.owner_id=t.owner_id
        AND source.contact_id=t.contact_id
      LEFT JOIN public.skill_learning_scope setting
        ON setting.owner_id=t.owner_id AND setting.contact_id=t.contact_id
      LEFT JOIN public.layered_memory_job job
        ON job.task_id=t.id AND job.owner_id=t.owner_id
        AND job.contact_id IS NOT DISTINCT FROM t.contact_id
      LEFT JOIN public.layered_memory_state state
        ON state.owner_id=t.owner_id AND state.contact_id IS NOT DISTINCT FROM t.contact_id
      LEFT JOIN public.background_task_step step ON step.task_id=t.id
      WHERE t.owner_id=$1
      ORDER BY CASE WHEN t.status IN ('queued','running','verifying') THEN 0 ELSE 1 END,
        t.updated_at DESC,t.id,step.step_order
      `,[ownerId.toLowerCase(),contactId?.toLowerCase()??null,limit+1,ownerOnly])).rows;
    if(rows.some(row=>!taskTypes.has(row.task_type)))throw new Error('TASK_TYPE_INVALID');
    const grouped=new Map<string,MutableTask>();
    const order:string[]=[];
    for(const row of rows){
      let task=grouped.get(row.task_id);
      if(!task){
        task={
          task_id:row.task_id,task_type:row.task_type,contact_id:row.contact_id,
          scope_kind:row.contact_id===null?'owner':'contact',status:row.status,
          phase:row.current_step,message_count:count(row.message_count),retry_count:count(row.retry_count),
          last_error_code:row.last_error_code,updated_at:iso(row.task_updated_at),
          source_status:row.source_status,deletion_error_code:row.deletion_error_code,
          binding_active:row.binding_active,learning_enabled:row.learning_enabled,
          layered_enabled:row.layered_enabled,job_state:row.job_state,
          work_revision:row.job_revision===null?null:count(row.job_revision),
          settings_generation:row.settings_generation===null?null:count(row.settings_generation),
          steps:[],running:false,
        };
        grouped.set(row.task_id,task);order.push(row.task_id);
      }
      if(row.step_name!==null){
        task.steps.push({
          name:row.step_name,status:row.step_status??'pending',attempt_count:count(row.attempt_count),
          processed_count:count(row.processed_count),
          total_count:row.total_count===null?null:count(row.total_count),
          error_code:row.step_error_code,
          lease_expires_at:row.lease_expires_at===null?null:iso(row.lease_expires_at),
        });
        if(row.lease_live===true)task.running=true;
      }
    }
    const tasks=order.slice(0,limit).map(id=>project(grouped.get(id)!));
    return {tasks,has_more:order.length>limit};
  }

  /** 页面停任务只撤销持久提交资格；不等待或杀死未知外部调用。 */
  async stop(ownerId:string,request:BusinessTaskReference):Promise<BusinessTaskStopResult> {
    if(!uuid.test(ownerId)||!uuid.test(request.taskId)
      ||request.contactId!==undefined&&request.contactId!==null&&!uuid.test(request.contactId))
      throw new BusinessTaskError('task_reference_invalid',400);
    if(request.scope!==undefined&&request.scope!=='owner'
      ||request.scope==='owner'&&request.contactId!==undefined&&request.contactId!==null)
      throw new BusinessTaskError('task_reference_invalid',400);
    const ownerOnly=request.scope==='owner';
    return this.transaction(async database=>{
      const initial=(await database.query<{contact_id:string|null;status:string}>(`SELECT contact_id,status
        FROM public.background_task WHERE id=$1 AND owner_id=$2
          AND ($3::uuid IS NULL OR contact_id=$3)
          AND ($4::boolean=false OR contact_id IS NULL)`,
      [request.taskId,ownerId,request.contactId??null,ownerOnly])).rows[0];
      if(!initial)throw new BusinessTaskError('task_not_found',404);
      if(initial.contact_id!==null){
        await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`contact:${ownerId}:${initial.contact_id}`]);
      }
      await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${ownerId}`]);
      const task=(await database.query<{contact_id:string|null;status:string;task_type:BusinessTaskType;
        current_step:string}>(`SELECT contact_id,status,task_type,current_step
        FROM public.background_task WHERE id=$1 AND owner_id=$2
          AND ($3::uuid IS NULL OR contact_id=$3)
          AND ($4::boolean=false OR contact_id IS NULL) FOR UPDATE`,
      [request.taskId,ownerId,request.contactId??null,ownerOnly])).rows[0];
      if(!task)throw new BusinessTaskError('task_not_found',404);
      if(isUnifiedMemoryTask(task.task_type))
        throw new BusinessTaskError('task_stop_requires_memory_control');
      if(task.status==='succeeded')return {task_id:request.taskId,status:'completed'};
      if(task.status==='failed')return {task_id:request.taskId,status:'failed'};
      if(task.status==='cancelled')return {task_id:request.taskId,status:'stopped'};
      if(!activeStatuses.has(task.status))throw new BusinessTaskError('task_stop_conflict');
      await database.query(`UPDATE public.background_task_step
        SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,
          lease_generation=lease_generation+1,last_error_code='task_stopped',
          finished_at=COALESCE(finished_at,clock_timestamp()),updated_at=clock_timestamp()
        WHERE task_id=$1 AND status<>'succeeded'`,[request.taskId]);
      await database.query(`UPDATE public.background_task
        SET status='cancelled',last_error_code='task_stopped',finished_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 AND status IN ('queued','running','verifying')`,[request.taskId]);
      return {task_id:request.taskId,status:'stopped'};
    });
  }

  /**
   * 只恢复确定性任务表的原任务。Skill 与 L2/L3 使用各自领域动作，
   * 避免把已提交批次、预算或授权修订当成普通步骤重置。
   */
  async recover(ownerId:string,request:BusinessTaskRecoveryRequest):Promise<BusinessTaskRecoveryResult> {
    if(!uuid.test(ownerId)||!uuid.test(request.taskId)
      ||request.contactId!==undefined&&request.contactId!==null&&!uuid.test(request.contactId)
      ||!['resume','restart'].includes(request.action))
      throw new BusinessTaskError('task_recovery_invalid',400);
    if(request.scope!==undefined&&request.scope!=='owner'
      ||request.scope==='owner'&&request.contactId!==undefined&&request.contactId!==null)
      throw new BusinessTaskError('task_recovery_invalid',400);
    const ownerOnly=request.scope==='owner';
    return this.transaction(async database=>{
      const initial=(await database.query<{contact_id:string|null}>(`SELECT contact_id
        FROM public.background_task WHERE id=$1 AND owner_id=$2
          AND ($3::uuid IS NULL OR contact_id=$3)
          AND ($4::boolean=false OR contact_id IS NULL)`,
      [request.taskId,ownerId,request.contactId??null,ownerOnly])).rows[0];
      if(!initial)throw new BusinessTaskError('task_not_found',404);
      if(initial.contact_id!==null){
        await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`contact:${ownerId}:${initial.contact_id}`]);
      }
      await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${ownerId}`]);
      const row=(await database.query<{contact_id:string|null;status:string;task_type:BusinessTaskType;
        last_error_code:string|null;source_status:string|null;binding_active:boolean|null;
        live_lease:boolean}>(`SELECT t.contact_id,t.status,t.task_type,t.last_error_code,
        source.status AS source_status,
        EXISTS(SELECT 1 FROM public.conversation_binding binding
          WHERE binding.owner_id=t.owner_id AND binding.contact_id=t.contact_id
            AND binding.status='active') AS binding_active,
        EXISTS(SELECT 1 FROM public.background_task_step step
          WHERE step.task_id=t.id AND step.status='running'
            AND step.lease_expires_at>clock_timestamp()) AS live_lease
        FROM public.background_task t
        LEFT JOIN public.source_document source
          ON source.id=t.source_document_id AND source.owner_id=t.owner_id
          AND source.contact_id=t.contact_id
        WHERE t.id=$1 AND t.owner_id=$2 AND ($3::uuid IS NULL OR t.contact_id=$3)
          AND ($4::boolean=false OR t.contact_id IS NULL)
        FOR UPDATE OF t`,[request.taskId,ownerId,request.contactId??null,ownerOnly])).rows[0];
      if(!row)throw new BusinessTaskError('task_not_found',404);
      if(isUnifiedMemoryTask(row.task_type))
        throw new BusinessTaskError('task_recovery_requires_domain_action');
      if(row.live_lease)throw new BusinessTaskError('task_recovery_busy');
      if(row.status==='succeeded')return {task_id:request.taskId,status:'completed'};
      if(request.action==='restart'&&row.status!=='cancelled'
        ||request.action==='resume'&&!['failed','running','verifying'].includes(row.status))
        throw new BusinessTaskError('task_recovery_conflict');
      const unknown=(await database.query(`SELECT 1 FROM public.background_task_step
        WHERE task_id=$1 AND status<>'succeeded' AND last_error_code='model_call_outcome_unknown'
        LIMIT 1`,[request.taskId])).rowCount;
      if(unknown||row.last_error_code==='model_call_outcome_unknown')
        throw new BusinessTaskError('task_recovery_unknown');
      await database.query(`UPDATE public.background_task_step
        SET status='pending',attempt_count=0,processed_count=0,worker_id=NULL,
          lease_expires_at=NULL,lease_generation=lease_generation+1,
          last_error_code=NULL,started_at=NULL,finished_at=NULL,updated_at=clock_timestamp()
        WHERE task_id=$1 AND status<>'succeeded'`,[request.taskId]);
      const next=(await database.query<{step_name:string}>(`SELECT step_name
        FROM public.background_task_step WHERE task_id=$1 AND status<>'succeeded'
        ORDER BY step_order LIMIT 1`,[request.taskId])).rows[0];
      if(!next)return {task_id:request.taskId,status:'completed'};
      await database.query(`UPDATE public.background_task SET status='queued',current_step=$2,
        last_error_code=NULL,finished_at=NULL,retry_count=retry_count+1,updated_at=clock_timestamp()
        WHERE id=$1`,[request.taskId,next.step_name]);
      return {task_id:request.taskId,status:'queued'};
    });
  }

  private async transaction<T>(work:(database:pg.PoolClient|pg.Client)=>Promise<T>):Promise<T> {
    const owned='totalCount' in this.database;
    const database=owned?await (this.database as pg.Pool).connect():this.database as pg.Client;
    try{
      await database.query('BEGIN');
      const value=await work(database);
      await database.query('COMMIT');
      return value;
    }catch(error){
      await database.query('ROLLBACK').catch(()=>{});
      throw error;
    }finally{
      if(owned)(database as pg.PoolClient).release();
    }
  }
}

/** 公共任务面只接受固定读取和动作，不代理任意业务 URL。 */
export class BusinessTaskApi {
  private readonly ownerId:string;
  private readonly manager:BusinessTaskManagerPort;
  private readonly onStopped:BusinessTaskApiOptions['onStopped'];
  constructor(options:BusinessTaskApiOptions){
    if(!uuid.test(options.ownerId))throw new BusinessTaskError('task_owner_invalid',400);
    this.ownerId=options.ownerId.toLowerCase();this.manager=options.manager;this.onStopped=options.onStopped;
  }

  async handle(method:string,pathname:string,query:URLSearchParams,body?:unknown):
    Promise<BusinessTaskApiResponse|null> {
    if(!['/api/tasks','/api/tasks/stop','/api/tasks/recover'].includes(pathname))return null;
    try{
      if(pathname==='/api/tasks'){
        if(method!=='GET'||body!==undefined)throw new BusinessTaskError('task_request_invalid',400);
        const options=this.listOptions(query);
        return {status:200,body:await this.manager.list(this.ownerId,options) as unknown as Record<string,unknown>};
      }
      if(method!=='POST'||query.size)throw new BusinessTaskError('task_request_invalid',400);
      if(!body||typeof body!=='object'||Array.isArray(body))
        throw new BusinessTaskError('task_request_invalid',400);
      const value=body as Record<string,unknown>;
      if(pathname==='/api/tasks/stop'){
        if(!Object.keys(value).every(key=>['contact_id','scope','task_id'].includes(key))
          ||!Object.hasOwn(value,'task_id'))throw new BusinessTaskError('task_request_invalid',400);
        const request=this.reference(value);
        const result=await this.manager.stop(this.ownerId,request);
        if(result.status==='stopped'){
          try{await this.onStopped?.(request);}catch{/* 持久取消已提交；中断在途调用是尽力而为。 */}
        }
        return {status:200,body:result as unknown as Record<string,unknown>};
      }
      if(!Object.keys(value).every(key=>['action','contact_id','scope','task_id'].includes(key))
        ||!Object.hasOwn(value,'task_id')||!['resume','restart'].includes(String(value.action)))
        throw new BusinessTaskError('task_request_invalid',400);
      const request={...this.reference(value),action:value.action as 'resume'|'restart'};
      return {status:200,body:await this.manager.recover(this.ownerId,request) as unknown as Record<string,unknown>};
    }catch(error){
      if(error instanceof BusinessTaskError){
        return {status:error.status,body:{error:error.code}};
      }
      return {status:503,body:{error:'task_unavailable'}};
    }
  }

  private listOptions(query:URLSearchParams):BusinessTaskListOptions {
    if([...query.keys()].some(key=>!['contact_id','limit','scope'].includes(key))
      ||query.getAll('contact_id').length>1||query.getAll('limit').length>1
      ||query.getAll('scope').length>1)
      throw new BusinessTaskError('task_request_invalid',400);
    const contact=query.get('contact_id'),scope=query.get('scope'),rawLimit=query.get('limit');
    if(scope!==null&&scope!=='owner'||scope!==null&&contact!==null)
      throw new BusinessTaskError('task_request_invalid',400);
    const limit=rawLimit===null?100:Number(rawLimit);
    if(rawLimit!==null&&(!/^[1-9][0-9]{0,2}$/.test(rawLimit)||!Number.isSafeInteger(limit)||limit>100))
      throw new BusinessTaskError('task_request_invalid',400);
    return {
      ...(contact===null?{}:{contactId:this.identifier(contact)}),
      ...(scope===null?{}:{scope:'owner' as const}),
      limit,
    };
  }
  private reference(value:Record<string,unknown>):BusinessTaskReference {
    if(value.scope!==undefined&&value.scope!=='owner'
      ||value.scope==='owner'&&value.contact_id!==undefined)
      throw new BusinessTaskError('task_request_invalid',400);
    return {
      contactId:value.contact_id===undefined?undefined:this.identifier(value.contact_id),
      ...(value.scope===undefined?{}:{scope:'owner' as const}),
      taskId:this.identifier(value.task_id),
    };
  }
  private identifier(value:unknown):string {
    if(typeof value!=='string'||!uuid.test(value))throw new BusinessTaskError('task_request_invalid',400);
    return value.toLowerCase();
  }
}
