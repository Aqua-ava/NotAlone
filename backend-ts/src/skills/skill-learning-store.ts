/** 学习授权、批次、待审草稿的权威 PostgreSQL 状态；每次保存复验原任务围栏。 */
import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {canonicalJSON,validateFrozen} from '../memory/overview/contact-overview-evidence.ts';
import type {ExtractionClaim,ExtractionTaskStore} from '../memory/extraction/extraction-task-store.ts';
import type {SkillFiles} from './skill-files.ts';
import {
  SkillLearningInvalid,SkillLearningNotFound,normalizeProposal,
  skillContentDigest,type SkillLearningBatch,type SkillLearningScope,
} from './skill-learning-contract.ts';
import {selectLearningBatch} from './skill-learning-materials.ts';
import {
  captureSkillGeneration,isSkillPersistenceError,type SkillDiscussionValidator,
} from './skill-source-proof.ts';
import {requireSkillDependencies} from './skill-source-dependencies.ts';
export const SKILL_LEARNING_STEPS=['propose_skill','verify_skill_drafts'] as const;
type Transaction=<T>(operation:(client:pg.Client)=>Promise<T>)=>Promise<T>;
export interface SkillLearningStoreOptions {
  transaction:Transaction;
  files:SkillFiles;
  taskStore:Pick<ExtractionTaskStore,'assertLease'>;
  requireDiscussionDependencies?:SkillDiscussionValidator;
}
export interface SkillLearningDraftRow extends Record<string,any>{
  id:string;revision:number;status:'pending'|'rejected'|'published'|'invalidated';
  logical_skill_id:string;proposal_kind:'create'|'update'|'merge';strategy:Record<string,any>|null;
  private_evidence:Record<string,any>|null;target_versions:Record<string,any>[];
}
async function lockScope(client:pg.Client,scope:SkillLearningScope):Promise<void>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${scope.owner_id}:${scope.contact_id}`]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${scope.owner_id}`]);
}
async function requireContact(client:pg.Client,scope:SkillLearningScope):Promise<void>{
  if(!(await client.query('SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2',[scope.owner_id,scope.contact_id])).rowCount)
    throw new SkillLearningNotFound();
}
async function dependenciesAreCurrent(client:pg.Client,scope:SkillLearningScope,dependencies:string[],
  requireDiscussionDependencies?:SkillDiscussionValidator):Promise<boolean>{
  try{
    await requireSkillDependencies(client,scope.owner_id,scope.contact_id,dependencies,
      {checking:new Set<string>(),validated:new Set<string>(),requireDiscussionDependencies});
    return true;
  }catch(error){if(isSkillPersistenceError(error))throw error;return false;}
}
async function generationIsCurrent(client:pg.Client,scope:SkillLearningScope,frozen:Record<string,any>):Promise<boolean>{
  if(frozen?.version!==1||frozen.styles&&(!Array.isArray(frozen.styles)||frozen.styles.length))return false;
  try{
    await validateFrozen(client,scope.owner_id,frozen.messages);
    const current=await captureSkillGeneration(client,scope.owner_id,scope.contact_id,frozen.dependencies);
    const {styles:_styles,...expected}=frozen;
    return canonicalJSON(current)===canonicalJSON(expected);
  }catch(error){if(isSkillPersistenceError(error))throw error;return false;}
}
export async function authorizedContact(client:pg.Client,scope:SkillLearningScope):Promise<boolean>{
  return Boolean((await client.query("SELECT 1 FROM public.conversation_binding WHERE owner_id=$1 AND contact_id=$2 AND status='active'",[scope.owner_id,scope.contact_id])).rowCount);
}
export function draftPayload(row:SkillLearningDraftRow){
  return {draft_id:row.id,revision:Number(row.revision),status:row.status,logical_skill_id:row.logical_skill_id,
    proposal_kind:row.proposal_kind,sanitized_strategy:row.strategy,private_evidence:row.private_evidence,
    target_versions:row.target_versions};
}
export class SkillLearningStore {
  private readonly options:SkillLearningStoreOptions;
  constructor(options:SkillLearningStoreOptions){this.options=options;}
  private visit(){return {checking:new Set<string>(),validated:new Set<string>(),
    requireDiscussionDependencies:this.options.requireDiscussionDependencies};}
  async dependenciesCurrent(client:pg.Client,scope:SkillLearningScope,dependencies:string[]):Promise<boolean>{
    return dependenciesAreCurrent(client,scope,dependencies,this.options.requireDiscussionDependencies);
  }
  async generationCurrent(client:pg.Client,scope:SkillLearningScope,frozen:Record<string,any>):Promise<boolean>{
    return generationIsCurrent(client,scope,frozen);
  }
  async draftsCurrent(client:pg.Client,scope:SkillLearningScope,rows:SkillLearningDraftRow[]):Promise<Set<string>>{
    const invalid=new Set<string>();
    for(const row of rows){
      if(!await this.dependenciesCurrent(client,scope,row.dependency_ids??[])
        ||!await this.generationCurrent(client,scope,row.source_generation??{}))invalid.add(row.id);
    }
    return invalid;
  }
  async invalidateDrafts(client:pg.Client,owner:string,ids:string[]):Promise<void>{
    if(!ids.length)return;
    await client.query(`UPDATE public.skill_draft SET status='invalidated',revision=revision+1,strategy=NULL,
      private_evidence=NULL,target_versions='[]',dependency_ids='{}',source_generation='{}',batch_key=id::text
      WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND status<>'invalidated'`,[owner,ids]);
    await client.query(`UPDATE public.skill_review_comparison SET state='invalidated',input=NULL,confirmed_scope=NULL,
      context_fingerprint=NULL,dependency_ids='{}',source_generation='{}',target_versions='[]',result=NULL,
      run_token=NULL,lease_expires_at=NULL WHERE owner_id=$1 AND draft_id=ANY($2::uuid[])`,[owner,ids]);
    await client.query("UPDATE public.skill_review_operation SET request_fingerprint=NULL WHERE owner_id=$1 AND draft_id=ANY($2::uuid[]) AND action='compare'",[owner,ids]);
    await client.query('UPDATE public.skill_draft SET current_comparison_id=NULL WHERE owner_id=$1 AND id=ANY($2::uuid[])',[owner,ids]);
    const batches=(await client.query(`UPDATE public.skill_learning_batch SET outcome='invalidated',dependency_ids='{}',batch_key=id::text
      WHERE owner_id=$1 AND draft_id=ANY($2::uuid[]) RETURNING id`,[owner,ids])).rows;
    if(batches.length)await client.query('UPDATE public.skill_learning_receipt SET digest=NULL WHERE owner_id=$1 AND batch_id=ANY($2::uuid[])',
      [owner,batches.map(row=>row.id)]);
  }
  async clearUnavailable(client:pg.Client,scope:SkillLearningScope):Promise<void>{
    const rows=(await client.query(`SELECT id,dependency_ids,source_generation FROM public.skill_draft
      WHERE owner_id=$1 AND contact_id=$2 AND status<>'invalidated'`,[scope.owner_id,scope.contact_id])).rows as SkillLearningDraftRow[];
    await this.invalidateDrafts(client,scope.owner_id,[...(await this.draftsCurrent(client,scope,rows))]);
  }
  private async withScope<T>(scope:SkillLearningScope,work:(client:pg.Client)=>Promise<T>,requireAuthorization=false):Promise<T>{
    return this.options.transaction(async client=>{
      await lockScope(client,scope);await requireContact(client,scope);
      if(requireAuthorization&&!await authorizedContact(client,scope))throw new SkillLearningNotFound();
      return work(client);
    });
  }
  async list(scope:SkillLearningScope){
    return this.withScope(scope,async client=>{
      await this.clearUnavailable(client,scope);
      const rows=(await client.query(`SELECT * FROM public.skill_draft WHERE owner_id=$1 AND contact_id=$2 AND status='pending'
        ORDER BY created_at,id LIMIT 100`,[scope.owner_id,scope.contact_id])).rows as SkillLearningDraftRow[];
      const setting=(await client.query('SELECT enabled,revision FROM public.skill_learning_scope WHERE owner_id=$1 AND contact_id=$2',
        [scope.owner_id,scope.contact_id])).rows[0];
      const task=(await client.query("SELECT id,status,last_error_code FROM public.background_task WHERE owner_id=$1 AND contact_id=$2 AND task_type='skill_learning'",
        [scope.owner_id,scope.contact_id])).rows[0];
      const outcomes=(await client.query("SELECT outcome FROM public.skill_learning_batch WHERE owner_id=$1 AND contact_id=$2 AND outcome<>'invalidated' ORDER BY created_at DESC LIMIT 5",
        [scope.owner_id,scope.contact_id])).rows;
      return {drafts:rows.map(draftPayload),enabled:Boolean(setting?.enabled),
        task:task?{task_id:task.id,status:task.status,error_code:task.last_error_code}:null,
        recent_outcomes:outcomes.map(row=>row.outcome),scope_revision:Number(setting?.revision??0)};
    });
  }
  async read(scope:SkillLearningScope,draftId:string){
    return this.withScope(scope,async client=>{
      await this.clearUnavailable(client,scope);
      const row=(await client.query('SELECT * FROM public.skill_draft WHERE owner_id=$1 AND contact_id=$2 AND id=$3',
        [scope.owner_id,scope.contact_id,draftId])).rows[0] as SkillLearningDraftRow|undefined;
      if(!row)throw new SkillLearningNotFound();if(row.status==='invalidated')throw new SkillLearningInvalid();
      return {draft:draftPayload(row)};
    });
  }
  async configure(scope:SkillLearningScope,command:{enabled:boolean;operationKey:string;expectedRevision:number}):Promise<void>{
    await this.withScope(scope,async client=>{
      const current=Number((await client.query('SELECT revision FROM public.skill_learning_scope WHERE owner_id=$1 AND contact_id=$2',
        [scope.owner_id,scope.contact_id])).rows[0]?.revision??0);
      const previous=(await client.query(`SELECT enabled,expected_revision,result_revision FROM public.skill_learning_operation
        WHERE owner_id=$1 AND contact_id=$2 AND operation_key=$3`,[scope.owner_id,scope.contact_id,command.operationKey])).rows[0];
      if(previous){
        if(previous.enabled!==command.enabled||Number(previous.expected_revision)!==command.expectedRevision
          ||Number(previous.result_revision)!==current)throw new SkillLearningInvalid();
        return;
      }
      if(current!==command.expectedRevision)throw new SkillLearningInvalid();
      if(command.enabled&&!await authorizedContact(client,scope))throw new SkillLearningInvalid();
      const next=command.expectedRevision+1;
      await client.query(`INSERT INTO public.skill_learning_scope(owner_id,contact_id,enabled,revision,confirmed_at)
        VALUES($1,$2,$3,$4,now()) ON CONFLICT(owner_id,contact_id) DO UPDATE SET enabled=excluded.enabled,
        revision=excluded.revision,confirmed_at=excluded.confirmed_at`,
      [scope.owner_id,scope.contact_id,command.enabled,next]);
      await client.query(`INSERT INTO public.skill_learning_operation
        (owner_id,contact_id,operation_key,enabled,expected_revision,result_revision) VALUES($1,$2,$3,$4,$5,$6)`,
      [scope.owner_id,scope.contact_id,command.operationKey,command.enabled,command.expectedRevision,next]);
      if(!command.enabled)await cancelLearningTasks(client,scope);
    });
  }
  private async learningAllowed(client:pg.Client,scope:SkillLearningScope):Promise<boolean>{
    return await authorizedContact(client,scope)&&Boolean((await client.query(
      'SELECT 1 FROM public.skill_learning_scope WHERE owner_id=$1 AND contact_id=$2 AND enabled',[scope.owner_id,scope.contact_id])).rowCount);
  }
  async capture(scope:SkillLearningScope):Promise<SkillLearningBatch>{
    return this.withScope(scope,async client=>{
      if(!await this.learningAllowed(client,scope))throw new SkillLearningInvalid();
      const batch=await selectLearningBatch(client,scope,this.options.files,this.visit());
      if(batch.ready)await client.query('UPDATE public.skill_learning_scope SET last_attempt_key=$3 WHERE owner_id=$1 AND contact_id=$2',
        [scope.owner_id,scope.contact_id,batch.key]);
      return batch;
    });
  }
  async validate(scope:SkillLearningScope,claim:ExtractionClaim,batch:SkillLearningBatch):Promise<void>{
    await this.withScope(scope,async client=>{
      await this.options.taskStore.assertLease(client,claim);
      if(!await this.learningAllowed(client,scope))throw new SkillLearningInvalid();
      const current=await selectLearningBatch(client,scope,this.options.files,this.visit(),batch.materials.map(item=>item.material_id));
      if(current.key!==batch.key)throw new SkillLearningInvalid();
    });
  }
  async save(scope:SkillLearningScope,claim:ExtractionClaim,batch:SkillLearningBatch,proposal:unknown):Promise<number>{
    return this.withScope(scope,async client=>{
      await this.options.taskStore.assertLease(client,claim);
      if(!await this.learningAllowed(client,scope))throw new SkillLearningInvalid();
      const current=await selectLearningBatch(client,scope,this.options.files,this.visit(),batch.materials.map(item=>item.material_id));
      if(current.key!==batch.key)throw new SkillLearningInvalid();
      const normalized=normalizeProposal(scope,batch,proposal);
      let draftId:string|null=null;
      if(normalized.proposal){
        if(normalized.proposal.proposal_kind==='create'&&(await client.query(`SELECT 1 FROM public.reply_skill
          WHERE owner_id=$1 AND (contact_id IS NULL OR contact_id=$2) AND status<>'deleted' AND name=$3 LIMIT 1`,
        [scope.owner_id,scope.contact_id,normalized.proposal.strategy.name])).rowCount)throw new SkillLearningInvalid();
        const contact=(await client.query('SELECT display_name FROM public.contact WHERE owner_id=$1 AND id=$2',
          [scope.owner_id,scope.contact_id])).rows[0];
        if(contact&&Array.from(contact.display_name as string).length>=2&&normalized.proposal.strategy.document.includes(contact.display_name))
          throw new SkillLearningInvalid();
        draftId=randomUUID();
        await client.query(`INSERT INTO public.skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,
          strategy,private_evidence,target_versions,dependency_ids,batch_key,source_generation)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [draftId,scope.owner_id,scope.contact_id,normalized.proposal.logical_skill_id,normalized.proposal.proposal_kind,
          normalized.proposal.strategy,{materials:batch.materials,existing_skills:batch.targets,
            source_dependencies:batch.dependency_ids},JSON.stringify(normalized.proposal.target_versions),
          batch.dependency_ids,batch.key,batch.source_generation]);
        for(const method of normalized.proposal.strategy.methods){
          await client.query(`INSERT INTO public.skill_method_identity(owner_id,logical_skill_id,method_id,semantic_key_sha256)
            VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [scope.owner_id,normalized.proposal.logical_skill_id,method.method_id,skillContentDigest(method.key)]);
        }
      }
      const batchId=(await client.query(`INSERT INTO public.skill_learning_batch
        (owner_id,contact_id,task_id,batch_key,outcome,draft_id,dependency_ids) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [scope.owner_id,scope.contact_id,claim.taskId,batch.key,normalized.outcome,draftId,batch.dependency_ids])).rows[0].id;
      for(const material of batch.materials){
        await client.query(`INSERT INTO public.skill_learning_receipt(owner_id,contact_id,material_id,digest,batch_id)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [scope.owner_id,scope.contact_id,material.material_id,material.digest,batchId]);
      }
      const more=await selectLearningBatch(client,scope,this.options.files,this.visit());
      if(more.ready)await client.query('UPDATE public.background_task SET observation_pending=true WHERE id=$1',[claim.taskId]);
      return batch.materials.length;
    });
  }
  async verify(scope:SkillLearningScope):Promise<void>{
    return this.withScope(scope,async client=>{
      if(!await this.learningAllowed(client,scope))throw new SkillLearningInvalid();
      await this.clearUnavailable(client,scope);
    });
  }
  async enqueue(scope:SkillLearningScope,forceRetry=false):Promise<string|null>{
    return this.withScope(scope,async client=>{
      if(!await this.learningAllowed(client,scope))return null;
      const row=(await client.query(`SELECT id,status FROM public.background_task
        WHERE owner_id=$1 AND contact_id=$2 AND task_type='skill_learning' FOR UPDATE`,[scope.owner_id,scope.contact_id])).rows[0];
      const batch=await selectLearningBatch(client,scope,this.options.files,this.visit());
      if(row&&['queued','running','verifying'].includes(row.status)){
        if(row.status==='queued'&&batch.ready)await markQueuedAttempt(client,scope,row.id,batch.key);
        const attempted=(await client.query('SELECT last_attempt_key FROM public.skill_learning_scope WHERE owner_id=$1 AND contact_id=$2',
          [scope.owner_id,scope.contact_id])).rows[0]?.last_attempt_key;
        if(row.status!=='queued'&&batch.ready&&attempted!==batch.key)
          await client.query('UPDATE public.background_task SET observation_pending=true WHERE id=$1',[row.id]);
        return row.id;
      }
      if(row&&row.status==='failed'&&forceRetry
        &&(await recoverCommittedBatch(client,scope,row.id,batch.ready,this.options.requireDiscussionDependencies)
          ||await recoverEmptyVerification(client,row.id,batch.ready)))return row.id;
      if(!batch.ready)return null;
      if(!row){
        const taskId=(await client.query(`INSERT INTO public.background_task
          (owner_id,contact_id,task_type,status,current_step,message_count)
          VALUES($1,$2,'skill_learning','queued','propose_skill',$3) RETURNING id`,[scope.owner_id,scope.contact_id,batch.materials.length])).rows[0].id;
        for(const [index,step] of SKILL_LEARNING_STEPS.entries())await client.query(`INSERT INTO public.background_task_step
          (task_id,step_name,step_order,total_count) VALUES($1,$2,$3,$4)`,[taskId,step,index+1,batch.materials.length]);
        await markQueuedAttempt(client,scope,taskId,batch.key);return taskId;
      }
      if(['failed','cancelled','succeeded'].includes(row.status)){
        const attempted=(await client.query('SELECT last_attempt_key FROM public.skill_learning_scope WHERE owner_id=$1 AND contact_id=$2',
          [scope.owner_id,scope.contact_id])).rows[0]?.last_attempt_key;
        if(row.status==='failed'&&!forceRetry&&attempted===batch.key)return null;
        await resetLearningTask(client,row.id,batch.materials.length);
        await markQueuedAttempt(client,scope,row.id,batch.key);
      }
      return row.id;
    });
  }
}
async function markQueuedAttempt(client:pg.Client,scope:SkillLearningScope,taskId:string,key:string):Promise<void>{
  await client.query(`UPDATE public.skill_learning_scope setting SET last_attempt_key=$4
    WHERE setting.owner_id=$1 AND setting.contact_id=$2 AND EXISTS(
      SELECT 1 FROM public.background_task task JOIN public.background_task_step step ON step.task_id=task.id
      WHERE task.id=$3 AND task.owner_id=setting.owner_id AND task.contact_id=setting.contact_id
        AND task.task_type='skill_learning' AND task.status='queued' AND task.current_step='propose_skill'
        AND step.step_name='propose_skill' AND step.status='pending' AND step.attempt_count=0)`,
  [scope.owner_id,scope.contact_id,taskId,key]);
}
export async function resetLearningTask(client:pg.Client,taskId:string,count:number):Promise<void>{
  await client.query(`UPDATE public.background_task_step SET status='pending',attempt_count=0,processed_count=0,
    worker_id=NULL,lease_expires_at=NULL,last_error_code=NULL,started_at=NULL,finished_at=NULL WHERE task_id=$1`,[taskId]);
  await client.query(`UPDATE public.background_task SET status='queued',current_step='propose_skill',message_count=$2,
    observation_pending=false,last_error_code=NULL,started_at=NULL,finished_at=NULL WHERE id=$1`,[taskId,count]);
}
export async function cancelLearningTasks(client:pg.Client,scope:SkillLearningScope):Promise<void>{
  await client.query(`UPDATE public.background_task_step SET status='cancelled',worker_id=NULL,lease_expires_at=NULL
    WHERE task_id IN(SELECT id FROM public.background_task WHERE owner_id=$1 AND contact_id=$2 AND task_type='skill_learning')
      AND status<>'succeeded'`,[scope.owner_id,scope.contact_id]);
  await client.query(`UPDATE public.background_task SET status='cancelled',observation_pending=false
    WHERE owner_id=$1 AND contact_id=$2 AND task_type='skill_learning' AND status IN('queued','running','verifying','failed')`,
  [scope.owner_id,scope.contact_id]);
  await client.query('UPDATE public.skill_learning_scope SET last_attempt_key=NULL WHERE owner_id=$1 AND contact_id=$2',
    [scope.owner_id,scope.contact_id]);
}
async function queueVerification(client:pg.Client,taskId:string,observationPending:boolean):Promise<void>{
  await client.query(`UPDATE public.background_task_step SET status='pending',attempt_count=0,worker_id=NULL,
    lease_expires_at=NULL,lease_generation=lease_generation+1,last_error_code=NULL,finished_at=NULL,updated_at=now()
    WHERE task_id=$1 AND step_name='verify_skill_drafts'`,[taskId]);
  await client.query(`UPDATE public.background_task SET status='queued',current_step='verify_skill_drafts',
    observation_pending=$2,last_error_code=NULL,finished_at=NULL,updated_at=now() WHERE id=$1`,[taskId,observationPending]);
}
async function recoverCommittedBatch(client:pg.Client,scope:SkillLearningScope,taskId:string,observationPending:boolean,
  requireDiscussionDependencies?:SkillDiscussionValidator):Promise<boolean>{
  const row=(await client.query(`SELECT batch.id,batch.dependency_ids,batch.draft_id,draft.status,draft.source_generation
    FROM public.skill_learning_batch batch JOIN public.skill_learning_scope setting
      ON setting.owner_id=batch.owner_id AND setting.contact_id=batch.contact_id
    JOIN public.background_task_step proposed ON proposed.task_id=batch.task_id AND proposed.step_name='propose_skill'
    LEFT JOIN public.skill_draft draft ON draft.id=batch.draft_id AND draft.owner_id=batch.owner_id AND draft.contact_id=batch.contact_id
    WHERE batch.owner_id=$1 AND batch.contact_id=$2 AND batch.task_id=$3 AND batch.created_at>=proposed.started_at
      AND batch.batch_key=setting.last_attempt_key AND batch.outcome<>'invalidated' FOR UPDATE OF batch`,
  [scope.owner_id,scope.contact_id,taskId])).rows[0];
  if(!row)return false;
  if(!await dependenciesAreCurrent(client,scope,row.dependency_ids??[],requireDiscussionDependencies)
    ||row.draft_id&&(!['pending','rejected','published'].includes(row.status)
      ||!await generationIsCurrent(client,scope,row.source_generation??{})))return false;
  const counts=(await client.query('SELECT count(*)::int AS count,count(digest)::int AS available FROM public.skill_learning_receipt WHERE owner_id=$1 AND contact_id=$2 AND batch_id=$3',
    [scope.owner_id,scope.contact_id,row.id])).rows[0];
  if(counts.count<1||counts.count>8||counts.available!==counts.count)return false;
  await client.query(`UPDATE public.background_task_step SET status='succeeded',processed_count=$2,total_count=$2,
    worker_id=NULL,lease_expires_at=NULL,lease_generation=lease_generation+1,last_error_code=NULL,finished_at=now(),updated_at=now()
    WHERE task_id=$1 AND step_name='propose_skill'`,[taskId,counts.count]);
  await queueVerification(client,taskId,observationPending);return true;
}
async function recoverEmptyVerification(client:pg.Client,taskId:string,observationPending:boolean):Promise<boolean>{
  if(!(await client.query(`SELECT 1 FROM public.background_task_step proposed
    JOIN public.background_task_step verification ON verification.task_id=proposed.task_id
    WHERE proposed.task_id=$1 AND proposed.step_name='propose_skill' AND proposed.status='succeeded'
      AND proposed.processed_count=0 AND verification.step_name='verify_skill_drafts' AND verification.status<>'succeeded'`,
  [taskId])).rowCount)return false;
  await queueVerification(client,taskId,observationPending);return true;
}
