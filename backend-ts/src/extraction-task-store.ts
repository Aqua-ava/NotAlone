/** 原后台任务表的确定性持久层；生命周期由宿主 effect 持有，不创建 DSH 私有任务。 */
import type pg from 'pg';
import {extractionTargets,extractionCheckpoint,extractionProgress,type ExtractionTargets} from './extraction-task-store-processing.ts';
import {unsettledExtraction,blockedExtraction,quarantineExtraction} from './extraction-task-store-recovery.ts';
import {recordExtractionObservation,claimExtractionSchedule,enqueueExtractionObservation} from './extraction-task-store-schedule.ts';
export interface ExtractionScope {ownerId:string;contactId:string;}
export interface ExtractionClaim extends ExtractionScope {
 taskId:string;stepId:string;stepName:string;workerId:string;leaseGeneration:number;
 attemptCount:number;messageCount:number;sourceDocumentId:string|null;taskType:'import'|'observation';
 leaseExpiresAt:Date;runtimeConfig:Record<string,unknown>|null;
}
export interface ExtractionStoreOptions {
 unconfirmedRequests?:(scope:ExtractionScope)=>Promise<readonly string[]>|readonly string[];
 processingState?:(scope:ExtractionScope,taskId:string)=>'active'|'queued'|null;
}
export class ExtractionTaskError extends Error {
 readonly code:string;constructor(code:string){super(code);this.code=code;}
}
export const sourceAllowed=`((t.task_type='import' AND EXISTS(SELECT 1 FROM source_document d
 WHERE d.id=t.source_document_id AND d.owner_id=t.owner_id AND d.contact_id=t.contact_id AND d.status='active'))
 OR (t.task_type='observation' AND EXISTS(SELECT 1 FROM conversation_binding b
 WHERE b.owner_id=t.owner_id AND b.contact_id=t.contact_id AND b.status='active')))`;
export const processingSourceAllowed=`(${sourceAllowed} AND (t.task_type='import' OR EXISTS(SELECT 1 FROM local_wechat_observation o
 JOIN conversation_binding b ON b.id=o.binding_id AND b.owner_id=o.owner_id AND b.contact_id=o.contact_id
 WHERE o.owner_id=t.owner_id AND o.contact_id=t.contact_id AND b.status='active' AND o.memory_enqueued_at IS NOT NULL)))`;
export async function lockExtractionScope(c:pg.ClientBase,scope:ExtractionScope):Promise<void>{
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${scope.ownerId}:${scope.contactId}`]);
}
export class ExtractionTaskStore {
 readonly pool:pg.Pool;readonly options:ExtractionStoreOptions;
 constructor(pool:pg.Pool,options:ExtractionStoreOptions={}){this.pool=pool;this.options=options;}
 targets(claim:ExtractionClaim):Promise<ExtractionTargets>{return extractionTargets(this,claim);}
 checkpoint(c:pg.ClientBase,claim:ExtractionClaim,ids:readonly string[],outcome:'succeeded'|'skipped'|'unknown'):Promise<void>{return extractionCheckpoint(this,c,claim,ids,outcome);}
 progress(scope:ExtractionScope,taskId?:string){return extractionProgress(this,scope,taskId);}
 recordObservation(c:pg.ClientBase,scope:ExtractionScope,observationId:string,ids:readonly string[]){return recordExtractionObservation(c,scope,observationId,ids);}
 claimScheduled(scope:ExtractionScope){return this.transaction(scope,c=>claimExtractionSchedule(c,scope));}
 enqueueObservation(scope:ExtractionScope,ids:readonly string[]){return enqueueExtractionObservation(this,scope,ids);}
 async transaction<T>(scope:ExtractionScope,work:(c:pg.PoolClient)=>Promise<T>):Promise<T>{
  const c=await this.pool.connect();try{await c.query('BEGIN');await lockExtractionScope(c,scope);const result=await work(c);await c.query('COMMIT');return result;}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 async enqueueImport(scope:ExtractionScope,sourceId:string,messageCount:number):Promise<string>{
  return this.transaction(scope,async c=>{
   const inserted=await c.query(`INSERT INTO background_task(owner_id,contact_id,source_document_id,task_type,status,current_step,message_count)
    VALUES($1,$2,$3,'import','queued','parse',$4) ON CONFLICT(owner_id,contact_id,source_document_id,task_type) DO NOTHING RETURNING id`,[scope.ownerId,scope.contactId,sourceId,messageCount]);
   const id=inserted.rows[0]?.id??(await c.query("SELECT id FROM background_task WHERE owner_id=$1 AND contact_id=$2 AND source_document_id=$3 AND task_type='import' FOR UPDATE",[scope.ownerId,scope.contactId,sourceId])).rows[0]?.id;
   if(!id)throw new ExtractionTaskError('task_not_found');
   for(const [index,name] of ['parse','normalize','extract_memory','index','verify'].entries())await c.query(`INSERT INTO background_task_step(task_id,step_name,step_order,total_count) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[id,name,index+1,messageCount]);
   return id;
  });
 }
 async claim(scope:ExtractionScope,input:{taskId?:string;workerId:string;leaseMs:number;supportedSteps?:string[];runtimeRuleSetSha256?:string}):Promise<ExtractionClaim|null>{
  if(!Number.isFinite(input.leaseMs)||input.leaseMs<=0)throw new ExtractionTaskError('lease_duration_invalid');
  return this.transaction(scope,async c=>{
   const unsettled=await unsettledExtraction(this,c,scope);
   const expired=(await c.query(`SELECT t.id,s.id AS step_id FROM background_task t JOIN background_task_step s ON s.task_id=t.id
    WHERE t.owner_id=$1 AND t.contact_id=$2 AND s.step_name='extract_memory' AND s.status='running' AND s.lease_expires_at<=now()`,[scope.ownerId,scope.contactId])).rows;
   for(const row of expired){
    await quarantineExtraction(c,scope,row.id,unsettled.windows.get(row.id)??new Set());
    if(await blockedExtraction(c,unsettled,row.id,false))await this.markUnknown(c,row.id,row.step_id);
   }
   // 只恢复本票负责的提取步骤；其他业务 Worker 的租约不得顺带重排。
   await c.query(`UPDATE background_task_step s SET status=CASE WHEN attempt_count>=3 THEN 'failed' ELSE 'retryable' END,
    worker_id=NULL,lease_expires_at=NULL,last_error_code='lease_expired',updated_at=now()
    FROM background_task t WHERE t.id=s.task_id AND t.owner_id=$1 AND t.contact_id=$2
    AND s.step_name='extract_memory' AND s.status='running' AND s.lease_expires_at<=now()`,[scope.ownerId,scope.contactId]);
   await c.query(`UPDATE background_task t SET status='failed',last_error_code='lease_expired',finished_at=now(),updated_at=now()
    WHERE t.owner_id=$1 AND t.contact_id=$2 AND t.status IN ('queued','running','verifying')
    AND EXISTS(SELECT 1 FROM background_task_step s WHERE s.task_id=t.id AND s.step_name='extract_memory' AND s.status='failed' AND s.last_error_code='lease_expired')`,[scope.ownerId,scope.contactId]);
   if((await c.query(`SELECT 1 FROM background_task t JOIN background_task_step s ON s.task_id=t.id
    WHERE t.owner_id=$1 AND t.contact_id=$2 AND s.status='running' AND s.lease_expires_at>now() LIMIT 1`,[scope.ownerId,scope.contactId])).rowCount)return null;
   const blocked=[...unsettled.direct];
   for(const task of unsettled.windows.keys())if(await blockedExtraction(c,unsettled,task,true))blocked.push(task);
   const row=(await c.query(`SELECT t.id AS task_id,t.*,s.id AS step_id,s.step_name,s.attempt_count,s.lease_generation
    FROM background_task t JOIN background_task_step s ON s.task_id=t.id WHERE t.owner_id=$1 AND t.contact_id=$2
    AND t.task_type IN ('import','observation') AND ${sourceAllowed} AND t.status IN ('queued','running','verifying')
    AND ($3::uuid IS NULL OR t.id=$3) AND s.step_name=ANY($4::text[]) AND s.status IN ('pending','retryable')
    AND NOT(t.id=ANY($5::uuid[]))
    AND (s.status='pending' OR s.attempt_count<3)
    AND NOT EXISTS(SELECT 1 FROM background_task_step p WHERE p.task_id=t.id AND p.step_order<s.step_order AND p.status<>'succeeded')
    ORDER BY t.created_at,t.id,s.step_order LIMIT 1 FOR UPDATE OF t,s`,[scope.ownerId,scope.contactId,input.taskId??null,input.supportedSteps??['extract_memory'],blocked])).rows[0];
   if(!row)return null;
   if(await blockedExtraction(c,unsettled,row.task_id,true))return null;
   if(row.step_name==='extract_memory'&&row.extraction_runtime_config){
    const config=row.extraction_runtime_config;
    if(Object.keys(config).sort().join(',')!=='mode,rule_set_sha256,version'||config.version!==1
     ||!['legacy','bounded-runtime-v1'].includes(config.mode)
     ||(config.mode==='legacy'?config.rule_set_sha256!==null:!(/^[a-f0-9]{64}$/.test(config.rule_set_sha256))))throw new ExtractionTaskError('extraction_runtime_config_invalid');
    if(config.mode==='bounded-runtime-v1'&&config.rule_set_sha256!==input.runtimeRuleSetSha256)throw new ExtractionTaskError('extraction_runtime_rule_unavailable');
    const supported=(await c.query(`SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='background_task'::regclass
     AND conname='background_task_extraction_runtime_config_check' AND contype='c' AND convalidated) AS config,
     NOT EXISTS(SELECT 1 FROM (VALUES ('memory_candidate'),('confirmed_memory'),('owner_memory')) needed(name)
      WHERE NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.'||needed.name) AND a.attname='source_dependency_mode'
       AND NOT a.attisdropped AND a.attnotnull AND a.atttypid='text'::regtype)
      OR NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=to_regclass('public.'||needed.name)
       AND k.conname=needed.name||'_source_dependency_mode_check' AND k.contype='c' AND k.convalidated))
     AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='memory_candidate'::regclass AND conname='memory_candidate_dimension_evidence_version4_check' AND contype='c' AND convalidated)
     AND to_regprocedure('public.notalone_semantic_basis_v3_valid(jsonb)') IS NOT NULL
     AND to_regprocedure('public.notalone_dimension_evidence_v4_shape(jsonb,integer)') IS NOT NULL AS bounded`)).rows[0];
    if(!supported.config||config.mode==='bounded-runtime-v1'&&!supported.bounded)throw new ExtractionTaskError('extraction_runtime_schema_unavailable');
   }
   const lease=(await c.query(`UPDATE background_task_step SET status='running',attempt_count=attempt_count+1,
    lease_generation=lease_generation+1,worker_id=$2,lease_expires_at=now()+$3*interval '1 millisecond',last_error_code=NULL,
    started_at=COALESCE(started_at,now()),updated_at=now() WHERE id=$1 RETURNING lease_expires_at,lease_generation,attempt_count`,[row.step_id,input.workerId,input.leaseMs])).rows[0];
   await c.query("UPDATE background_task SET status=$2,current_step=$3,last_error_code=NULL,started_at=COALESCE(started_at,clock_timestamp()),updated_at=now() WHERE id=$1",[row.task_id,row.step_name==='verify'?'verifying':'running',row.step_name]);
   return {...scope,taskId:row.task_id,stepId:row.step_id,stepName:row.step_name,workerId:input.workerId,leaseGeneration:Number(lease.lease_generation),
    attemptCount:lease.attempt_count,messageCount:row.message_count,sourceDocumentId:row.source_document_id,taskType:row.task_type,
    leaseExpiresAt:lease.lease_expires_at,runtimeConfig:row.extraction_runtime_config??null};
  });
 }
 async markUnknown(c:pg.ClientBase,taskId:string,stepId:string):Promise<void>{
  await c.query("UPDATE background_task_step SET status='failed',worker_id=NULL,lease_expires_at=NULL,last_error_code='model_call_outcome_unknown',updated_at=now() WHERE id=$1",[stepId]);
  await c.query("UPDATE background_task SET status='failed',last_error_code='model_call_outcome_unknown',finished_at=now(),updated_at=now() WHERE id=$1",[taskId]);
 }
 async fail(claim:ExtractionClaim,errorCode:string,retryable:boolean):Promise<'failed'|'retryable'>{
  if(!/^[a-zA-Z0-9_]{1,64}$/.test(errorCode))throw new ExtractionTaskError('task_error_code_invalid');
  return this.transaction(claim,async c=>{
   await this.assertLease(c,claim);const unsettled=await unsettledExtraction(this,c,claim);
   if(await blockedExtraction(c,unsettled,claim.taskId,false)){
    await quarantineExtraction(c,claim,claim.taskId,unsettled.windows.get(claim.taskId)??new Set());
    await this.markUnknown(c,claim.taskId,claim.stepId);return 'failed';
   }
   const status=retryable&&claim.attemptCount<3?'retryable':'failed';
   await c.query("UPDATE background_task_step SET status=$2,worker_id=NULL,lease_expires_at=NULL,last_error_code=$3,updated_at=now() WHERE id=$1",[claim.stepId,status,errorCode]);
   await c.query("UPDATE background_task SET status=$2,retry_count=retry_count+1,last_error_code=$3,finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1",[claim.taskId,status==='failed'?'failed':'running',errorCode]);
   return status;
  });
 }
 async pause(claim:ExtractionClaim):Promise<boolean>{
  return this.transaction(claim,async c=>{
   await this.assertLease(c,claim);const unsettled=await unsettledExtraction(this,c,claim);
   if(await blockedExtraction(c,unsettled,claim.taskId,false)){
    await quarantineExtraction(c,claim,claim.taskId,unsettled.windows.get(claim.taskId)??new Set());await this.markUnknown(c,claim.taskId,claim.stepId);return false;
   }
   // 与原Worker一致：返还一次尝试，租约到期或显式恢复后才允许新执行者领取。
   return Boolean((await c.query("UPDATE background_task_step SET attempt_count=attempt_count-1,updated_at=now() WHERE id=$1 AND attempt_count>0",[claim.stepId])).rowCount);
  });
 }
 async complete(claim:ExtractionClaim,processedCount:number,totalCount?:number):Promise<void>{
  if(!Number.isSafeInteger(processedCount)||processedCount<0||totalCount!==undefined&&(!Number.isSafeInteger(totalCount)||totalCount<0))throw new ExtractionTaskError('task_count_invalid');
  await this.transaction(claim,async c=>{
   await this.assertLease(c,claim);
   await c.query(`UPDATE background_task_step SET status='succeeded',processed_count=$2,total_count=COALESCE($3,total_count),
    worker_id=NULL,lease_expires_at=NULL,finished_at=now(),updated_at=now() WHERE id=$1`,[claim.stepId,processedCount,totalCount??null]);
   const next=(await c.query("SELECT step_name FROM background_task_step WHERE task_id=$1 AND status<>'succeeded' ORDER BY step_order LIMIT 1",[claim.taskId])).rows[0];
   if(next){await c.query("UPDATE background_task SET status=$2,current_step=$3,updated_at=now() WHERE id=$1",[claim.taskId,next.step_name==='verify'?'verifying':'running',next.step_name]);return;}
   if(claim.stepName!=='verify')throw new ExtractionTaskError('task_verify_missing');
   const task=(await c.query('SELECT task_type,observation_pending FROM background_task WHERE id=$1 FOR UPDATE',[claim.taskId])).rows[0];
   const requeue=task.task_type==='observation'&&task.observation_pending;
   if(requeue)await c.query(`UPDATE background_task_step SET status='pending',attempt_count=0,processed_count=0,worker_id=NULL,
    lease_expires_at=NULL,last_error_code=NULL,started_at=NULL,finished_at=NULL,updated_at=now() WHERE task_id=$1`,[claim.taskId]);
   await c.query(`UPDATE background_task SET status=$2,current_step=$3,observation_pending=false,last_error_code=NULL,
    started_at=CASE WHEN $4 THEN NULL ELSE started_at END,finished_at=CASE WHEN $4 THEN NULL ELSE now() END,updated_at=now() WHERE id=$1`,[claim.taskId,requeue?'queued':'succeeded',requeue?'extract_memory':claim.stepName,requeue]);
  });
 }
 async assertLease(c:pg.ClientBase,claim:ExtractionClaim):Promise<void>{
  const result=await c.query(`SELECT 1 FROM background_task t JOIN background_task_step s ON s.task_id=t.id
   WHERE t.id=$1 AND t.owner_id=$2 AND t.contact_id=$3 AND s.id=$4 AND s.worker_id=$5 AND s.lease_generation=$6
   AND s.step_name=$7 AND s.status='running' AND s.lease_expires_at>clock_timestamp()
   AND t.status IN ('queued','running','verifying') AND ${sourceAllowed} FOR UPDATE OF t,s`,
   [claim.taskId,claim.ownerId,claim.contactId,claim.stepId,claim.workerId,claim.leaseGeneration,claim.stepName]);
  if(!result.rowCount)throw new ExtractionTaskError('lease_stale');
 }
 async check(claim:ExtractionClaim):Promise<void>{await this.transaction(claim,c=>this.assertLease(c,claim));}
 /** B段候选采纳、trace、checkpoint和水位由调用方放入同一事务，不持锁等模型。 */
 async fenced<T>(claim:ExtractionClaim,work:(c:pg.PoolClient)=>Promise<T>):Promise<T>{
  return this.transaction(claim,async c=>{await this.assertLease(c,claim);const result=await work(c);await this.assertLease(c,claim);return result;});
 }
 async renew(claim:ExtractionClaim,leaseMs:number):Promise<Date>{
  if(!Number.isFinite(leaseMs)||leaseMs<=0)throw new ExtractionTaskError('lease_duration_invalid');
  return this.transaction(claim,async c=>{await this.assertLease(c,claim);return(await c.query("UPDATE background_task_step SET lease_expires_at=clock_timestamp()+$2*interval '1 millisecond',updated_at=now() WHERE id=$1 RETURNING lease_expires_at",[claim.stepId,leaseMs])).rows[0].lease_expires_at;});
 }
 async resume(scope:ExtractionScope,taskId:string,action:'resume'|'restart'):Promise<{task_id:string;status:string}>{
  return this.transaction(scope,async c=>{
   const t=(await c.query(`SELECT t.*,${processingSourceAllowed} AS source_allowed FROM background_task t
    WHERE t.id=$1 AND t.owner_id=$2 AND t.contact_id=$3 AND t.task_type IN ('import','observation') FOR UPDATE`,[taskId,scope.ownerId,scope.contactId])).rows[0];
   if(!t)throw new ExtractionTaskError('task_not_found');if(!t.source_allowed)throw new ExtractionTaskError('source_unavailable');
   if(this.options.processingState?.(scope,taskId)||(await c.query("SELECT 1 FROM background_task_step WHERE task_id=$1 AND status='running' AND lease_expires_at>now()",[taskId])).rowCount)return {task_id:taskId,status:'busy'};
   if(t.status==='succeeded')return {task_id:taskId,status:'completed'};
   if((t.status==='cancelled')!==(action==='restart'))throw new ExtractionTaskError('resume_action_mismatch');
   await c.query(`UPDATE background_task_step SET status='pending',attempt_count=0,worker_id=NULL,lease_expires_at=NULL,
    lease_generation=lease_generation+1,last_error_code=NULL,finished_at=NULL,updated_at=now() WHERE task_id=$1 AND status<>'succeeded'`,[taskId]);
   const next=(await c.query("SELECT step_name FROM background_task_step WHERE task_id=$1 AND status<>'succeeded' ORDER BY step_order LIMIT 1",[taskId])).rows[0];
   if(!next)throw new ExtractionTaskError('task_no_remaining_step');
   await c.query("UPDATE background_task SET status='queued',current_step=$2,last_error_code=NULL,finished_at=NULL,retry_count=retry_count+1,updated_at=now() WHERE id=$1",[taskId,next.step_name]);
   return {task_id:taskId,status:'queued'};
  });
 }
 /** 会话锁必须贯穿整个Worker寿命；release只能在在途run全部退出后调用。 */
 async acquireWorker():Promise<{release:()=>Promise<void>}|null>{
  const c=await this.pool.connect();
  try{const result=await c.query("SELECT pg_try_advisory_lock(hashtextextended('notalone:global-worker',0)) AS held");
   if(!result.rows[0].held){c.release();return null;}
   let released=false;return {release:async()=>{if(released)return;released=true;let failed=false;
    try{await c.query("SELECT pg_advisory_unlock(hashtextextended('notalone:global-worker',0))");}
    catch(e){failed=true;throw e;}finally{c.release(failed);}}};
  }catch(e){c.release(true);throw e;}
 }
}
