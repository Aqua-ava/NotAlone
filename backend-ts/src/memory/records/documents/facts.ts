/** 事实报错仅保存真实叶版本与来源身份；不改写 L1 或把报错变成长期偏好。 */
import type {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import type {L2ScenarioScope} from '../../scenarios/workspace.ts';
import {scenarioDigest} from '../../scenarios/workspace.ts';
import {readReplyContactOverview,readReplyOwnerOverview} from '../../../reply/context/reply-context-overview.ts';
import {deleteSourceReplies} from '../../../preferences/preference-erasure.ts';
import {epochMicros} from '../../overview/projection/time.ts';
import {LayeredMemoryManagementError,managementInputs,cancelManagementJobs,
  type ManagementRow} from './store.ts';

export interface LayeredMemoryFactError {
  settings_generation:number;organization_generation:number;
  target_kind:'scenario'|'profile';version_id:string;item_index:number;memory_id:string;
}

export async function reportManagementFactError(client:Client,scope:L2ScenarioScope,state:ManagementRow,
  command:LayeredMemoryFactError,now:Date):Promise<{target:{memory_id:string;revision:number};cancelled:string[]}>{
  const digest=scenarioDigest(command);
  const prior=(await client.query(`SELECT * FROM public.layered_memory_fact_correction
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND settings_generation=$3
    AND request_digest=$4`,[scope.owner_id,scope.contact_id,command.settings_generation,digest])).rows[0];
  const snapshot=scope.contact_id===null?await readReplyOwnerOverview(client,scope.owner_id,true)
    :await readReplyContactOverview(client,{owner_id:scope.owner_id,contact_id:scope.contact_id});
  const inputs=await managementInputs(client,scope,now);
  if(prior&&Number(state.settings_generation)===command.settings_generation){
    const leaf=snapshot.entries.find(entry=>entry.memory.memory_id===prior.memory_id
      &&entry.memory.revision===Number(prior.memory_revision)&&entry.memory.status==='active'&&entry.is_latest
      &&['manual_entry','source_supported'].includes(entry.provenance?.kind)
      &&(!entry.memory.valid_at||epochMicros(entry.memory.valid_at)<=BigInt(now.getTime())*1_000n)
      &&(!entry.memory.invalid_at||epochMicros(entry.memory.invalid_at)>BigInt(now.getTime())*1_000n));
    if(!leaf)throw new LayeredMemoryManagementError();
    return {target:{memory_id:prior.memory_id,revision:Number(prior.memory_revision)},cancelled:[]};
  }
  if(Number(state.settings_generation)!==command.settings_generation||Number(state.organization_generation)!==command.organization_generation)
    throw new LayeredMemoryManagementError();
  const generation=(await client.query(`SELECT * FROM public.layered_memory_generation
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND organization_generation=$3`,
  [scope.owner_id,scope.contact_id,command.organization_generation])).rows[0];
  let items:ManagementRow[]=[];
  if(command.target_kind==='scenario'&&generation?.scenario_version_ids.includes(command.version_id)){
    items=(await client.query(`SELECT paragraphs FROM public.scenario_document_version
      WHERE id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3::uuid`,
    [command.version_id,scope.owner_id,scope.contact_id])).rows[0]?.paragraphs??[];
  }else if(command.target_kind==='profile'&&generation?.profile_version_id===command.version_id){
    items=(await client.query(`SELECT entries FROM public.layered_profile_version
      WHERE id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3::uuid AND NOT withdrawn`,
    [command.version_id,scope.owner_id,scope.contact_id])).rows[0]?.entries??[];
  }
  if(!items[command.item_index]?.references?.some((reference:ManagementRow)=>reference.memory_id===command.memory_id))
    throw new LayeredMemoryManagementError();
  const selected=snapshot.entries.find(entry=>entry.memory.memory_id===command.memory_id);
  const leaf=selected?.current_leaf&&inputs.entries.find(entry=>entry.memory.memory_id===selected.current_leaf.memory_id);
  if(!leaf)throw new LayeredMemoryManagementError();
  const memoryId=leaf.memory.memory_id,revision=leaf.memory.revision;
  const dependencies=[...new Set<string>([memoryId,...leaf.dependency_ids])].sort();
  const manifest=inputs.manifest.find(item=>item.memory_id===memoryId)!;
  const refs=(manifest.source_refs??[]).map((ref:ManagementRow)=>ref.ref_id).filter(Boolean);
  const observations=(await client.query(`SELECT id FROM public.local_wechat_observation
    WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR contact_id=$3)`,
  [scope.owner_id,dependencies,scope.contact_id])).rows.map(row=>row.id);
  const messages=[...new Set<string>((leaf.provenance?.references??[]).map((ref:ManagementRow)=>ref.message_id).filter(Boolean))].sort();
  const sourceMode=leaf.memory.source_dependency_mode??'any';
  if(!['any','all'].includes(sourceMode))throw new LayeredMemoryManagementError();
  await client.query(`INSERT INTO public.layered_memory_fact_correction(id,owner_id,contact_id,settings_generation,
    request_digest,memory_id,memory_revision,source_dependency_mode,dependency_ids,protected_message_ids,observation_ids,source_ref_ids)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [randomUUID(),scope.owner_id,scope.contact_id,state.settings_generation,digest,memoryId,revision,sourceMode,
    dependencies,messages,observations,refs]);
  // 该叶曾作为上下文参与也要撤下；不能仅删除直接引用它的那一个段落。
  const versions=(await client.query(`SELECT v.id FROM public.scenario_document_version v
    JOIN public.layered_memory_batch b ON b.id=v.batch_id WHERE b.owner_id=$1
      AND b.contact_id IS NOT DISTINCT FROM $2::uuid AND $3=ANY(b.dependency_ids)
    UNION SELECT v.id FROM public.layered_profile_version v
    JOIN public.layered_profile_batch b ON b.id=v.batch_id WHERE b.owner_id=$1
      AND b.contact_id IS NOT DISTINCT FROM $2::uuid AND $3=ANY(b.dependency_ids)`,
  [scope.owner_id,scope.contact_id,memoryId])).rows.map(row=>row.id);
  await deleteSourceReplies(client,scope.owner_id,versions,scope.contact_id,false);
  await client.query(`DELETE FROM public.scenario_document_version WHERE owner_id=$1
    AND contact_id IS NOT DISTINCT FROM $2::uuid AND id=ANY($3::uuid[])`,[scope.owner_id,scope.contact_id,versions]);
  await client.query(`UPDATE public.layered_profile_version SET withdrawn=true WHERE owner_id=$1
    AND contact_id IS NOT DISTINCT FROM $2::uuid AND id=ANY($3::uuid[])`,[scope.owner_id,scope.contact_id,versions]);
  const cancelled=await cancelManagementJobs(client,scope);
  await client.query('SELECT public.bump_layered_correction_revision($1,$2)',[scope.owner_id,scope.contact_id]);
  return {target:{memory_id:memoryId,revision},cancelled};
}
