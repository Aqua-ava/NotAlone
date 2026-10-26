/** 分层记忆管理的原表事务；模型和租约执行继续由唯一 TaskStore/Worker 持有。 */
import type {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import {readReplyContactOverview,readReplyOwnerOverview} from '../../../reply/context/reply-context-overview.ts';
import type {ContextMetadata} from '../../../reply/context/reply-context-types.ts';
import {scenarioDigest,canonicalScenarioJSON,type L2ScenarioBudget,type L2ScenarioScope} from '../../scenarios/workspace.ts';
import {deleteSourceReplies} from '../../../preferences/preference-erasure.ts';
import {filterLayeredMemoryManagementEntries} from './source-policy.ts';
import {epochMicros} from '../../overview/projection/time.ts';

export type ManagementRow=Record<string,any>;
export type ManagementTransaction=<T>(work:(client:Client)=>Promise<T>)=>Promise<T>;

export class LayeredMemoryManagementError extends Error {
  readonly code:string;
  readonly status:number;
  constructor(code='layered_memory_changed',status=409){super(code);this.code=code;this.status=status;}
}

export async function lockManagementScope(client:Client,scope:L2ScenarioScope):Promise<void>{
  if(scope.contact_id!==null)await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[
    `contact:${scope.owner_id}:${scope.contact_id}`]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${scope.owner_id}`]);
  const found=scope.contact_id===null
    ? await client.query('SELECT 1 FROM public.owner WHERE id=$1',[scope.owner_id])
    : await client.query('SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2',[scope.owner_id,scope.contact_id]);
  if(!found.rowCount)throw new LayeredMemoryManagementError('layered_memory_not_found',404);
  await client.query(`INSERT INTO public.layered_memory_state(owner_id,contact_id) VALUES($1,$2)
    ON CONFLICT DO NOTHING`,[scope.owner_id,scope.contact_id]);
}

export async function managementState(client:Client,scope:L2ScenarioScope):Promise<ManagementRow>{
  const state=(await client.query(`SELECT * FROM public.layered_memory_state
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid FOR UPDATE`,[scope.owner_id,scope.contact_id])).rows[0];
  if(!state)throw new LayeredMemoryManagementError('layered_memory_not_found',404);
  return state;
}

export async function managementInputs(client:Client,scope:L2ScenarioScope,now:Date):Promise<{
  entries:ContextMetadata[];manifest:ManagementRow[];dependencies:string[];
}>{
  const snapshot=scope.contact_id===null?await readReplyOwnerOverview(client,scope.owner_id,true)
    :await readReplyContactOverview(client,{owner_id:scope.owner_id,contact_id:scope.contact_id});
  const nowMicros=BigInt(now.getTime())*1_000n;
  const boundaries=snapshot.entries.flatMap(entry=>[entry.memory.valid_at,entry.memory.invalid_at])
    .filter((value):value is string=>typeof value==='string'&&epochMicros(value)>nowMicros)
    .sort((left,right)=>epochMicros(left)<epochMicros(right)?-1:epochMicros(left)>epochMicros(right)?1:0);
  await client.query(`UPDATE public.layered_memory_state SET next_boundary_at=$3,
    dirty_revision=dirty_revision+CASE WHEN next_boundary_at<=$4 THEN 1 ELSE 0 END,
    next_due_at=CASE WHEN next_boundary_at<=$4 THEN $4 ELSE next_due_at END
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
      AND next_boundary_at IS DISTINCT FROM $3::timestamptz`,[scope.owner_id,scope.contact_id,boundaries[0]??null,now]);
  const feedback=(await client.query(`SELECT protected_memory_ids,protected_message_ids,dependency_ids
    FROM public.layered_memory_feedback WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
    AND state IN ('active','erased_guard')`,[scope.owner_id,scope.contact_id])).rows;
  const protectedMemories=new Set(feedback.flatMap(row=>row.protected_memory_ids));
  const protectedMessages=new Set(feedback.flatMap(row=>row.protected_message_ids));
  const entries=(await filterLayeredMemoryManagementEntries(client,scope,snapshot.entries)).filter(entry=>{
    const memory=entry.memory;
    return ['manual_entry','source_supported'].includes(entry.provenance?.kind)
      && memory.status==='active'&&entry.is_latest&&entry.current_leaf
      && typeof memory.text==='string'&&memory.text.trim()
      && (!memory.valid_at||epochMicros(memory.valid_at)<=nowMicros)
      && (!memory.invalid_at||epochMicros(memory.invalid_at)>nowMicros)
      && !protectedMemories.has(memory.memory_id)
      && !(entry.provenance?.references??[]).some((ref:ManagementRow)=>protectedMessages.has(ref.message_id));
  });
  const manifest=entries.map(entry=>{
    if(!entry.dependency_manifest||entry.dependency_manifest.memory_id!==entry.memory.memory_id)
      throw new LayeredMemoryManagementError();
    return {...entry.dependency_manifest,organization_timing_sha256:scenarioDigest(entry.memory.timing??{})};
  });
  const dependencies=[...new Set<string>([
    ...entries.flatMap(entry=>[entry.memory.memory_id,...(entry.dependency_ids??[])]),
    ...feedback.flatMap(row=>[...row.dependency_ids,...row.protected_memory_ids,...row.protected_message_ids]),
  ])].sort();
  return {entries,manifest,dependencies};
}

export async function managementJobs(client:Client,scope:L2ScenarioScope):Promise<ManagementRow[]>{
  return (await client.query(`SELECT j.*,t.status AS task_status,t.last_error_code
    FROM public.layered_memory_job j JOIN public.background_task t ON t.id=j.task_id
    WHERE j.owner_id=$1 AND j.contact_id IS NOT DISTINCT FROM $2::uuid
    ORDER BY j.settings_generation DESC,j.created_at DESC,j.task_id DESC FOR UPDATE OF j,t`,
  [scope.owner_id,scope.contact_id])).rows;
}

export async function refreshManagementGeneration(client:Client,scope:L2ScenarioScope,state:ManagementRow,
  inputs:Awaited<ReturnType<typeof managementInputs>>):Promise<ManagementRow>{
  const generation=(await client.query(`SELECT * FROM public.layered_memory_generation
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND organization_generation=$3`,
  [scope.owner_id,scope.contact_id,state.organization_generation])).rows[0];
  if(!generation)return state;
  const current=new Map(inputs.manifest.map(item=>[item.memory_id,canonicalScenarioJSON(item)]));
  const matches=(items:ManagementRow[])=>Array.isArray(items)
    &&items.every(item=>current.get(item.memory_id)===canonicalScenarioJSON(item));
  const rows=(await client.query(`SELECT v.id,b.input_manifest,b.dependency_ids FROM public.scenario_document_version v
    JOIN public.layered_memory_batch b ON b.id=v.batch_id WHERE v.owner_id=$1
      AND v.contact_id IS NOT DISTINCT FROM $2::uuid AND v.id=ANY($3::uuid[])`,
  [scope.owner_id,scope.contact_id,generation.scenario_version_ids])).rows;
  const retained=rows.filter(row=>matches(row.input_manifest));
  const profile=generation.profile_version_id?(await client.query(`SELECT v.id,v.withdrawn,b.input_manifest,b.dependency_ids
    FROM public.layered_profile_version v JOIN public.layered_profile_batch b ON b.id=v.batch_id
    WHERE v.id=$1 AND v.owner_id=$2 AND v.contact_id IS NOT DISTINCT FROM $3::uuid`,
  [generation.profile_version_id,scope.owner_id,scope.contact_id])).rows[0]:null;
  const profileId=profile&&!profile.withdrawn&&matches(profile.input_manifest)?profile.id:null;
  if(retained.length===generation.scenario_version_ids.length&&profileId===generation.profile_version_id)return state;
  const next=Number(state.organization_generation)+1;
  const dependencies=[...new Set<string>([...retained.flatMap(row=>row.dependency_ids),...(profileId?profile.dependency_ids:[])])].sort();
  await client.query(`INSERT INTO public.layered_memory_generation(owner_id,contact_id,organization_generation,schema_version,
    scenario_version_ids,profile_version_id,dependency_ids) VALUES($1,$2,$3,2,$4,$5,$6)`,
  [scope.owner_id,scope.contact_id,next,retained.map(row=>row.id),profileId,dependencies]);
  const covered=new Set(retained.flatMap(row=>row.input_manifest.map((item:ManagementRow)=>item.memory_id))).size;
  await client.query(`UPDATE public.layered_memory_state SET organization_generation=$3,covered_count=$4,
    status=CASE WHEN enabled THEN $5 ELSE 'disabled' END,error_code=NULL
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,
  [scope.owner_id,scope.contact_id,next,covered,retained.length?'stale':'empty']);
  return managementState(client,scope);
}

export async function cancelManagementJobs(client:Client,scope:L2ScenarioScope,erase=false):Promise<string[]>{
  const ids=(await client.query(`UPDATE public.background_task SET status='cancelled',finished_at=now(),updated_at=now()
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND task_type='layered_memory'
    AND id IN (SELECT task_id FROM public.layered_memory_job WHERE owner_id=$1
      AND contact_id IS NOT DISTINCT FROM $2::uuid AND ($3 OR state<>'invalidated'))
    AND status<>'succeeded' RETURNING id`,[scope.owner_id,scope.contact_id,erase])).rows.map(row=>row.id);
  await client.query(`UPDATE public.background_task_step SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,
    lease_generation=lease_generation+1,updated_at=now()
    WHERE task_id IN (SELECT task_id FROM public.layered_memory_job WHERE owner_id=$1
      AND contact_id IS NOT DISTINCT FROM $2::uuid AND ($3 OR state<>'invalidated')) AND status<>'succeeded'`,
  [scope.owner_id,scope.contact_id,erase]);
  if(erase)await client.query(`DELETE FROM public.layered_memory_job
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,[scope.owner_id,scope.contact_id]);
  else await client.query(`UPDATE public.layered_memory_job SET state='invalidated',target_manifest='[]',
    dependency_ids='{}',revision=revision+1,pending_receipt=false,receipt_batch_id=NULL,receipt_lease_generation=NULL
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND state NOT IN ('complete','invalidated')`,
  [scope.owner_id,scope.contact_id]);
  return ids;
}

export async function cancelInvalidatedManagementJobs(client:Client,scope:L2ScenarioScope):Promise<string[]>{
  const ids=(await client.query(`UPDATE public.background_task t SET status='cancelled',finished_at=now(),updated_at=now()
    FROM public.layered_memory_job j WHERE t.id=j.task_id AND j.owner_id=$1
    AND j.contact_id IS NOT DISTINCT FROM $2::uuid AND j.state='invalidated'
    AND t.status NOT IN ('succeeded','cancelled') RETURNING t.id`,[scope.owner_id,scope.contact_id])).rows.map(row=>row.id);
  if(ids.length)await client.query(`UPDATE public.background_task_step SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,
    lease_generation=lease_generation+1,updated_at=now() WHERE task_id=ANY($1::uuid[]) AND status<>'succeeded'`,[ids]);
  return ids;
}

export async function disableManagementScope(client:Client,scope:L2ScenarioScope,erase:boolean):Promise<string[]>{
  if(erase){
    const versions=(await client.query(`SELECT id FROM public.scenario_document_version
      WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
      UNION SELECT id FROM public.layered_profile_version
      WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,[scope.owner_id,scope.contact_id])).rows;
    await deleteSourceReplies(client,scope.owner_id,versions.map(row=>row.id),scope.contact_id,false);
  }
  const cancelled=await cancelManagementJobs(client,scope,erase);
  if(erase){
    // 已有表的外键负责级联；同时覆盖没有 task_id 的合法旧批次，不能留下恢复正文。
    for(const table of ['organization_quality_case','layered_memory_feedback','layered_memory_fact_correction',
      'layered_memory_generation','layered_profile_batch','layered_memory_batch'])
      await client.query(`DELETE FROM public.${table} WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,
      [scope.owner_id,scope.contact_id]);
  }else{
    for(const table of ['layered_profile_batch','layered_memory_batch'])await client.query(`DELETE FROM public.${table}
      WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND status='running'`,[scope.owner_id,scope.contact_id]);
  }
  await client.query(`UPDATE public.layered_memory_state SET enabled=false,settings_generation=settings_generation+1,
    status='disabled',error_code=NULL,last_action=$3,covered_count=CASE WHEN $4 THEN 0 ELSE covered_count END,
    updated_at=CASE WHEN $4 THEN NULL ELSE updated_at END,
    organization_generation=organization_generation+CASE WHEN $4 THEN 1 ELSE 0 END,
    correction_revision=CASE WHEN $4 THEN 0 ELSE correction_revision END,next_due_at=NULL
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,[scope.owner_id,scope.contact_id,erase?'delete':'disable',erase]);
  return cancelled;
}

export async function enqueueManagementJob(client:Client,scope:L2ScenarioScope,state:ManagementRow,
  inputs:Awaited<ReturnType<typeof managementInputs>>,budget:L2ScenarioBudget,contract:string,
  action:string,revision?:number):Promise<{taskId:string;execute:boolean;cancelled:string[]}>{
  let key=scenarioDigest({inputs:inputs.manifest,settings_generation:Number(state.settings_generation),
    correction_revision:Number(state.correction_revision),contract,budget});
  const jobs=await managementJobs(client,scope),byKey=new Map(jobs.map(row=>[row.target_key,row]));
  let job=byKey.get(key);
  while(job?.state==='invalidated'){
    key=scenarioDigest({target_key:key,invalidated_task_id:job.task_id});job=byKey.get(key);
  }
  if(action==='pause'||action==='continue'){
    job=jobs.find(row=>Number(row.settings_generation)===Number(state.settings_generation));
    if(!job||revision===undefined)throw new LayeredMemoryManagementError();
    if(Number(job.revision)!==revision){
      if(Number(job.revision)===revision+1&&job.last_action===action)return {taskId:job.task_id,execute:false,cancelled:[]};
      throw new LayeredMemoryManagementError();
    }
    if(job.target_key!==key||job.state==='invalidated')throw new LayeredMemoryManagementError();
    if(action==='pause'&&(job.state==='complete'||job.task_status==='succeeded'))throw new LayeredMemoryManagementError();
    if(action==='continue'){
      if(job.state==='complete')return {taskId:job.task_id,execute:false,cancelled:[]};
      if(!['paused','failed'].includes(job.state)||job.task_status==='cancelled')throw new LayeredMemoryManagementError();
      if(job.last_error_code==='model_call_outcome_unknown'||(await client.query(`SELECT 1 FROM public.model_call_receipt
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND request_id=$3
        AND outcome IN ('pending','unknown') LIMIT 1`,[scope.owner_id,scope.contact_id,job.task_id])).rowCount)
        throw new LayeredMemoryManagementError();
      await client.query(`UPDATE public.layered_memory_job SET state='active',revision=revision+1,last_action='continue',
        run_remaining=1,model_call_limit=model_call_limit+$2,
        profile_status=CASE WHEN profile_status='failed' THEN 'pending' ELSE profile_status END WHERE task_id=$1`,
      [job.task_id,budget.max_model_calls]);
      await client.query(`UPDATE public.background_task SET status='queued',last_error_code=NULL,finished_at=NULL,updated_at=now()
        WHERE id=$1`,[job.task_id]);
      await client.query(`UPDATE public.background_task_step SET status='pending',attempt_count=0,worker_id=NULL,
        lease_expires_at=NULL,lease_generation=lease_generation+1,last_error_code=NULL,finished_at=NULL,updated_at=now()
        WHERE task_id=$1`,[job.task_id]);
      await client.query(`UPDATE public.layered_memory_state SET status='updating',error_code=NULL
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,[scope.owner_id,scope.contact_id]);
      return {taskId:job.task_id,execute:true,cancelled:[]};
    }
    await client.query(`UPDATE public.layered_memory_job SET state='paused',revision=revision+1,last_action='pause'
      WHERE task_id=$1`,[job.task_id]);
    await client.query(`UPDATE public.layered_memory_state SET status='paused'
      WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,[scope.owner_id,scope.contact_id]);
    await client.query(`UPDATE public.background_task_step SET status='pending',worker_id=NULL,lease_expires_at=NULL,
      lease_generation=lease_generation+1,updated_at=now() WHERE task_id=$1`,[job.task_id]);
    return {taskId:job.task_id,execute:false,cancelled:[job.task_id]};
  }
  if(job){
    if(job.state==='complete')await client.query(`UPDATE public.layered_memory_state
      SET consumed_revision=dirty_revision,next_due_at=NULL
      WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,[scope.owner_id,scope.contact_id]);
    return {taskId:job.task_id,execute:job.state==='active',cancelled:[]};
  }
  // 新 target 或新设置代次也不能绕过旧调用未知；由原台账恢复流程决定何时解除。
  if((await client.query(`SELECT 1 FROM public.background_task t WHERE t.owner_id=$1
    AND t.contact_id IS NOT DISTINCT FROM $2::uuid AND t.task_type='layered_memory'
    AND (t.last_error_code='model_call_outcome_unknown' OR EXISTS(
      SELECT 1 FROM public.model_call_receipt receipt WHERE receipt.owner_id=t.owner_id
        AND receipt.contact_id IS NOT DISTINCT FROM t.contact_id AND receipt.request_id=t.id
        AND receipt.outcome='unknown')) LIMIT 1`,[scope.owner_id,scope.contact_id])).rowCount)
    throw new LayeredMemoryManagementError();
  const cancelled=await cancelManagementJobs(client,scope),taskId=randomUUID();
  await client.query(`INSERT INTO public.background_task(id,owner_id,contact_id,task_type,status,current_step,message_count)
    VALUES($1,$2,$3,'layered_memory','queued','organize_memory',$4)`,[taskId,scope.owner_id,scope.contact_id,inputs.manifest.length]);
  await client.query(`INSERT INTO public.background_task_step(task_id,step_name,step_order,status,total_count)
    VALUES($1,'organize_memory',1,'pending',$2)`,[taskId,inputs.manifest.length]);
  await client.query(`INSERT INTO public.layered_memory_job(task_id,owner_id,contact_id,settings_generation,target_key,
    contract,target_manifest,dependency_ids,state,run_remaining,model_call_limit,profile_required,profile_status,target_dirty_revision)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',1,$9,true,'pending',$10)`,
  [taskId,scope.owner_id,scope.contact_id,state.settings_generation,key,contract,JSON.stringify(inputs.manifest),
    inputs.dependencies,budget.max_model_calls,state.dirty_revision]);
  if(!inputs.manifest.length){
    await client.query(`UPDATE public.layered_memory_job SET state='complete',profile_status='not_required' WHERE task_id=$1`,[taskId]);
    await client.query(`UPDATE public.background_task SET status='succeeded',finished_at=now(),updated_at=now() WHERE id=$1`,[taskId]);
    await client.query(`UPDATE public.background_task_step SET status='succeeded',finished_at=now(),updated_at=now() WHERE task_id=$1`,[taskId]);
    const nextGeneration=Number(state.organization_generation)+1;
    await client.query(`INSERT INTO public.layered_memory_generation(owner_id,contact_id,organization_generation,
      schema_version,scenario_version_ids,dependency_ids) VALUES($1,$2,$3,2,'{}','{}')`,[scope.owner_id,scope.contact_id,nextGeneration]);
    await client.query(`UPDATE public.layered_memory_state SET status='empty',covered_count=0,error_code=NULL,
      organization_generation=$3,consumed_revision=dirty_revision,next_due_at=NULL,updated_at=now()
      WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,[scope.owner_id,scope.contact_id,nextGeneration]);
    return {taskId,execute:false,cancelled};
  }
  await client.query(`UPDATE public.layered_memory_state SET status='updating',error_code=NULL,next_due_at=NULL
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,[scope.owner_id,scope.contact_id]);
  return {taskId,execute:true,cancelled};
}
