/** 冻结来源及纠错范围；只读产品层，不创建第二套记忆算法或发布路径。 */
import type {Client} from 'pg';
import {managementInputs,managementState} from './layered-memory-management-store.ts';
import type {L2ScenarioMemory,L2ScenarioScope,L2ScenarioVersion} from './l2-scenario-workspace.ts';
import {qualityConflict,qualityDigest,qualityInvalid,qualityJSON,qualitySpacedJSON,type QualityRow,type OrganizationQualityBudget} from './organization-quality-contract.ts';

export function qualityMemory(entry:QualityRow):L2ScenarioMemory {
  const memory=entry.memory;
  return {memory_id:memory.memory_id,revision:memory.revision,level:memory.level==='owner'?'owner':'contact',text:memory.text,
    category:memory.category,provenance_kind:entry.provenance.kind,timing:structuredClone(memory.timing??{}),
    event:structuredClone(memory.event??null),conditions:structuredClone(memory.conditions??null),evolution:structuredClone(memory.evolution??null),
    valid_at:memory.valid_at??null,invalid_at:memory.invalid_at??null,dependency_ids:[...(entry.dependency_ids??[])].sort(),
    message_ids:[...new Set<string>((entry.provenance.references??[]).map((ref:QualityRow)=>ref.message_id).filter(Boolean))].sort(),
    dependency_manifest:structuredClone(entry.dependency_manifest)};
}
function ownerTiming(memory:QualityRow):QualityRow {
  const timing=memory.timing??{};
  return {...Object.fromEntries(['recorded_at','source_started_at','source_ended_at','source_time_complete','current_status'].map(key=>[key,timing[key]??null])),
    valid_at:memory.valid_at??null,invalid_at:memory.invalid_at??null,
    event:memory.event?Object.fromEntries(['stage','occurrence_start','occurrence_end','stage_verified','occurrence_verified','occurrence_precision','occurrence_expression']
      .filter(key=>key in memory.event).map(key=>[key,memory.event[key]])):null,
    conditions:memory.conditions?{version:1,items:memory.conditions.items.map((item:QualityRow)=>({text:item.text,source_supported:item.source_supported}))}:null,
    evolution:memory.evolution?Object.fromEntries(['kind','explanation','source_supported','claim_changed','condition_changed'].map(key=>[key,memory.evolution[key]??null])):null};
}
export function qualityModelMemories(scope:L2ScenarioScope,memories:readonly L2ScenarioMemory[]):QualityRow[] {
  return memories.map(memory=>scope.contact_id===null?{memory_id:memory.memory_id,revision:memory.revision,text:memory.text,timing:ownerTiming(memory)}:
    Object.fromEntries(Object.entries(memory).filter(([key])=>!['dependency_ids','message_ids','dependency_manifest','level'].includes(key))));
}
export function qualityModelScenarios(scope:L2ScenarioScope,scenarios:readonly L2ScenarioVersion[]):QualityRow[] {
  return scenarios.map(scenario=>({scenario_id:scenario.scenario_id,version_id:scenario.version_id,title:scenario.title,hint:scenario.hint,
    paragraphs:scenario.paragraphs.map(paragraph=>({text:paragraph.text,references:paragraph.references.map(ref=>scope.contact_id===null?
      {memory_id:ref.memory_id,revision:ref.revision,timing:ownerTiming(ref)}:structuredClone(ref))}))}));
}
export async function qualityCurrentScenarios(client:Client,scope:L2ScenarioScope,generation:number):Promise<L2ScenarioVersion[]> {
  const current=(await client.query(`SELECT scenario_version_ids FROM public.layered_memory_generation
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND organization_generation=$3`,
  [scope.owner_id,scope.contact_id,generation])).rows[0];
  if(!current)return [];
  const rows=(await client.query(`SELECT v.*,b.input_manifest,b.dependency_ids FROM public.scenario_document_version v
    JOIN public.layered_memory_batch b ON b.id=v.batch_id
    WHERE v.owner_id=$1 AND v.contact_id IS NOT DISTINCT FROM $2::uuid AND v.id=ANY($3::uuid[]) ORDER BY v.scenario_id`,
  [scope.owner_id,scope.contact_id,current.scenario_version_ids])).rows;
  if(rows.length!==current.scenario_version_ids.length)qualityConflict();
  return rows.map(row=>({scenario_id:row.scenario_id,version_id:row.id,title:row.title,hint:row.hint,
    paragraphs:row.paragraphs,input_manifest:row.input_manifest,dependency_ids:row.dependency_ids}));
}
export async function qualityScopeSnapshot(client:Client,scope:L2ScenarioScope,now:Date){
  const state=await managementState(client,scope);
  const input=await managementInputs(client,scope,now);
  const facts=(await client.query(`SELECT * FROM public.layered_memory_fact_correction
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid ORDER BY id`,[scope.owner_id,scope.contact_id])).rows;
  const feedback=(await client.query(`SELECT * FROM public.layered_memory_feedback
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid ORDER BY id`,[scope.owner_id,scope.contact_id])).rows;
  const corrections=feedback.filter(row=>row.state==='active'&&row.rejected_text?.trim()).map(row=>({feedback_id:row.id,
    rejected_text:row.rejected_text,reason:row.reason??'',rule:'independent-literal-v1'}));
  const guard={correction_revision:Number(state.correction_revision),organization_generation:Number(state.organization_generation),
    fact_pending:facts.map(row=>({id:row.id,memory_id:row.memory_id,memory_revision:Number(row.memory_revision),
      settings_generation:Number(row.settings_generation),request_digest:row.request_digest,source_dependency_mode:row.source_dependency_mode,
      dependency_ids:row.dependency_ids,protected_message_ids:row.protected_message_ids,observation_ids:row.observation_ids??[],source_ref_ids:row.source_ref_ids??[]})),
    feedback_targets:feedback.map(row=>({feedback_id:row.id,target_kind:row.target_kind,version_id:row.version_id,item_index:row.item_index,
      state:row.state,protected_memory_ids:row.protected_memory_ids,protected_message_ids:row.protected_message_ids}))};
  const guardDependencies=[...new Set([...facts.flatMap(row=>[row.id,row.memory_id,...row.dependency_ids,
    ...row.protected_message_ids,...(row.observation_ids??[]),...(row.source_ref_ids??[])]),
    ...feedback.flatMap(row=>[row.id,...row.dependency_ids,...row.protected_memory_ids,...row.protected_message_ids])])].sort();
  return {state,...input,guard,corrections,guardDependencies};
}
export async function qualityFactCorrections(client:Client,scope:L2ScenarioScope,manifest:QualityRow[],caseId:string,consume=false):Promise<QualityRow[]> {
  const versions=new Map(manifest.map(item=>[item.memory_id,item.revision]));
  const decisions=(await client.query(`SELECT id,record_id,replacement_memory_id,record_kind,evidence FROM public.memory_correction_decision
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND decision='corrected' AND replacement_memory_id=ANY($3::uuid[]) ORDER BY id`,
  [scope.owner_id,scope.contact_id,[...versions.keys()]])).rows;
  const intents=(await client.query(`SELECT * FROM public.organization_quality_fact_intent
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
    AND ((state='resolved' AND $3) OR (state='consumed' AND consumer_case_id=$4)) ORDER BY id FOR UPDATE`,
  [scope.owner_id,scope.contact_id,consume,caseId])).rows;
  return decisions.map(row=>{
    const intent=intents.find(item=>item.decision_id===row.id&&item.replacement_memory_id===row.replacement_memory_id);
    return {decision_id:row.id,record_id:row.record_id,replacement_memory_id:row.replacement_memory_id,
      replacement_revision:versions.get(row.replacement_memory_id),record_kind:row.record_kind,evidence_sha256:qualityDigest(row.evidence),
      fact_error_receipt:intent?{origin_case_id:intent.origin_case_id,origin_run_id:intent.origin_run_id,old_memory_id:intent.old_memory_id,
        replacement_memory_id:intent.replacement_memory_id,decision_id:intent.decision_id,intent_id:intent.id,state:'consumed',
        request_digest:intent.request_digest,settings_generation:Number(intent.settings_generation),old_revision:Number(intent.old_revision),
        replacement_revision:Number(intent.replacement_revision),dependency_ids:intent.dependency_ids,human_review:false,quality_verified:false}:null};
  });
}
export function qualityBoundedInput(payload:QualityRow,budget:OrganizationQualityBudget):void {
  // Python 默认 JSON 分隔符含空格；保守保留原字符预算口径。
  if([...qualitySpacedJSON(payload)].length>budget.max_characters||payload.memories.length>budget.max_memories)qualityInvalid();
}
export async function checkQualityCase(client:Client,row:QualityRow,now:Date):Promise<L2ScenarioMemory[]> {
  const scope={owner_id:row.owner_id,contact_id:row.contact_id};
  const snapshot=await qualityScopeSnapshot(client,scope,now);
  const selected=new Set(row.input_manifest.map((item:QualityRow)=>item.memory_id));
  const manifest=snapshot.manifest.filter(item=>selected.has(item.memory_id));
  const facts=await qualityFactCorrections(client,scope,row.input_manifest,row.id);
  if(Number(snapshot.state.settings_generation)!==Number(row.settings_generation)
    ||qualityJSON(snapshot.guard)!==qualityJSON(row.guard_snapshot)
    ||qualityJSON(snapshot.corrections)!==qualityJSON(row.model_input.corrections??[])
    ||qualityJSON(facts)!==qualityJSON(row.stage_evidence.fact_corrections??[])
    ||qualityJSON(manifest)!==qualityJSON(row.input_manifest))qualityConflict();
  return snapshot.entries.filter(entry=>selected.has(entry.memory.memory_id)).map(qualityMemory);
}
