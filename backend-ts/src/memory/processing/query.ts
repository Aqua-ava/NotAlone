/** 统一记忆处理的只读边界；查询不建轮次、不唤醒任务，也不授予执行资格。 */
import type pg from 'pg';
import {memoryContinueBlocker,memoryHasInterruptedWork,type MemoryProcessingUnconfirmed} from './control.ts';
import {processingReason} from './reason.ts';
import {historyCursor,readProcessingHistory} from './history.ts';
import {pendingProcessingTargetCount} from './round.ts';

function safeCount(value:string|number){const count=Number(value);if(!Number.isSafeInteger(count)||count<0)throw Error('processing_count_unavailable');return count;}

type Phase='extraction'|'verification'|'topics'|'profile'|'retry';
type Status='waiting'|'processing'|'completed'|'paused'|'blocked';
interface Task extends pg.QueryResultRow {
 id:string;contact_id:string|null;task_type:string;status:string;current_step:string;last_error_code:string|null;
 updated_at:Date;live:boolean;planned:boolean;processed:number;total:number;round_id:string|null;
 step_processed:number|null;step_total:number|null;
 profile_stage:boolean;
}
interface Scope extends pg.QueryResultRow {
 id:string;control_generation:string;intent:'run'|'pause';active_round_id:string|null;
 round_status:Status|null;round_generation:string|null;phase:Phase|null;
 round_target_unit:'messages'|'memories'|'steps'|null;round_target_count:string|null;
}
export class MemoryProcessingQuery {
 private readonly pool:pg.Pool;private readonly ownerId:string;private readonly unconfirmed?:MemoryProcessingUnconfirmed;
 constructor(pool:pg.Pool,ownerId:string,unconfirmed?:MemoryProcessingUnconfirmed){this.pool=pool;this.ownerId=ownerId;this.unconfirmed=unconfirmed;}
 async handle(method:string,url:URL):Promise<{status:number;body:unknown}|null>{
  const match=url.pathname.match(/^\/api\/(?:contacts\/([^/]+)|owner)\/memory-processing\/(state|history)$/);
  if(!match)return null;
  if(method!=='GET')return {status:405,body:{error:'memory_processing_method_not_allowed'}};
  const contactId=match[1]?.toLowerCase()??null;
  if(contactId!==null&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(contactId)
   ||(match[2]==='state'?Boolean(url.search):[...url.searchParams.keys()].some(key=>key!=='cursor')||url.searchParams.getAll('cursor').length>1))return {status:400,body:{error:'memory_processing_request_invalid'}};
  let cursor;
  try{cursor=historyCursor(url.searchParams.get('cursor'),this.ownerId,contactId);}
  catch{return {status:400,body:{error:'memory_processing_request_invalid'}};}
  let c:pg.PoolClient|undefined;
  try{
   c=await this.pool.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const exists=contactId===null?await c.query('SELECT 1 FROM owner WHERE id=$1',[this.ownerId]):await c.query('SELECT 1 FROM contact WHERE owner_id=$1 AND id=$2',[this.ownerId,contactId]);
   if(!exists.rowCount)return {status:404,body:{error:'memory_processing_not_found'}};
   if(match[2]==='history')return {status:200,body:{scope:contactId===null?'owner':'contact',contact_id:contactId,...await readProcessingHistory(c,this.ownerId,contactId,cursor)}};
   const scope=(await c.query<Scope>(`SELECT s.*,r.status AS round_status,r.control_generation AS round_generation,r.phase,
    r.target_unit AS round_target_unit,r.target_count AS round_target_count
    FROM memory_processing_scope s LEFT JOIN memory_processing_round r ON r.id=s.active_round_id AND r.scope_id=s.id
    WHERE s.owner_id=$1 AND s.contact_id IS NOT DISTINCT FROM $2::uuid`,[this.ownerId,contactId])).rows[0];
   let tasks=scope?.active_round_id?(await c.query<Task>(`SELECT t.*,membership.round_id,
    EXISTS(SELECT 1 FROM background_task_step step WHERE step.task_id=t.id AND step.status='running' AND step.lease_expires_at>clock_timestamp()) AS live,
    plan.task_id IS NOT NULL AS planned,
    CASE WHEN EXISTS(
      SELECT 1 FROM memory_processing_round_target snapshot
      WHERE snapshot.round_id=membership.round_id
    ) THEN (
      SELECT count(*)::int FROM memory_processing_round_target snapshot
      WHERE snapshot.round_id=membership.round_id AND snapshot.task_id=t.id
    ) ELSE (
      SELECT count(*)::int FROM memory_processing_target target WHERE target.task_id=t.id
    ) END AS total,
    CASE WHEN EXISTS(
      SELECT 1 FROM memory_processing_round_target snapshot
      WHERE snapshot.round_id=membership.round_id
    ) THEN (
      SELECT count(*)::int FROM memory_processing_round_target snapshot
      JOIN memory_processing_target target
        ON target.task_id=snapshot.task_id AND target.message_id=snapshot.message_id
      WHERE snapshot.round_id=membership.round_id AND snapshot.task_id=t.id
        AND target.completed_at IS NOT NULL
    ) ELSE (
      SELECT count(*)::int FROM memory_processing_target target
      WHERE target.task_id=t.id AND target.completed_at IS NOT NULL
    ) END AS processed,
    (SELECT processed_count::int FROM background_task_step step WHERE step.task_id=t.id ORDER BY step.step_order LIMIT 1) AS step_processed,
    (SELECT total_count::int FROM background_task_step step WHERE step.task_id=t.id ORDER BY step.step_order LIMIT 1) AS step_total,
    EXISTS(SELECT 1 FROM layered_profile_batch profile WHERE profile.task_id=t.id
      AND profile.status='running' AND profile.lease_expires_at>clock_timestamp()) AS profile_stage
    FROM memory_processing_round_task membership JOIN background_task t ON t.id=membership.task_id
    LEFT JOIN memory_processing_plan plan ON plan.task_id=t.id
    WHERE membership.active AND membership.round_id=$1 AND membership.owner_id=$2 AND membership.contact_id IS NOT DISTINCT FROM $3::uuid
    ORDER BY t.updated_at DESC,t.id`,[scope.active_round_id,this.ownerId,contactId])).rows:[];
   if(!scope?.active_round_id){
    tasks=(await c.query<Task>(`SELECT DISTINCT ON (CASE WHEN t.task_type IN ('import','observation') THEN 'extraction' ELSE 'organization' END) t.*,NULL::uuid AS round_id,
     EXISTS(SELECT 1 FROM background_task_step step WHERE step.task_id=t.id AND step.status='running' AND step.lease_expires_at>clock_timestamp()) AS live,
     false AS planned,0 AS processed,0 AS total,
    (SELECT processed_count::int FROM background_task_step step WHERE step.task_id=t.id ORDER BY step.step_order LIMIT 1) AS step_processed,
    (SELECT total_count::int FROM background_task_step step WHERE step.task_id=t.id ORDER BY step.step_order LIMIT 1) AS step_total,
    false AS profile_stage
     FROM background_task t WHERE t.owner_id=$1 AND t.contact_id IS NOT DISTINCT FROM $2::uuid
      AND t.task_type IN ('import','observation','layered_memory')
     ORDER BY (CASE WHEN t.task_type IN ('import','observation') THEN 'extraction' ELSE 'organization' END),t.updated_at DESC,t.id DESC`,[this.ownerId,contactId])).rows;
   }
   const pendingObservation=contactId===null?0:safeCount((await c.query(`SELECT count(*)::int AS n FROM memory_extraction_receipt receipt
    JOIN local_wechat_observation observation ON observation.id=receipt.observation_id AND observation.owner_id=receipt.owner_id AND observation.contact_id=receipt.contact_id
    JOIN conversation_binding binding ON binding.id=observation.binding_id AND binding.owner_id=observation.owner_id AND binding.contact_id=observation.contact_id
    WHERE receipt.owner_id=$1 AND receipt.contact_id=$2 AND receipt.task_id IS NULL AND binding.status='active'
    AND EXISTS(SELECT 1 FROM message_source_ref ref WHERE ref.message_id=receipt.message_id AND ref.observation_id=observation.id)`,[this.ownerId,contactId])).rows[0].n);
   const pendingTarget=await pendingProcessingTargetCount(c,{ownerId:this.ownerId,contactId});
   const pending=pendingObservation+pendingTarget;
   const pendingWork=Boolean(scope?.active_round_id&&(await c.query(`SELECT 1
    FROM background_task task
    JOIN memory_processing_scope control
      ON control.owner_id=task.owner_id
      AND control.contact_id IS NOT DISTINCT FROM task.contact_id
    WHERE task.owner_id=$1 AND task.contact_id IS NOT DISTINCT FROM $2::uuid
      AND task.task_type='layered_memory'
      AND task.status IN ('queued','running','verifying')
      AND NOT EXISTS(
        SELECT 1 FROM memory_processing_round_task membership
        WHERE membership.round_id=control.active_round_id
          AND membership.task_id=task.id AND membership.active
      )
    LIMIT 1`,[this.ownerId,contactId])).rowCount);
   const usable=contactId===null?(await c.query("SELECT 1 FROM owner_memory WHERE owner_id=$1 AND status='active' LIMIT 1",[this.ownerId])).rowCount:
    (await c.query("SELECT 1 FROM confirmed_memory WHERE owner_id=$1 AND contact_id=$2 AND status='active' LIMIT 1",[this.ownerId,contactId])).rowCount;
   const failed=tasks.find(task=>['failed','cancelled','paused'].includes(task.status));
   const live=tasks.find(task=>task.live&&['running','verifying'].includes(task.status));
   let status:Status='waiting',reason:string|null=null,code:string|null=failed?.last_error_code??null;
   if(scope?.intent==='pause'){status='paused';reason=failed?`你已暂停记忆处理；${processingReason(code)}`:'你已暂停记忆处理，已有结果保留。';}
   else if(!scope?.active_round_id&&tasks.length){
    status='blocked';reason=`旧处理记录尚未建立可验证的轮次归属，请查看详情核对；不会自动继续。${failed?processingReason(code):''}`;code??='legacy_attribution_unverified';
   }else if(failed||scope?.round_status==='blocked'||scope?.round_generation!==undefined&&scope.round_generation!==null&&scope.round_generation!==scope.control_generation){
    status='blocked';reason=processingReason(code);code??='processing_requires_repair';
   }else if(live)status='processing';
   else if(scope?.round_status==='completed'&&pending===0&&!pendingWork&&tasks.every(task=>task.status==='succeeded'))status='completed';
   else if(scope?.round_status==='completed'&&(pending>0||pendingWork)){status='waiting';reason='后续资料等待新一轮处理。';}
   // 步骤切换时旧租约已经释放、下一步尚未领取，不能把这一瞬态宣称为业务受阻。
   else if(scope?.round_status==='processing'&&!tasks.some(task=>task.status==='queued')){status='waiting';reason='等待下一步处理。';}
   else if(!scope?.active_round_id&&pending===0)reason='暂无待处理资料。';
   const progress=live??failed??tasks.find(task=>task.planned)??tasks[0];
   const plannedProgress=tasks.find(task=>task.planned);
   const reliable=plannedProgress
    ? {processed:plannedProgress.processed,total:plannedProgress.total,unit:'messages' as const}
    : scope?.round_target_count!==null&&scope?.round_target_count!==undefined
      ? {processed:progress?.step_processed??0,total:safeCount(scope.round_target_count),
        unit:scope.round_target_unit}
      : null;
   const phase=tasks.some(task=>task.live&&task.profile_stage)?'profile':scope?.phase??null;
   await c.query('SAVEPOINT memory_processing_history_read');
   let history;
   try{history=await readProcessingHistory(c,this.ownerId,contactId,null);await c.query('RELEASE SAVEPOINT memory_processing_history_read');}
   catch{await c.query('ROLLBACK TO SAVEPOINT memory_processing_history_read');history={entries:[],next_cursor:null,error:'处理历史暂不可用，请刷新重试。'};}
   const blocker=scope&&(scope.intent==='pause'||status==='blocked')?await memoryContinueBlocker(c,{ownerId:this.ownerId,contactId},scope.active_round_id,this.unconfirmed):null;
   const actions=scope?.intent==='pause'?(blocker===null?['continue']:[]):
    status==='blocked'&&blocker===null&&scope?.active_round_id&&await memoryHasInterruptedWork(c,{ownerId:this.ownerId,contactId},scope.active_round_id)?['pause','continue']:['pause'];
   if(scope?.intent==='pause'&&blocker&&!code){code=blocker;reason=`你已暂停记忆处理；${processingReason(code)}`;}
   return {status:200,body:{action_version:safeCount(scope?.control_generation??0),scope:contactId===null?'owner':'contact',contact_id:contactId,control_generation:safeCount(scope?.control_generation??0),
    current:{status,round_id:scope?.active_round_id??null,phase,
     processed_count:reliable?.processed??null,total_count:reliable?.total??null,unit:reliable?.unit??null,
     pending_count:pending,reason,reason_code:code,has_usable_results:Boolean(usable),actions},history}};
  }catch{return {status:503,body:{error:'memory_processing_unavailable'}};}
  finally{if(c){await c.query('ROLLBACK').catch(()=>{});c.release();}}
 }
}
