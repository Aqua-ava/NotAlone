/** 原正式质量门槛与完整分母；执行成功不等于语义资格。 */
import {FACT_PREPARATION_DATASET_VERSION,qualityDigest,qualityJSON,qualitySpacedJSON,REQUIRED_PHASES,SEMANTIC_DIMENSIONS,type QualityRow} from './organization-quality-contract.ts';
import {qualityHumanApproved,qualityOutputItems,qualityOutputReview} from './organization-quality-review.ts';

function l3NotApplicable(row:QualityRow):boolean {
  const checkpoint=row.stage_evidence?.l3_checkpoint,output=row.output_payload;
  return checkpoint?.kind==='evaluation_checkpoint'&&checkpoint.normal_call_required===false&&checkpoint.documents?.length===0
    &&output?.l3_not_required===true&&qualityJSON(output.l2)==='{"scenarios":[]}'&&qualityJSON(output.l3)==='{"entries":[]}';
}
function completeReview(row:QualityRow):boolean {
  if(!qualityHumanApproved(row.output_review)||!['complete','failed'].includes(row.execution_state))return false;
  try{qualityOutputReview(row.output_review,row);}catch{return false;}
  return row.output_review.verifier_challenges_reviewed===true;
}
function maximum(attempts:QualityRow[],key:string):number|null {
  const values=attempts.map(row=>row.measurements?.[key]);
  return values.length&&values.every(value=>Number.isSafeInteger(value))?Math.max(...values):null;
}
export function buildOrganizationQualityReport(run:QualityRow,cases:QualityRow[],attempts:QualityRow[],currentContractId:string,now=new Date()):QualityRow {
  const reasons:string[]=[],failures:QualityRow[]=[],dimensions:QualityRow={};
  const add=(reason:string)=>{if(!reasons.includes(reason))reasons.push(reason);};
  if(run.contract_id!==currentContractId)add('contract_changed');
  if(run.state!=='complete'||cases.length!==run.case_count||cases.some(row=>row.execution_state!=='complete'))add('evaluation_incomplete');
  if(!run.input_review_frozen||!cases.length||cases.some(row=>!qualityHumanApproved(row.annotations)))add('human_annotations_missing');
  const approved=cases.filter(row=>qualityHumanApproved(row.annotations));
  for(const row of approved)dimensions[row.annotations.dimension]=(dimensions[row.annotations.dimension]??0)+1;
  if(SEMANTIC_DIMENSIONS.some(name=>(dimensions[name]??0)<15)||new Set(approved.map(row=>row.annotations.scenario_key)).size!==cases.length)add('coverage_insufficient');
  if(!cases.length||cases.some(row=>!completeReview(row)))add('human_output_review_missing');
  if(run.transport_kind!=='sdk'||!attempts.length||attempts.some(row=>row.outcome!=='succeeded'||!row.response_model||!row.request_route||row.request_route==='unknown')
    ||cases.some(row=>{
      const actual=new Set(attempts.filter(attempt=>attempt.case_id===row.id).map(attempt=>attempt.phase));
      const required=REQUIRED_PHASES.filter(phase=>!(l3NotApplicable(row)&&['reject','uncertain_summary_allowed'].includes(row.annotations?.empty_support_policy)
        &&['l3_proposal','l3_verification'].includes(phase)));
      return actual.size!==required.length||required.some(phase=>!actual.has(phase));
    }))add('actual_model_evidence_missing');
  if(run.transport_kind==='sdk'){
    const observed=new Map<string,string>();
    for(const row of attempts){
      const request=row.request_model,expected=run.contract[row.phase.endsWith('proposal')?'request_model':'verifier_model'];
      if(request!==expected)add('candidate_model_changed');
      if(!request||!row.response_model||!row.request_route||row.request_route==='unknown')add('actual_model_identity_unknown');
      const identity=qualityJSON([row.response_model,row.system_fingerprint,row.request_route]);
      if(observed.has(request)&&observed.get(request)!==identity)add('candidate_model_changed');
      observed.set(request,identity);
    }
  }
  if(!qualityHumanApproved(run.calibration))add('budget_calibration_missing');
  for(const row of cases){
    const review=row.output_review;
    if(review&&review.projection_passed!==true)add('scope_projection_failed');
    if(review?.decision==='rejected'||(review?.claims??[]).some((claim:QualityRow)=>claim.critical_errors?.length||claim.supported!==true))add('critical_semantic_errors');
    if(row.error_code)failures.push({case_id:row.id,error_code:row.error_code});
  }
  if(run.http_attempts_used>=run.max_http_attempts&&run.state!=='complete')add('physical_attempt_budget_exhausted');
  if(failures.length)add('evaluation_failed');
  const failed=failures.length||reasons.some(reason=>['critical_semantic_errors','scope_projection_failed'].includes(reason));
  const status=failed?'failed':reasons.length?'unknown':'verified';
  const phaseCounts:QualityRow={};
  for(const phase of [...REQUIRED_PHASES].sort()){
    const rows=attempts.filter(row=>row.phase===phase),key=phase==='l2_proposal'?'l2':phase==='l3_proposal'?'l3':phase;
    const isL3=['l3_proposal','l3_verification'].includes(phase);
    const notApplicable=isL3?cases.filter(l3NotApplicable).length:0;
    const executed=cases.filter(row=>(rows.some(attempt=>attempt.case_id===row.id)||row.output_payload?.[key]!=null)&&!(isL3&&l3NotApplicable(row))).length;
    phaseCounts[phase]={case_denominator:run.case_count,executed_cases:executed,not_run_cases:run.case_count-executed-notApplicable,
      not_applicable_cases:notApplicable,http_attempts:rows.length,failed_http_attempts:rows.filter(row=>row.outcome!=='succeeded').length};
  }
  const items=cases.flatMap(row=>qualityOutputItems(row.output_payload));
  const usages=attempts.map(row=>row.response_payload?.usage);
  const usage=Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens'].map(key=>[key,
    usages.length&&usages.every(value=>Number.isSafeInteger(value?.[key]))?usages.reduce((sum,value)=>sum+value[key],0):null]));
  const preparation=run.dataset_version===FACT_PREPARATION_DATASET_VERSION&&cases.length===1?{
    purpose:'fact_correction_path',state:new Date(run.created_at).getTime()+1_800_000>now.getTime()?'armed':'expired',
    origin_run_id:run.id,origin_case_id:cases[0].id,old_memory_id:cases[0].input_manifest[0].memory_id,
    old_revision:cases[0].input_manifest[0].revision,settings_generation:Number(cases[0].settings_generation),human_review:false,quality_verified:false,
    registration_expires_at:new Date(new Date(run.created_at).getTime()+1_800_000).toISOString()}:null;
  return {schema_version:2,report_id:run.id,stage:run.stage,contract_id:run.contract_id,contract:run.contract,
    dataset_version:run.dataset_version,dataset_sha256:run.dataset_sha256,data_kind:run.data_kind,state:run.state,
    case_count:run.case_count,reviewed_case_count:cases.filter(completeReview).length,dimensions,failure_count:failures.length,failures,
    phase_counts:phaseCounts,token_usage:usage,http_attempts_used:run.http_attempts_used,max_http_attempts:run.max_http_attempts,
    transport_kind:run.transport_kind,input_review_frozen:run.input_review_frozen,input_review_sha256:run.input_review_sha256,
    organization:{status,reasons,contract_id:currentContractId,report_id:run.id},automatic_use_allowed:false,preparation,
    calibration:{review:run.calibration,observed_max_output_item_characters:Math.max(0,...items.map(item=>[...item.text].length)),
      observed_max_request_characters:maximum(attempts,'request_entity_characters'),observed_max_response_entity_characters:maximum(attempts,'response_entity_characters'),
      observed_max_generated_content_characters:maximum(attempts,'generated_content_characters'),
      estimated_max_request_json_characters:attempts.length?Math.max(...attempts.map(row=>[...JSON.stringify(row.request_payload)].length)):null,
      observed_max_input_characters:Math.max(0,...cases.map(row=>[...qualitySpacedJSON(row.model_input)].length)),
      observed_max_memories:Math.max(0,...cases.map(row=>row.model_input.memories.length))},
    cases:cases.map(row=>({case_id:row.id,input_sha256:row.input_sha256,model_input:row.model_input,stage_evidence:row.stage_evidence,
      construction:row.construction,guard_snapshot:row.guard_snapshot,annotations:row.annotations,output:row.output_payload,
      output_sha256:row.output_payload!==null?qualityDigest(row.output_payload):null,review_items:qualityOutputItems(row.output_payload),
      output_review:row.output_review,execution_state:row.execution_state,error_code:row.error_code})),
    attempts:attempts.map(row=>({...Object.fromEntries(['ordinal','phase','outcome','request_model','response_model','system_fingerprint',
      'request_payload','response_payload','duration_ms','request_route','measurements'].map(key=>[key,row[key]])),case_id:row.case_id,underlying_model_version:'unknown'}))};
}
