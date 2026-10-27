import {memoryExecutionAllowed,memoryScopePaused} from '../../processing/control.ts';
/** 原后台任务表的确定性持久层；生命周期由宿主 effect 持有，不创建 DSH 私有任务。 */
import type pg from 'pg';
import {extractionTargets,extractionCheckpoint,extractionProgress,ownerExtractionProgress,type ExtractionTargets} from './store-processing.ts';
import {unsettledExtraction,blockedExtraction,quarantineExtraction} from './store-recovery.ts';
import {recordExtractionObservation,claimExtractionSchedule,enqueueExtractionObservation} from './store-schedule.ts';
import {completeL2ScenarioWorkerStep} from '../../scenarios/worker.ts';
import {
 blockMemoryProcessingRound,
 completeMemoryProcessingRoundIfReady,
 continueMemoryProcessingAfterExtraction,
 acceptTaskIntoProcessingRound,
 markRoundTaskProcessing,
 type MemoryProcessingOrganization,
} from '../../processing/round.ts';
import {assertExtractionPolicyWindow,resolveExtractionPolicy,validateExtractionRuntimeConfig,type ExtractionPolicyVersion,type CompleteClaimRuntimeConfig} from '../policy-version.ts';
export interface ExtractionScope {ownerId:string;contactId:string|null;}
export interface ExtractionClaim extends ExtractionScope {
 taskId:string;stepId:string;stepName:string;workerId:string;leaseGeneration:number;
 attemptCount:number;messageCount:number;sourceDocumentId:string|null;taskType:'import'|'observation'|'layered_memory'|'skill_learning';
 leaseExpiresAt:Date;runtimeConfig:Record<string,unknown>|null;
}
export interface ExtractionStoreOptions {
 policyVersion?:ExtractionPolicyVersion;
 verificationPolicy?:'complete-claim-v1';
 unconfirmedRequests?:(scope:ExtractionScope)=>Promise<readonly string[]>|readonly string[];
 processingState?:(scope:ExtractionScope,taskId:string)=>'active'|'queued'|null;
 organization?:MemoryProcessingOrganization;
}
export class ExtractionTaskError extends Error {
 readonly code:string;constructor(code:string){super(code);this.code=code;}
}
export const sourceAllowed=`((t.task_type='import' AND EXISTS(SELECT 1 FROM source_document d
 WHERE d.id=t.source_document_id AND d.owner_id=t.owner_id AND d.contact_id=t.contact_id AND d.status='active'))
 OR (t.task_type='observation' AND EXISTS(SELECT 1 FROM conversation_binding b
 WHERE b.owner_id=t.owner_id AND b.contact_id=t.contact_id AND b.status='active')))`;
export const skillLearningAllowed=`(t.task_type='skill_learning' AND EXISTS(
 SELECT 1 FROM public.skill_learning_scope setting JOIN public.conversation_binding binding
 ON binding.owner_id=setting.owner_id AND binding.contact_id=setting.contact_id AND binding.status='active'
 WHERE setting.owner_id=t.owner_id AND setting.contact_id=t.contact_id AND setting.enabled))`;
export const processingSourceAllowed=`(${sourceAllowed} AND (t.task_type='import' OR EXISTS(SELECT 1 FROM local_wechat_observation o
 JOIN conversation_binding b ON b.id=o.binding_id AND b.owner_id=o.owner_id AND b.contact_id=o.contact_id
 WHERE o.owner_id=t.owner_id AND o.contact_id=t.contact_id AND b.status='active' AND o.memory_enqueued_at IS NOT NULL)))`;
export async function lockExtractionScope(c:pg.ClientBase,scope:ExtractionScope):Promise<void>{
 const lock=scope.contactId===null?`owner:${scope.ownerId}`:`contact:${scope.ownerId}:${scope.contactId}`;
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lock]);
}
export class ExtractionTaskStore {
 readonly pool:pg.Pool;readonly options:ExtractionStoreOptions;
 constructor(pool:pg.Pool,options:ExtractionStoreOptions={}){
  if(options.verificationPolicy&&(!options.policyVersion||options.verificationPolicy!=='complete-claim-v1'))throw new ExtractionTaskError('extraction_policy_source_unavailable');
  this.pool=pool;this.options=options;
 }
 async newTaskSnapshot():Promise<CompleteClaimRuntimeConfig|null>{
  if(!this.options.verificationPolicy)return null;
  await this.options.policyVersion!.assertCurrent();return this.options.policyVersion!.newTaskConfig();
 }
 /** 由既有租约围栏内的 B 消费者读取权威配置；HTTP 的五字段 claim 不提供策略。 */
 async assertVerificationPolicy(c:pg.ClientBase,claim:ExtractionClaim,runtime:unknown,aRuleVersion:string):Promise<void>{
  const rows=(await c.query(`SELECT extraction_runtime_config FROM background_task
   WHERE id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`,
   [claim.taskId,claim.ownerId,claim.contactId])).rows;
  if(rows.length!==1)throw new ExtractionTaskError('lease_stale');
  const config=validateExtractionRuntimeConfig(rows[0].extraction_runtime_config);
  if(config?.version===2){
   if(!this.options.policyVersion)throw new ExtractionTaskError('extraction_policy_source_unavailable');
   await this.options.policyVersion.assertCurrent();
   assertExtractionPolicyWindow(this.options.policyVersion.resolve(config),runtime,aRuleVersion);
  }else assertExtractionPolicyWindow(resolveExtractionPolicy(config,aRuleVersion),runtime);
 }
 targets(claim:ExtractionClaim):Promise<ExtractionTargets>{return extractionTargets(this,claim);}
 checkpoint(c:pg.ClientBase,claim:ExtractionClaim,ids:readonly string[],outcome:'succeeded'|'skipped'|'unknown'):Promise<void>{return extractionCheckpoint(this,c,claim,ids,outcome);}
 progress(scope:ExtractionScope,taskId?:string){return extractionProgress(this,scope,taskId);}
 ownerProgress(ownerId:string,taskId?:string){return ownerExtractionProgress(this,ownerId,taskId);}
 recordObservation(c:pg.ClientBase,scope:ExtractionScope,observationId:string,ids:readonly string[]){return recordExtractionObservation(c,scope,observationId,ids);}
 claimScheduled(scope:ExtractionScope){return this.transaction(scope,async c=>claimExtractionSchedule(c,scope,await this.newTaskSnapshot()));}
 enqueueObservation(scope:ExtractionScope,ids:readonly string[]){return enqueueExtractionObservation(this,scope,ids);}
 async transaction<T>(scope:ExtractionScope,work:(c:pg.PoolClient)=>Promise<T>):Promise<T>{
  const c=await this.pool.connect();try{await c.query('BEGIN');await lockExtractionScope(c,scope);const result=await work(c);await c.query('COMMIT');return result;}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 async enqueueImport(scope:ExtractionScope,sourceId:string,messageCount:number):Promise<string>{
  const runtimeConfig=await this.newTaskSnapshot();
  return this.transaction(scope,async c=>{
   const inserted=await c.query(`INSERT INTO background_task(owner_id,contact_id,source_document_id,task_type,status,current_step,message_count,extraction_runtime_config)
    VALUES($1,$2,$3,'import','queued','parse',$4,$5::jsonb) ON CONFLICT(owner_id,contact_id,source_document_id,task_type) DO NOTHING RETURNING id`,[scope.ownerId,scope.contactId,sourceId,messageCount,runtimeConfig?JSON.stringify(runtimeConfig):null]);
   const id=inserted.rows[0]?.id??(await c.query("SELECT id FROM background_task WHERE owner_id=$1 AND contact_id=$2 AND source_document_id=$3 AND task_type='import' FOR UPDATE",[scope.ownerId,scope.contactId,sourceId])).rows[0]?.id;
   if(!id)throw new ExtractionTaskError('task_not_found');
   for(const [index,name] of ['parse','normalize','extract_memory','index','verify'].entries())await c.query(`INSERT INTO background_task_step(task_id,step_name,step_order,total_count) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[id,name,index+1,messageCount]);
   await c.query(`INSERT INTO memory_processing_plan(task_id,owner_id,contact_id)
    VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[id,scope.ownerId,scope.contactId]);
   await c.query(`INSERT INTO memory_processing_target(task_id,message_id,owner_id,contact_id)
    SELECT $1,m.id,m.owner_id,m.contact_id FROM message m
    JOIN message_source_ref ref ON ref.message_id=m.id AND ref.owner_id=m.owner_id
      AND ref.contact_id=m.contact_id AND ref.source_document_id=$4
    WHERE m.owner_id=$2 AND m.contact_id=$3
      AND m.speaker IN ('user','contact')
      AND length(btrim(COALESCE(NULLIF(m.text_content,''),m.media_placeholder,'')))>0
      AND EXISTS(SELECT 1 FROM source_document d WHERE d.id=$4 AND d.owner_id=$2
        AND d.contact_id=$3 AND d.status='active')
      AND m.occurred_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM memory_processing_receipt receipt
        WHERE receipt.message_id=m.id AND receipt.owner_id=m.owner_id AND receipt.contact_id=m.contact_id)
    ON CONFLICT DO NOTHING`,[id,scope.ownerId,scope.contactId,sourceId]);
   await acceptTaskIntoProcessingRound(c,scope,id);
   return id;
  });
 }
 async claim(scope:ExtractionScope,input:{taskId?:string;workerId:string;leaseMs:number;supportedSteps?:string[];runtimeRuleSetSha256?:string}):Promise<ExtractionClaim|null>{
  if(!Number.isFinite(input.leaseMs)||input.leaseMs<=0)throw new ExtractionTaskError('lease_duration_invalid');
  return this.transaction(scope,async c=>{
   const supported=input.supportedSteps??['extract_memory'];
   const scopePaused=await memoryScopePaused(c,scope);
   const unsettled=scopePaused?{direct:new Set<string>(),windows:new Map<string,Set<string>>()} : await unsettledExtraction(this,c,scope);
   if(!scopePaused){
    const expired=(await c.query(`SELECT t.id,s.id AS step_id FROM background_task t JOIN background_task_step s ON s.task_id=t.id
     WHERE t.owner_id=$1 AND t.contact_id=$2 AND s.step_name='extract_memory' AND s.status='running' AND s.lease_expires_at<=now()`,[scope.ownerId,scope.contactId])).rows;
    for(const row of expired){
     await quarantineExtraction(c,scope,row.id,unsettled.windows.get(row.id)??new Set());
    if(await blockedExtraction(c,unsettled,row.id,false))await this.markUnknown(c,scope,row.id,row.step_id);
    }
    // 只恢复本票负责的提取步骤；其他业务 Worker 的租约不得顺带重排。
    await c.query(`UPDATE background_task_step s SET status=CASE WHEN attempt_count>=3 THEN 'failed' ELSE 'retryable' END,
     worker_id=NULL,lease_expires_at=NULL,last_error_code='lease_expired',updated_at=now()
     FROM background_task t WHERE t.id=s.task_id AND t.owner_id=$1 AND t.contact_id=$2
     AND s.step_name='extract_memory' AND s.status='running' AND s.lease_expires_at<=now()`,[scope.ownerId,scope.contactId]);
    await c.query(`UPDATE background_task t SET status='failed',last_error_code='lease_expired',finished_at=now(),updated_at=now()
     WHERE t.owner_id=$1 AND t.contact_id=$2 AND t.status IN ('queued','running','verifying')
     AND EXISTS(SELECT 1 FROM background_task_step s WHERE s.task_id=t.id AND s.step_name='extract_memory' AND s.status='failed' AND s.last_error_code='lease_expired')`,[scope.ownerId,scope.contactId]);
    const indexSteps=['index','verify'].filter(step=>supported.includes(step));
    if(indexSteps.length){
     await c.query(`UPDATE background_task_step step
      SET status=CASE WHEN step.attempt_count>=3 THEN 'failed' ELSE 'retryable' END,
       worker_id=NULL,lease_expires_at=NULL,last_error_code='lease_expired',updated_at=now()
      FROM background_task task
      WHERE task.id=step.task_id AND task.owner_id=$1 AND task.contact_id=$2
       AND task.task_type IN ('import','observation')
       AND step.step_name=ANY($3::text[]) AND step.status='running'
       AND step.lease_expires_at<=clock_timestamp()`,
     [scope.ownerId,scope.contactId,indexSteps]);
     await c.query(`UPDATE background_task task SET status='failed',last_error_code='lease_expired',
      finished_at=now(),updated_at=now()
      WHERE task.owner_id=$1 AND task.contact_id=$2 AND task.status IN ('queued','running','verifying')
       AND task.task_type IN ('import','observation')
       AND EXISTS(SELECT 1 FROM background_task_step step WHERE step.task_id=task.id
        AND step.step_name=ANY($3::text[]) AND step.status='failed'
        AND step.last_error_code='lease_expired')`,
     [scope.ownerId,scope.contactId,indexSteps]);
    }
    await c.query(`UPDATE background_task_step step
     SET status=CASE WHEN job.pending_receipt AND batch.status='succeeded'
       AND batch.settings_generation=job.settings_generation THEN 'pending'
       WHEN step.attempt_count>=3 THEN 'failed' ELSE 'retryable' END,
      attempt_count=CASE WHEN job.pending_receipt AND batch.status='succeeded'
       AND batch.settings_generation=job.settings_generation THEN 0 ELSE attempt_count END,
      worker_id=NULL,lease_expires_at=NULL,
      last_error_code=CASE WHEN job.pending_receipt AND batch.status='succeeded'
       AND batch.settings_generation=job.settings_generation THEN NULL ELSE 'lease_expired' END,
      finished_at=CASE WHEN step.attempt_count>=3 AND NOT(job.pending_receipt AND batch.status='succeeded'
       AND batch.settings_generation=job.settings_generation) THEN now() ELSE step.finished_at END,
      updated_at=now()
     FROM background_task task
     JOIN layered_memory_job job ON job.task_id=task.id AND job.owner_id=task.owner_id
       AND job.contact_id IS NOT DISTINCT FROM task.contact_id
     LEFT JOIN layered_memory_batch batch ON batch.id=job.receipt_batch_id
       AND batch.task_id=job.task_id AND batch.owner_id=job.owner_id
       AND batch.contact_id IS NOT DISTINCT FROM job.contact_id
     WHERE step.task_id=task.id AND task.id=step.task_id AND task.owner_id=$1
       AND task.contact_id IS NOT DISTINCT FROM $2::uuid AND task.task_type='layered_memory'
       AND step.step_name='organize_memory' AND step.status='running'
       AND step.lease_expires_at<=clock_timestamp()`,
    [scope.ownerId,scope.contactId]);
    await c.query(`UPDATE background_task task SET status='failed',last_error_code='lease_expired',
     finished_at=now(),updated_at=now()
     WHERE task.owner_id=$1 AND task.contact_id IS NOT DISTINCT FROM $2::uuid
       AND task.task_type='layered_memory' AND task.status IN ('queued','running','verifying')
       AND EXISTS(SELECT 1 FROM background_task_step step WHERE step.task_id=task.id
        AND step.step_name='organize_memory' AND step.status='failed'
        AND step.last_error_code='lease_expired')`,
    [scope.ownerId,scope.contactId]);
    await c.query(`UPDATE background_task task SET status='queued',last_error_code=NULL,
     finished_at=NULL,updated_at=now()
     WHERE task.owner_id=$1 AND task.contact_id IS NOT DISTINCT FROM $2::uuid
       AND task.task_type='layered_memory' AND task.status='failed'
       AND EXISTS(SELECT 1 FROM background_task_step step WHERE step.task_id=task.id
        AND step.step_name='organize_memory' AND step.status='pending')`,
    [scope.ownerId,scope.contactId]);
   }
   if(supported.includes('propose_skill')||supported.includes('verify_skill_drafts')){
    await c.query(`UPDATE background_task_step step SET status=CASE WHEN step.attempt_count>=3 THEN 'failed' ELSE 'retryable' END,
      worker_id=NULL,lease_expires_at=NULL,last_error_code='lease_expired',updated_at=now()
      FROM background_task task WHERE task.id=step.task_id AND task.owner_id=$1 AND task.contact_id=$2
      AND task.task_type='skill_learning' AND step.step_name=ANY($3::text[]) AND step.status='running'
      AND step.lease_expires_at<=clock_timestamp()`,[scope.ownerId,scope.contactId,
      supported.filter(step=>['propose_skill','verify_skill_drafts'].includes(step))]);
    await c.query(`UPDATE background_task task SET status='failed',last_error_code='lease_expired',
      finished_at=now(),updated_at=now() WHERE task.owner_id=$1 AND task.contact_id=$2
      AND task.task_type='skill_learning' AND task.status IN('queued','running','verifying')
      AND EXISTS(SELECT 1 FROM background_task_step step WHERE step.task_id=task.id
       AND step.step_name=ANY($3::text[]) AND step.status='failed' AND step.last_error_code='lease_expired')`,
    [scope.ownerId,scope.contactId,supported.filter(step=>['propose_skill','verify_skill_drafts'].includes(step))]);
    await c.query(`UPDATE background_task task SET status='queued',last_error_code=NULL,finished_at=NULL,updated_at=now()
      WHERE task.owner_id=$1 AND task.contact_id=$2 AND task.task_type='skill_learning' AND task.status='failed'
      AND NOT EXISTS(SELECT 1 FROM background_task_step failed_step WHERE failed_step.task_id=task.id
       AND failed_step.step_name=ANY($3::text[]) AND failed_step.status='failed')
      AND EXISTS(SELECT 1 FROM background_task_step step WHERE step.task_id=task.id
       AND step.step_name=ANY($3::text[]) AND step.status='pending')`,
    [scope.ownerId,scope.contactId,supported.filter(step=>['propose_skill','verify_skill_drafts'].includes(step))]);
   }
   if((await c.query(`SELECT 1 FROM background_task t JOIN background_task_step s ON s.task_id=t.id
    WHERE t.owner_id=$1 AND t.contact_id IS NOT DISTINCT FROM $2::uuid
      AND s.status='running' AND s.lease_expires_at>now() LIMIT 1`,[scope.ownerId,scope.contactId])).rowCount)return null;
   const blocked=[...unsettled.direct];
   for(const task of unsettled.windows.keys())if(await blockedExtraction(c,unsettled,task,true))blocked.push(task);
   const row=(await c.query(`SELECT t.id AS task_id,t.*,s.id AS step_id,s.step_name,s.attempt_count,s.lease_generation
    FROM background_task t JOIN background_task_step s ON s.task_id=t.id
    WHERE t.owner_id=$1 AND t.contact_id IS NOT DISTINCT FROM $2::uuid
    AND ((t.task_type IN ('import','observation') AND ${sourceAllowed})
      OR (t.task_type='layered_memory' AND EXISTS(
       SELECT 1 FROM layered_memory_job job JOIN layered_memory_state state
        ON state.owner_id=job.owner_id AND state.contact_id IS NOT DISTINCT FROM job.contact_id
       WHERE job.task_id=t.id AND job.owner_id=t.owner_id
        AND job.contact_id IS NOT DISTINCT FROM t.contact_id AND job.state='active'
       AND state.enabled AND 'document-tools-v1'=ANY(string_to_array(job.contract,':'))))
      OR ${skillLearningAllowed})
    AND t.status IN ('queued','running','verifying')
    AND ($6::boolean=false OR t.task_type='skill_learning')
    AND (
      t.task_type='skill_learning'
      OR NOT EXISTS(
        SELECT 1 FROM memory_processing_scope control
        WHERE control.owner_id=t.owner_id
          AND control.contact_id IS NOT DISTINCT FROM t.contact_id
          AND control.active_round_id IS NOT NULL
      )
      OR EXISTS(
        SELECT 1 FROM memory_processing_scope control
        JOIN memory_processing_round_task membership
          ON membership.round_id=control.active_round_id
        WHERE control.owner_id=t.owner_id
          AND control.contact_id IS NOT DISTINCT FROM t.contact_id
          AND membership.task_id=t.id AND membership.active
      )
    )
    AND ($3::uuid IS NULL OR t.id=$3) AND s.step_name=ANY($4::text[]) AND s.status IN ('pending','retryable')
    AND NOT(t.id=ANY($5::uuid[]))
    AND (s.status='pending' OR s.attempt_count<3)
    AND NOT EXISTS(SELECT 1 FROM background_task_step p WHERE p.task_id=t.id AND p.step_order<s.step_order AND p.status<>'succeeded')
    ORDER BY t.created_at,t.id,s.step_order LIMIT 1 FOR UPDATE OF t,s`,[scope.ownerId,scope.contactId,input.taskId??null,input.supportedSteps??['extract_memory'],blocked,scopePaused])).rows[0];
   if(!row)return null;
   if(await blockedExtraction(c,unsettled,row.task_id,true))return null;
   if(row.step_name==='extract_memory'&&row.extraction_runtime_config){
    const config=validateExtractionRuntimeConfig(row.extraction_runtime_config)!;
    if(config.version===2){
     if(!this.options.policyVersion)throw new ExtractionTaskError('extraction_policy_source_unavailable');
     await this.options.policyVersion.assertCurrent();this.options.policyVersion.resolve(config);
    }
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
    memory_control_generation=CASE WHEN $4::boolean THEN NULL ELSE COALESCE((SELECT control_generation FROM memory_processing_scope WHERE owner_id=$5 AND contact_id IS NOT DISTINCT FROM $6::uuid),0) END,
    lease_generation=lease_generation+1,worker_id=$2,lease_expires_at=now()+$3*interval '1 millisecond',last_error_code=NULL,
    started_at=COALESCE(started_at,now()),updated_at=now() WHERE id=$1 RETURNING lease_expires_at,lease_generation,attempt_count`,[row.step_id,input.workerId,input.leaseMs,row.task_type==='skill_learning',scope.ownerId,scope.contactId])).rows[0];
   await c.query("UPDATE background_task SET status=$2,current_step=$3,last_error_code=NULL,started_at=COALESCE(started_at,clock_timestamp()),updated_at=now() WHERE id=$1",[row.task_id,['verify','verify_skill_drafts'].includes(row.step_name)?'verifying':'running',row.step_name]);
   if(row.task_type!=='skill_learning')await markRoundTaskProcessing(c,{
     ownerId:scope.ownerId,contactId:scope.contactId,taskId:row.task_id,
   },row.step_name==='extract_memory'?'extraction':row.step_name==='organize_memory'?'topics':'verification');
   return {...scope,taskId:row.task_id,stepId:row.step_id,stepName:row.step_name,workerId:input.workerId,leaseGeneration:Number(lease.lease_generation),
    attemptCount:lease.attempt_count,messageCount:row.message_count,sourceDocumentId:row.source_document_id,taskType:row.task_type,
    leaseExpiresAt:lease.lease_expires_at,runtimeConfig:row.extraction_runtime_config??null};
  });
 }
 async markUnknown(c:pg.ClientBase,scope:ExtractionScope,taskId:string,stepId:string):Promise<void>{
  await c.query("UPDATE background_task_step SET status='failed',worker_id=NULL,lease_expires_at=NULL,last_error_code='model_call_outcome_unknown',updated_at=now() WHERE id=$1",[stepId]);
  await c.query("UPDATE background_task SET status='failed',last_error_code='model_call_outcome_unknown',finished_at=now(),updated_at=now() WHERE id=$1",[taskId]);
  await blockMemoryProcessingRound(c,{...scope,taskId});
 }
 async fail(claim:ExtractionClaim,errorCode:string,retryable:boolean):Promise<'failed'|'retryable'>{
  if(!/^[a-zA-Z0-9_]{1,64}$/.test(errorCode))throw new ExtractionTaskError('task_error_code_invalid');
  return this.transaction(claim,async c=>{
   await this.assertLease(c,claim);
   if(claim.taskType==='layered_memory'){
    const status=retryable&&claim.attemptCount<3?'retryable':'failed';
    await c.query("UPDATE background_task_step SET status=$2,worker_id=NULL,lease_expires_at=NULL,last_error_code=$3,updated_at=now() WHERE id=$1",[claim.stepId,status,errorCode]);
    await c.query("UPDATE background_task SET status=$2,retry_count=retry_count+1,last_error_code=$3,finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1",[claim.taskId,status==='failed'?'failed':'running',errorCode]);
    if(status==='failed'){
     await c.query(`UPDATE layered_memory_job SET state='failed'
       WHERE task_id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3::uuid AND state='active'`,
     [claim.taskId,claim.ownerId,claim.contactId]);
     await c.query(`UPDATE layered_memory_state SET status='failed',error_code=$3,updated_at=now()
       WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND enabled`,
     [claim.ownerId,claim.contactId,errorCode]);
     await blockMemoryProcessingRound(c,claim);
    }
    return status;
   }
   if(claim.taskType==='skill_learning'){
    const status=retryable&&claim.attemptCount<3?'retryable':'failed';
    await c.query("UPDATE background_task_step SET status=$2,worker_id=NULL,lease_expires_at=NULL,last_error_code=$3,updated_at=now() WHERE id=$1",[claim.stepId,status,errorCode]);
    await c.query("UPDATE background_task SET status=$2,retry_count=retry_count+1,last_error_code=$3,finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1",
      [claim.taskId,status==='failed'?'failed':claim.stepName==='verify_skill_drafts'?'verifying':'running',errorCode]);
    return status;
   }
   const unsettled=await unsettledExtraction(this,c,claim);
   if(await blockedExtraction(c,unsettled,claim.taskId,false)){
    await quarantineExtraction(c,claim,claim.taskId,unsettled.windows.get(claim.taskId)??new Set());
    await this.markUnknown(c,claim,claim.taskId,claim.stepId);return 'failed';
   }
   const status=retryable&&claim.attemptCount<3?'retryable':'failed';
   await c.query("UPDATE background_task_step SET status=$2,worker_id=NULL,lease_expires_at=NULL,last_error_code=$3,updated_at=now() WHERE id=$1",[claim.stepId,status,errorCode]);
   await c.query("UPDATE background_task SET status=$2,retry_count=retry_count+1,last_error_code=$3,finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1",[claim.taskId,status==='failed'?'failed':'running',errorCode]);
   if(status==='failed')await blockMemoryProcessingRound(c,claim);
   return status;
  });
 }
 async pause(claim:ExtractionClaim):Promise<boolean>{
  return this.transaction(claim,async c=>{
   await this.assertLease(c,claim);
   if(claim.taskType==='layered_memory'){
    const released=await c.query(`UPDATE background_task_step
      SET status='pending',attempt_count=GREATEST(0,attempt_count-1),processed_count=0,
        worker_id=NULL,lease_expires_at=NULL,finished_at=NULL,updated_at=now()
      WHERE id=$1 AND status='running' AND worker_id=$2 AND lease_generation=$3`,
    [claim.stepId,claim.workerId,claim.leaseGeneration]);
    if(!released.rowCount)return false;
    await c.query(`UPDATE background_task SET status='queued',finished_at=NULL,updated_at=now()
      WHERE id=$1 AND status='running'`,[claim.taskId]);
    return true;
   }
   if(claim.taskType==='skill_learning'){
    const released=await c.query(`UPDATE background_task_step SET status='pending',attempt_count=GREATEST(0,attempt_count-1),
      worker_id=NULL,lease_expires_at=NULL,finished_at=NULL,updated_at=now()
      WHERE id=$1 AND status='running' AND worker_id=$2 AND lease_generation=$3`,
    [claim.stepId,claim.workerId,claim.leaseGeneration]);
    if(!released.rowCount)return false;
    await c.query("UPDATE background_task SET status='queued',finished_at=NULL,updated_at=now() WHERE id=$1 AND status IN('running','verifying')",[claim.taskId]);
    return true;
   }
   const unsettled=await unsettledExtraction(this,c,claim);
   if(await blockedExtraction(c,unsettled,claim.taskId,false)){
    await quarantineExtraction(c,claim,claim.taskId,unsettled.windows.get(claim.taskId)??new Set());await this.markUnknown(c,claim,claim.taskId,claim.stepId);return false;
   }
   // 与原Worker一致：返还一次尝试，租约到期或显式恢复后才允许新执行者领取。
   return Boolean((await c.query("UPDATE background_task_step SET attempt_count=attempt_count-1,updated_at=now() WHERE id=$1 AND attempt_count>0",[claim.stepId])).rowCount);
  });
 }
 async complete(claim:ExtractionClaim,processedCount:number,totalCount?:number):Promise<void>{
  if(!Number.isSafeInteger(processedCount)||processedCount<0||totalCount!==undefined&&(!Number.isSafeInteger(totalCount)||totalCount<0))throw new ExtractionTaskError('task_count_invalid');
  if(claim.stepName==='organize_memory'){
   await this.transaction(claim,async c=>{
    await this.assertLease(c,claim);
    const completion=await completeL2ScenarioWorkerStep(c,claim,processedCount);
    if(completion.state==='complete')await completeMemoryProcessingRoundIfReady(c,claim);
    else await blockMemoryProcessingRound(c,claim);
   });
   return;
  }
  if(claim.taskType==='skill_learning'&&claim.stepName==='verify_skill_drafts'){
   await this.transaction(claim,async c=>{
    await this.assertLease(c,claim);
    await c.query(`UPDATE background_task_step SET status='succeeded',processed_count=$2,total_count=COALESCE($3,total_count),
      worker_id=NULL,lease_expires_at=NULL,finished_at=now(),updated_at=now() WHERE id=$1`,
    [claim.stepId,processedCount,totalCount??claim.messageCount]);
    const task=(await c.query('SELECT observation_pending FROM background_task WHERE id=$1 FOR UPDATE',[claim.taskId])).rows[0];
    if(task?.observation_pending){
     await c.query(`UPDATE background_task_step SET status='pending',attempt_count=0,processed_count=0,worker_id=NULL,
       lease_expires_at=NULL,last_error_code=NULL,started_at=NULL,finished_at=NULL,updated_at=now() WHERE task_id=$1`,
     [claim.taskId]);
     await c.query(`UPDATE background_task SET status='queued',current_step='propose_skill',observation_pending=false,
       last_error_code=NULL,finished_at=NULL,updated_at=now() WHERE id=$1`,[claim.taskId]);
    }else await c.query(`UPDATE background_task SET status='succeeded',current_step='verify_skill_drafts',
      observation_pending=false,last_error_code=NULL,finished_at=now(),updated_at=now() WHERE id=$1`,[claim.taskId]);
   });
   return;
  }
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
   if(!requeue)await continueMemoryProcessingAfterExtraction(c,claim,this.options.organization);
  });
 }
 async assertLease(c:pg.ClientBase,claim:ExtractionClaim):Promise<void>{
  const result=await c.query(`SELECT 1 FROM background_task t JOIN background_task_step s ON s.task_id=t.id
   WHERE t.id=$1 AND t.owner_id=$2 AND t.contact_id IS NOT DISTINCT FROM $3::uuid
   AND s.id=$4 AND s.worker_id=$5 AND s.lease_generation=$6
   AND s.step_name=$7 AND s.status='running' AND s.lease_expires_at>clock_timestamp()
   AND t.status IN ('queued','running','verifying') AND ${memoryExecutionAllowed}
   AND ((t.task_type IN ('import','observation') AND ${sourceAllowed}) OR t.task_type='layered_memory'
    OR ${skillLearningAllowed})
   FOR UPDATE OF t,s`,
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
   if(await memoryScopePaused(c,scope))throw new ExtractionTaskError('memory_processing_paused');
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
 /** owner入口先从任务行确定真实联系人，再复用同一contact锁与来源门禁。 */
 async resumeOwner(ownerId:string,taskId:string,action:'resume'|'restart'):Promise<{task_id:string;status:string}>{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)
   ||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)
   ||!['resume','restart'].includes(action))throw new ExtractionTaskError('resume_request_invalid');
  const row=(await this.pool.query(`SELECT contact_id FROM background_task WHERE id=$1 AND owner_id=$2
   AND task_type IN ('import','observation')`,[taskId,ownerId])).rows[0];
  if(!row)throw new ExtractionTaskError('task_not_found');
  return this.resume({ownerId,contactId:row.contact_id},taskId,action);
 }
 /** 只列出可交给唯一任务 Worker 的联系人范围；真正领取仍走 claim 的原子租约。 */
 async readyScopes(ownerId:string,limit=64,runtimeModes:readonly ('legacy'|'bounded-runtime-v1')[]=['legacy'],
  includeOrganization=false,includeIndex=false,includeLearning=false,
 ):Promise<ExtractionScope[]>{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)
   ||!Number.isSafeInteger(limit)||limit<1||limit>256||!runtimeModes.length
   ||runtimeModes.some(mode=>!['legacy','bounded-runtime-v1'].includes(mode))
   ||typeof includeOrganization!=='boolean'||typeof includeIndex!=='boolean'||typeof includeLearning!=='boolean')throw new ExtractionTaskError('worker_scan_invalid');
  const extractionSteps=['parse','normalize','extract_memory',...(includeIndex?['index','verify']:[])];
  const rows=(await this.pool.query(`WITH candidates AS (
    SELECT s.contact_id,0 AS priority,COALESCE(s.due_at,s.last_input_at) AS ready_at
    FROM memory_extraction_schedule s
    JOIN conversation_binding b ON b.owner_id=s.owner_id AND b.contact_id=s.contact_id AND b.status='active'
    LEFT JOIN background_task scheduled_task ON scheduled_task.id=s.task_id
    WHERE s.owner_id=$1 AND s.due_at IS NOT NULL AND s.due_at<=clock_timestamp()
     AND NOT EXISTS(SELECT 1 FROM memory_processing_scope control WHERE control.owner_id=s.owner_id AND control.contact_id IS NOT DISTINCT FROM s.contact_id AND control.intent='pause')
     AND (s.pending_count>0 OR s.task_id IS NOT NULL)
     AND (scheduled_task.id IS NULL OR COALESCE(scheduled_task.extraction_runtime_config->>'mode','legacy')=ANY($3::text[]))
    UNION ALL
    SELECT t.contact_id,1 AS priority,COALESCE(t.started_at,t.created_at) AS ready_at
    FROM background_task t JOIN background_task_step s ON s.task_id=t.id
    WHERE t.owner_id=$1 AND t.task_type IN ('import','observation')
     AND NOT EXISTS(SELECT 1 FROM memory_processing_scope control WHERE control.owner_id=t.owner_id AND control.contact_id IS NOT DISTINCT FROM t.contact_id AND control.intent='pause')
     AND t.status IN ('queued','running','verifying') AND ${sourceAllowed}
     AND s.step_name=ANY($5::text[])
     AND (
       s.status IN ('pending','retryable')
       OR ($6::boolean AND s.step_name IN ('index','verify')
         AND s.status='running' AND s.lease_expires_at<=clock_timestamp())
     )
     AND COALESCE(t.extraction_runtime_config->>'mode','legacy')=ANY($3::text[])
    UNION ALL
    SELECT t.contact_id,0 AS priority,COALESCE(t.started_at,t.created_at) AS ready_at
    FROM background_task t
    JOIN background_task_step s ON s.task_id=t.id AND s.step_name='organize_memory'
    JOIN layered_memory_job job ON job.task_id=t.id AND job.owner_id=t.owner_id
      AND job.contact_id IS NOT DISTINCT FROM t.contact_id
    JOIN layered_memory_state state ON state.owner_id=job.owner_id
      AND state.contact_id IS NOT DISTINCT FROM job.contact_id
    WHERE $4::boolean AND t.owner_id=$1 AND t.task_type='layered_memory'
     AND NOT EXISTS(SELECT 1 FROM memory_processing_scope control WHERE control.owner_id=t.owner_id AND control.contact_id IS NOT DISTINCT FROM t.contact_id AND control.intent='pause')
     AND t.status IN ('queued','running','verifying') AND job.state='active' AND state.enabled
     AND 'document-tools-v1'=ANY(string_to_array(job.contract,':'))
     AND (s.status IN ('pending','retryable')
      OR s.status='running' AND s.lease_expires_at<=clock_timestamp())
     AND (s.status='pending' OR s.attempt_count<3)
    UNION ALL
    SELECT t.contact_id,0 AS priority,COALESCE(t.started_at,t.created_at) AS ready_at
    FROM background_task t JOIN background_task_step s ON s.task_id=t.id
    WHERE $7::boolean AND t.owner_id=$1 AND t.task_type='skill_learning'
     AND t.status IN ('queued','running','verifying') AND ${skillLearningAllowed}
     AND s.step_name IN ('propose_skill','verify_skill_drafts')
     AND (s.status IN ('pending','retryable') OR s.status='running' AND s.lease_expires_at<=clock_timestamp())
     AND (s.status='pending' OR s.attempt_count<3)
   )
   SELECT contact_id FROM candidates GROUP BY contact_id
   ORDER BY min(priority),min(ready_at),contact_id LIMIT $2`,
  [ownerId,limit,[...new Set(runtimeModes)],includeOrganization,extractionSteps,includeIndex,includeLearning])).rows;
  return rows.map(row=>({ownerId,contactId:row.contact_id}));
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
