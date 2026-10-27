/** 范围控制与原任务资格共用事务锁；不重置来源、成功步骤、预算或调用回执。 */
import type pg from 'pg';
import {memoryModelRequestIds} from './model-requests.ts';
import {unconfirmedARequests} from '../extraction/tasks/store-recovery.ts';
import type {TaskControlPort,TaskScope,TaskExecutionLease} from '../../tasks/task-control.ts';
import {profileOnlyRecoveryAllowed,resumeProfileOnlyRecovery} from '../records/documents/recovery.ts';

export class MemoryProcessingControlError extends Error {
 readonly code:string;readonly status:number;
 constructor(code='memory_processing_state_conflict',status=409){super(code);this.code=code;this.status=status;}
}
/** SQL 只引用调用方已核定的 t/s，不把本人 NULL 范围扩展成所有联系人。 */
export const memoryExecutionAllowed=`(t.task_type NOT IN ('import','observation','layered_memory') OR NOT EXISTS(
 SELECT 1 FROM memory_processing_scope control WHERE control.owner_id=t.owner_id
 AND control.contact_id IS NOT DISTINCT FROM t.contact_id AND (control.intent='pause'
 OR COALESCE(s.memory_control_generation,0)<>control.control_generation
 OR EXISTS(
  SELECT 1 FROM memory_processing_round round
  JOIN memory_processing_round_task member ON member.round_id=round.id
  WHERE round.id=control.active_round_id AND member.task_id=t.id
    AND member.owner_id=t.owner_id
    AND member.contact_id IS NOT DISTINCT FROM t.contact_id
    AND member.active AND round.status IN ('blocked','completed')
 ))))`;
export async function memoryScopePaused(c:pg.ClientBase,scope:TaskScope):Promise<boolean>{
 return Boolean((await c.query("SELECT 1 FROM memory_processing_scope WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND intent='pause'",[scope.ownerId,scope.contactId])).rowCount);
}
/** 查询与动作复用安全判断；未归属旧任务不能凭继续获得新授权。 */
export type MemoryProcessingUnconfirmed=(c:pg.ClientBase,scope:TaskScope)=>Promise<readonly string[]>;
export async function memoryContinueBlocker(c:pg.ClientBase,scope:TaskScope,activeRoundId:string|null,unconfirmed?:MemoryProcessingUnconfirmed):Promise<string|null>{
 const tasks=(await c.query(`SELECT t.* FROM background_task t WHERE t.owner_id=$1 AND t.contact_id IS NOT DISTINCT FROM $2::uuid
 AND t.task_type IN ('import','observation','layered_memory') AND ($3::uuid IS NULL OR EXISTS(
 SELECT 1 FROM memory_processing_round_task member WHERE member.task_id=t.id AND member.round_id=$3 AND member.active))`,[scope.ownerId,scope.contactId,activeRoundId])).rows;
 if(!activeRoundId&&tasks.length)return 'legacy_attribution_unverified';
 const requests=await memoryModelRequestIds(c,scope,tasks as {id:string;task_type:string}[]);
 if((await unconfirmed?.(c,scope))?.some(request=>requests.has(request))
  ||scope.contactId!==null&&(await unconfirmedARequests(c,scope,tasks.map(task=>task.id))).size)return 'model_call_outcome_unknown';
 if((await c.query(`SELECT 1 FROM model_call_receipt WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
 AND request_id=ANY($3::uuid[]) AND outcome IN ('pending','unknown') LIMIT 1`,[scope.ownerId,scope.contactId,[...requests]])).rowCount)return 'model_call_outcome_unknown';
 for(const task of tasks){
  if(task.status==='succeeded')continue;
  const profileRecovery=task.task_type==='layered_memory'
    &&await profileOnlyRecoveryAllowed(c,scope,task.id);
  if(task.status==='failed'&&!task.last_error_code)return 'processing_requires_repair';
  if((await c.query("SELECT 1 FROM background_task_step WHERE task_id=$1 AND status='running' AND lease_expires_at>clock_timestamp() LIMIT 1",[task.id])).rowCount)return 'execution_unavailable';
  if(!profileRecovery&&(task.status==='cancelled'||task.last_error_code
    &&!['lease_expired','worker_stopped','task_interrupted'].includes(task.last_error_code)))return 'processing_requires_repair';
  if(task.task_type==='import'&&!(await c.query("SELECT 1 FROM source_document WHERE id=$1 AND owner_id=$2 AND contact_id=$3 AND status='active'",[task.source_document_id,scope.ownerId,scope.contactId])).rowCount)return 'source_unavailable';
  if(task.task_type==='observation'&&!(await c.query("SELECT 1 FROM conversation_binding WHERE owner_id=$1 AND contact_id=$2 AND status='active'",[scope.ownerId,scope.contactId])).rowCount)return 'source_unavailable';
  if(task.task_type==='layered_memory'&&!profileRecovery&&!(await c.query(`SELECT 1 FROM layered_memory_job job JOIN layered_memory_state state
   ON state.owner_id=job.owner_id AND state.contact_id IS NOT DISTINCT FROM job.contact_id
   WHERE job.task_id=$1 AND job.state='active' AND state.enabled AND job.settings_generation=state.settings_generation
   AND (job.model_calls_used<job.model_call_limit OR job.pending_receipt
    AND job.profile_status IN ('succeeded','not_required') AND state.covered_count>=jsonb_array_length(job.target_manifest)
    AND EXISTS(SELECT 1 FROM layered_memory_batch batch WHERE batch.id=job.receipt_batch_id AND batch.task_id=job.task_id
     AND batch.owner_id=job.owner_id AND batch.contact_id IS NOT DISTINCT FROM job.contact_id
     AND batch.status='succeeded' AND batch.settings_generation=job.settings_generation))`,[task.id])).rowCount)return 'processing_requires_repair';
  if((await c.query("SELECT 1 FROM background_task_step WHERE task_id=$1 AND status<>'succeeded' AND (attempt_count>=3 OR last_error_code='model_call_outcome_unknown') LIMIT 1",[task.id])).rowCount)return 'processing_requires_repair';
 }
 return null;
}
/** 运行意图下仅恢复可信当前轮次的中断，不把普通等待或无依据阻碍当作重试授权。 */
export async function memoryHasInterruptedWork(c:pg.ClientBase,scope:TaskScope,roundId:string|null):Promise<boolean>{
 if(roundId===null)return false;
 if((await c.query(`SELECT 1 FROM memory_processing_round_task member JOIN background_task task ON task.id=member.task_id
  WHERE member.round_id=$1 AND member.active AND task.owner_id=$2 AND task.contact_id IS NOT DISTINCT FROM $3::uuid
  AND (task.status='failed' AND task.last_error_code IN ('lease_expired','worker_stopped','task_interrupted')
   OR task.status IN ('running','verifying') AND EXISTS(SELECT 1 FROM background_task_step step WHERE step.task_id=task.id
    AND step.status='running' AND step.lease_expires_at<=clock_timestamp()))
  LIMIT 1`,[roundId,scope.ownerId,scope.contactId])).rowCount)return true;
 const profileTasks=(await c.query(`SELECT task.id
  FROM memory_processing_round_task member
  JOIN background_task task ON task.id=member.task_id
  WHERE member.round_id=$1 AND member.active AND task.owner_id=$2
    AND task.contact_id IS NOT DISTINCT FROM $3::uuid
    AND task.status='failed' AND task.task_type='layered_memory'`,
 [roundId,scope.ownerId,scope.contactId])).rows;
 for(const task of profileTasks){
  if(await profileOnlyRecoveryAllowed(c,scope,task.id))return true;
 }
 return false;
}
export class MemoryProcessingControl {
 private readonly pool:pg.Pool;private readonly ownerId:string;private readonly tasks:TaskControlPort;private readonly unconfirmed?:MemoryProcessingUnconfirmed;
 constructor(pool:pg.Pool,ownerId:string,tasks:TaskControlPort,unconfirmed?:MemoryProcessingUnconfirmed){this.pool=pool;this.ownerId=ownerId;this.tasks=tasks;this.unconfirmed=unconfirmed;}
 async handle(method:string,url:URL,body:unknown):Promise<{status:number;body:unknown}|null>{
  const match=url.pathname.match(/^\/api\/(?:contacts\/([^/]+)|owner)\/memory-processing\/(pause|continue)$/);
  if(!match)return null;
  if(method!=='POST')return {status:405,body:{error:'memory_processing_method_not_allowed'}};
  const contactId=match[1]?.toLowerCase()??null,action=match[2] as 'pause'|'continue',data=body as Record<string,unknown>;
  const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if(url.search||contactId!==null&&!uuid.test(contactId)||!data||typeof data!=='object'||Array.isArray(data)
   ||Object.keys(data).sort().join()!=='action_version,operation_id'||!Number.isSafeInteger(data.action_version)||Number(data.action_version)<0
   ||typeof data.operation_id!=='string'||!uuid.test(data.operation_id))return {status:400,body:{error:'memory_processing_request_invalid'}};
  const scope={ownerId:this.ownerId,contactId};let c:pg.PoolClient;
  try{c=await this.pool.connect();}catch{return {status:503,body:{error:'memory_processing_unavailable'}};}
  let taskIds:string[]=[];let cancelledLeases:{id:string;lease:TaskExecutionLease}[]=[];
  try{
   await c.query('BEGIN');
   if(contactId!==null)await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${this.ownerId}:${contactId}`]);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${this.ownerId}`]);
   const exists=contactId===null?await c.query('SELECT 1 FROM owner WHERE id=$1',[this.ownerId]):await c.query('SELECT 1 FROM contact WHERE owner_id=$1 AND id=$2',[this.ownerId,contactId]);
   if(!exists.rowCount)throw new MemoryProcessingControlError('memory_processing_not_found',404);
   await c.query('INSERT INTO memory_processing_scope(owner_id,contact_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[this.ownerId,contactId]);
   const current=(await c.query('SELECT * FROM memory_processing_scope WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid FOR UPDATE',[this.ownerId,contactId])).rows[0];
   const previous=(await c.query('SELECT * FROM memory_processing_operation WHERE scope_id=$1 AND operation_id=$2',[current.id,data.operation_id])).rows[0];
   let generation:number;
   if(previous){
    if(previous.action!==action||Number(previous.action_version)!==data.action_version)throw new MemoryProcessingControlError();
    generation=Number(previous.accepted_generation);
   }else{
    if(Number(current.control_generation)!==data.action_version)throw new MemoryProcessingControlError();
    if(action==='continue'&&(current.intent!=='pause'&&!await memoryHasInterruptedWork(c,scope,current.active_round_id)||await memoryContinueBlocker(c,scope,current.active_round_id,this.unconfirmed)!==null))throw new MemoryProcessingControlError('memory_processing_continue_unsafe');
    if(action==='pause'&&current.intent==='pause')throw new MemoryProcessingControlError();
    generation=Number(current.control_generation)+1;
    if(!Number.isSafeInteger(generation))throw new MemoryProcessingControlError('memory_processing_unavailable',503);
    await c.query('UPDATE memory_processing_scope SET intent=$2,control_generation=$3,updated_at=clock_timestamp() WHERE id=$1',[current.id,action==='pause'?'pause':'run',generation]);
    taskIds=(await c.query(`SELECT id FROM background_task WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
     AND task_type IN ('import','observation','layered_memory') AND status IN ('queued','running','verifying')`,[this.ownerId,contactId])).rows.map(row=>row.id);
    if(action==='pause'){
     cancelledLeases=(await c.query("SELECT task_id AS id,id AS step_id,lease_generation FROM background_task_step WHERE task_id=ANY($1::uuid[]) AND status='running'",[taskIds])).rows.map(row=>({id:row.id,lease:{stepId:row.step_id,leaseGeneration:Number(row.lease_generation)}}));
     await c.query("UPDATE layered_profile_batch SET lease_expires_at=clock_timestamp() WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND status='running'",[this.ownerId,contactId]);
     await c.query(`UPDATE background_task_step SET status='pending',worker_id=NULL,lease_expires_at=NULL,
      lease_generation=lease_generation+1,updated_at=clock_timestamp() WHERE task_id=ANY($1::uuid[]) AND status='running'`,[taskIds]);
     await c.query("UPDATE background_task SET status='queued',updated_at=clock_timestamp() WHERE id=ANY($1::uuid[]) AND status IN ('running','verifying')",[taskIds]);
    }else{
     // 只修复已明确允许的未完成阶段；不调用会加额或重置尝试次数的旧 resume。
     await resumeProfileOnlyRecovery(c,scope,current.active_round_id);
     await c.query(`UPDATE background_task_step step SET status='pending',worker_id=NULL,lease_expires_at=NULL,
      lease_generation=lease_generation+1,last_error_code=NULL,updated_at=clock_timestamp() FROM memory_processing_round_task member
      WHERE member.round_id=$1 AND member.active AND member.task_id=step.task_id AND (step.status IN ('failed','retryable') OR step.status='running' AND step.lease_expires_at<=clock_timestamp())`,[current.active_round_id]);
     await c.query(`UPDATE background_task t SET status='queued',last_error_code=NULL,finished_at=NULL,updated_at=clock_timestamp()
      FROM memory_processing_round_task member WHERE member.round_id=$1 AND member.active AND member.task_id=t.id AND t.status IN ('failed','running','verifying')`,[current.active_round_id]);
     taskIds=(await c.query(`SELECT t.id FROM background_task t JOIN memory_processing_round_task member ON member.task_id=t.id
      WHERE member.round_id=$1 AND member.active AND t.owner_id=$2 AND t.contact_id IS NOT DISTINCT FROM $3::uuid AND t.status='queued'`,[current.active_round_id,this.ownerId,contactId])).rows.map(row=>row.id);
     await c.query('UPDATE memory_processing_round SET control_generation=$2,status=CASE WHEN status=\'blocked\' THEN \'waiting\' ELSE status END WHERE id=$1',[current.active_round_id,generation]);
    }
    await c.query('INSERT INTO memory_processing_operation(scope_id,operation_id,action,action_version,accepted_generation) VALUES($1,$2,$3,$4,$5)',[current.id,data.operation_id,action,data.action_version,generation]);
   }
   await c.query('COMMIT');
   // 接纳事实先于尽力取消与唤醒；调度失败也不撤销持久意图。
   if(!previous)await Promise.allSettled(action==='pause'?cancelledLeases.map(lease=>this.tasks.stop?.(scope,lease.id,lease.lease)):taskIds.map(id=>this.tasks.wake(scope,id)));
   return {status:200,body:{accepted:true,operation_id:data.operation_id,action,action_version:generation,control_generation:generation,replayed:Boolean(previous)}};
  }catch(error){await c.query('ROLLBACK').catch(()=>{});return error instanceof MemoryProcessingControlError?{status:error.status,body:{error:error.code}}:{status:503,body:{error:'memory_processing_unavailable'}};}
  finally{c.release();}
 }
}
