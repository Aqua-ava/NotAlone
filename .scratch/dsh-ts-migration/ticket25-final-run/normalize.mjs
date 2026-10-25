/** 把 Ticket 25 的原始真实模型采集和独立盲评归一化为报告器输入；不执行模型或数据库。 */
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {auditReplyRuntimeSources} from '../../../backend-ts/src/reply-comparison-sources.ts';
import {createBlindPacket} from '../../../backend-ts/experiments/reply-blind-packet.mjs';

const DSH_COMMIT='687f282e8625c6b8d11ff58211a90524be2e4317';
const DIMENSIONS=['evidence_correctness','intent_preservation','no_unsupported_content','relationship_fit','chinese_usability'];
const SEVERE=['false_fact','wrong_person','unsupported_commitment'];
const ARMS=['old','new'];
const MAX_PRIMARY_STOP='__NOTALONE_FIXED_PRIMARY_STOP_V1__';
const EXPECTED_NEW_COMMIT='282f43afa238ff74a8eedeb19670e2a6d278d9dd';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>{
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(object(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 throw Error('normalization_non_json_value');
};
const digest=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const fail=reason=>{throw Error('ticket25_normalize_invalid:'+reason);};
const equal=(actual,expected,reason)=>{if(canonical(actual)!==canonical(expected))fail(reason);};

function options(args){
 const values={review:[]},seen=new Set();
 for(let index=0;index<args.length;index+=2){
  const flag=args[index],value=args[index+1];
  if(!flag?.startsWith('--')||value===undefined)fail('arguments');
  const key=flag.slice(2);
  if(!['capture','dataset','visible','binding','config','review','adjudication','output','summary-output'].includes(key))fail('argument_'+key);
  if(key==='review')values.review.push(value);
  else{if(seen.has(key))fail('duplicate_argument_'+key);seen.add(key);values[key]=value;}
 }
 for(const key of ['capture','dataset','visible','binding','config','output','summary-output'])if(!values[key])fail('missing_'+key);
 if(values.review.length!==2)fail('two_independent_reviews_required');
 const inputs=[values.capture,values.dataset,values.visible,values.binding,values.config,...values.review,...values.adjudication?[values.adjudication]:[]].filter(Boolean).map(value=>resolve(value));
 for(const output of [values.output,values['summary-output']].map(value=>resolve(value)))if(inputs.includes(output))fail('output_overwrites_input');
 return values;
}

function reviewBody(file){
 if(!object(file)||file.schema_version!=='reply-independent-review-v1'||!Array.isArray(file.items))fail('review_shape');
 if(typeof file.reviewer_id!=='string'||!file.reviewer_id.trim()||file.reviewer_type!=='agent'||file.independent!==true||file.blinded!==true)fail('review_identity');
 if(typeof file.reviewer_model!=='string'||!file.reviewer_model.trim()||typeof file.reviewer_version!=='string'||!file.reviewer_version.trim())fail('reviewer_version');
 return file;
}

function scoreShape(review,visibleById){
 for(const item of review.items){
  const source=visibleById.get(item.blind_id);
  if(!source||item.subject_sha256!==source.review_subject_sha256||!Array.isArray(item.candidates))fail('review_item_binding');
  if(item.candidates.length!==source.candidates.length)fail('review_candidate_count');
  const aliases=new Set(source.candidates.map(candidate=>candidate.candidate));
  if(item.candidates.some(candidate=>!aliases.has(candidate.candidate)))fail('review_candidate_alias');
  for(const candidate of item.candidates){
   if(!object(candidate.scores)||Object.keys(candidate.scores).sort().join(',')!==[...DIMENSIONS].sort().join(',')||DIMENSIONS.some(key=>![0,1,2].includes(candidate.scores[key])))fail('review_scores');
   if(!object(candidate.severe_errors)||Object.keys(candidate.severe_errors).sort().join(',')!==[...SEVERE].sort().join(',')||SEVERE.some(key=>!Number.isSafeInteger(candidate.severe_errors[key])||candidate.severe_errors[key]<0))fail('review_severe_errors');
   if(typeof candidate.basis!=='string'||!candidate.basis.trim())fail('review_basis');
  }
 }
}

function normalizedScores(review){
 return [...review.candidates].sort((left,right)=>left.candidate_id.localeCompare(right.candidate_id))
  .map(candidate=>({candidate_id:candidate.candidate_id,scores:candidate.scores,severe_errors:candidate.severe_errors}));
}

function reviewCaptureFor(capture){
 const groups=new Map();
 for(const row of capture.records){
  const key=`${row.case_id}:${row.repeat}`;
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(row);
 }
 const complete=new Set([...groups].filter(([,rows])=>rows.length===2&&rows.every(row=>row.actual.status==='succeeded')&&new Set(rows.map(row=>row.arm)).size===2).map(([key])=>key));
 return {...structuredClone(capture),received:complete.size*2,records:capture.records.filter(row=>complete.has(`${row.case_id}:${row.repeat}`))};
}

function quantile(values,p){
 const sorted=[...values].sort((left,right)=>left-right),position=(sorted.length-1)*p,lower=Math.floor(position);
 return sorted[lower]+(sorted[Math.ceil(position)]-sorted[lower])*(position-lower);
}

function boundReview(item,review,visibleItem,bindingItem){
 if(!visibleItem||!bindingItem||item.subject_sha256!==visibleItem.review_subject_sha256||review.independent!==true||review.blinded!==true||!['human','agent'].includes(review.reviewer_type))fail('submitted_review_binding');
 if(!Array.isArray(item.candidates)||item.candidates.length!==visibleItem.candidates.length||new Set(item.candidates.map(candidate=>candidate.candidate)).size!==visibleItem.candidates.length)fail('submitted_review_candidates');
 const candidates=item.candidates.map(candidate=>{
  const original=bindingItem.aliases.candidates.find(entry=>entry.alias===candidate.candidate);
  if(!original||'candidate_id'in candidate)fail('submitted_review_candidate_alias');
  const {candidate:alias,...submitted}=candidate;
  return {...structuredClone(submitted),candidate_id:original.original};
 });
 return {...structuredClone(review),...structuredClone(item),blind_id:bindingItem.original_blind_id,subject_sha256:bindingItem.reporter_subject_sha256,candidates};
}

function validateCapture(capture){
 if(capture.schema_version!=='reply-local-paired-collector-v1'||capture.protocol_version!=='migration-comparison-v1'||capture.evidence_kind!=='official_deepseek_full_comparison_v1'||capture.synthetic_only!==true||capture.planned!==96||capture.received!==96||!Array.isArray(capture.records)||capture.records.length!==96)fail('capture_contract');
 if(capture.source_bindings?.old_commit!=='3c168296e9e8edaa43b8b323ff693e790e709069'||capture.source_bindings?.new_commit!==EXPECTED_NEW_COMMIT||capture.source_bindings?.dsh_commit!==DSH_COMMIT)fail('capture_binding');
 const onlyVendorSupportInstrumented=capture.source_bindings?.candidate_source_manifest?.executed_tree_kind==='git_commit_tree'&&capture.source_bindings.candidate_source_manifest.base_commit===EXPECTED_NEW_COMMIT&&capture.source_bindings.candidate_source_manifest.vendor_support_raw_capture_only===true;
 if(capture.source_bindings?.workspace_changed_during_execution!==false||capture.source_bindings?.fixed_git_source_changed_during_execution!==false&&!onlyVendorSupportInstrumented)fail('source_drift');
 const keys=new Set();
 for(const row of capture.records){
  const key=`${row.case_id}:${row.arm}:${row.repeat}`;
  if(keys.has(key)||!ARMS.includes(row.arm))fail('record_identity');
  keys.add(key);
  if(row.logical_calls!==1||!Array.isArray(row.runtime_sources?.attempts)||row.runtime_sources.attempts.length!==row.physical_calls)fail('record_calls');
  if(!['succeeded','failed'].includes(row.actual?.status))fail('record_terminal');
  if(row.actual.status==='succeeded'&&(!object(row.output)||!object(row.source_storage_receipt)))fail('successful_output_missing');
  const body=row.runtime_sources.attempts[0]?.request?.body;
  if(!object(body)||body.model!=='deepseek-flash'||body.temperature!==0||(body.top_p??1)!==1||body.max_tokens!==4096||canonical(body.thinking)!=='{"type":"disabled"}')fail('model_controls');
  const stop=row.arm==='old'?body.stop:body.stop_sequences;
  if(row.arm==='old')equal(stop,[MAX_PRIMARY_STOP],'stop_controls');
  else if(stop!==undefined)fail('new_stop_control_changed');
  if(body.stream!==true)fail('stream_mode');
 }
 for(const arm of ARMS)if(capture.records.filter(row=>row.arm===arm).length!==48)fail('arm_denominator');
}

function configurationFor(capture){
 const old=createHash('sha256');
 const newMap=new Set();
 for(const row of capture.records){
  const body=row.runtime_sources.attempts[0].request.body;
  if(row.arm==='old')old.update(canonical(Object.keys(body).sort()));
  else newMap.add(canonical(Object.keys(body).sort()));
 }
 const config={
  provider:'deepseek',
  endpoint:'https://api.deepseek.com',
  request_model:'deepseek-flash',
  reasoning:'disabled',
  temperature:0,
  top_p:1,
  max_output_tokens:4096,
  timeout_ms:10000,
  max_retries:0,
  stop:[MAX_PRIMARY_STOP],
  seed:null,
  prompt_hash:null,
  tool_schema_hash:null,
  environment_hash:capture.environment==null?null:digest({environment:capture.environment,dependencies:capture.source_bindings.dependencies_before}),
  adapter_protocols:{old:['openai_chat_messages'],new:[...newMap]},
  provider_protocol_equivalence:'not_verified',
  prompt_equivalence:'not_verified',
  captured_arms_configuration_equal:capture.arms_configuration_equal,
 };
 return {config,configHash:digest(config)};
}

async function main(){
 const args=options(process.argv.slice(2));
 const [captureText,datasetText,visibleText,bindingText,runConfigurationText]=await Promise.all([
  readFile(args.capture,'utf8'),readFile(args.dataset,'utf8'),readFile(args.visible,'utf8'),readFile(args.binding,'utf8'),readFile(args.config,'utf8'),
 ]);
 const capture=JSON.parse(captureText),dataset=JSON.parse(datasetText),visible=JSON.parse(visibleText),binding=JSON.parse(bindingText);
 const visibleFileSha=createHash('sha256').update(visibleText).digest('hex');
 validateCapture(capture);
 const reviewCapture=reviewCaptureFor(capture);
 if(reviewCapture.records.length!==92||reviewCapture.received!==92)fail('review_capture_denominator');
 const expectedPacket=createBlindPacket({capture:reviewCapture,dataset,seed:binding.seed});
 equal(visible,expectedPacket.visible,'visible_packet_changed');
 equal(binding.items,expectedPacket.binding.items,'private_binding_changed');
 if(binding.visible_sha256!==digest(visible)||binding.dataset_canonical_sha256!==digest(dataset)||!/^[a-f0-9]{64}$/.test(binding.capture_canonical_sha256))fail('blind_packet_digest');
 if(visible.items.length!==92||binding.items.length!==92)fail('blind_packet_denominator');
 const visibleById=new Map(visible.items.map(item=>[item.blind_id,item]));
 const bindingById=new Map(binding.items.map(item=>[item.blind_id,item]));
 const reviewers=[],reviewerIds=new Set();
 for(const path of args.review){
  const review=reviewBody(JSON.parse(await readFile(path,'utf8')));
  if(review.packet_sha256!==visibleFileSha)fail('review_packet_digest');
  if(reviewerIds.has(review.reviewer_id))fail('reviewer_independence');
  reviewerIds.add(review.reviewer_id);
  scoreShape(review,visibleById);
  const bound=[];
  for(const item of review.items){
   const record=boundReview(item,review,visibleById.get(item.blind_id),bindingById.get(item.blind_id));
   bound.push(record);
  }
  reviewers.push({reviewer_id:review.reviewer_id,reviewer_model:review.reviewer_model,reviewer_version:review.reviewer_version,items:bound});
 }
 if(reviewers.length!==2)fail('reviewer_count');
 // 两份评审覆盖同一批46个完整成功配对；失败配对留在全量报告分母，但不伪造盲评。
 const reviewIds=binding.items.map(item=>item.original_blind_id).sort();
 const firstIds=new Set(reviewers[0].items.map(item=>item.blind_id));
 const secondIds=new Set(reviewers[1].items.map(item=>item.blind_id));
 equal([...firstIds].sort(),reviewIds,'reviewer_1_coverage');
 equal([...secondIds].sort(),reviewIds,'reviewer_2_coverage');
 const byOriginal=new Map(capture.records.map(row=>[row.blind_id,row]));
 const reviewByBlind=new Map();
 for(const item of reviewers[0].items)reviewByBlind.set(item.blind_id,{first:item,second:null});
 for(const item of reviewers[1].items){const pair=reviewByBlind.get(item.blind_id);if(!pair)fail('reviewer_2_unknown_item');pair.second=item;}
 const disagreements=[];
 for(const [blindId,pair]of reviewByBlind){if(canonical(normalizedScores(pair.first))!==canonical(normalizedScores(pair.second)))disagreements.push(blindId);}
 disagreements.sort();
 const adjudicated=new Set();
 if(args.adjudication){
  const adjudication=reviewBody(JSON.parse(await readFile(args.adjudication,'utf8')));
  if(adjudication.reviewer_id===reviewers[0].reviewer_id||adjudication.reviewer_id===reviewers[1].reviewer_id||reviewerIds.has(adjudication.reviewer_id))fail('adjudicator_independence');
  scoreShape(adjudication,visibleById);
  for(const item of adjudication.items){
   const originalBlindId=bindingById.get(item.blind_id)?.original_blind_id;
   const pair=reviewByBlind.get(originalBlindId);
   if(!pair||!disagreements.includes(originalBlindId)||adjudicated.has(originalBlindId))fail('adjudication_scope');
   const bound=boundReview(item,adjudication,visibleById.get(item.blind_id),bindingById.get(item.blind_id));
   const row=byOriginal.get(originalBlindId);
   row.adjudication={...bound,resolves_review_ids:[pair.first.review_id,pair.second.review_id]};
   adjudicated.add(originalBlindId);
  }
  equal([...adjudicated].sort(),disagreements,'adjudication_coverage');
 }
 const {config,configHash}=configurationFor(capture);
 const priceSource=JSON.parse(runConfigurationText).price_snapshot;
 const priceSnapshot={...structuredClone(priceSource),sha256:priceSource.source_page_sha256};
 if(capture.records.some(row=>row.cost?.price_snapshot_sha256!==priceSnapshot.sha256||row.cost?.currency!==priceSnapshot.currency))fail('price_binding');
 const sourceAuditSummary={verified:0,undetermined:0,by_arm:{old:{verified:0,undetermined:0},new:{verified:0,undetermined:0}},reasons:{}};
 const records=[];
 for(const row of capture.records){
  const success=row.actual.status==='succeeded';
  if(success){
   const member=dataset.cases.find(item=>item.case_id===row.case_id);
   const audit=auditReplyRuntimeSources(member,{...row,terminal_status:'succeeded'},row.output,'model_run');
   if(audit.status!=='verified')fail('source_audit_'+row.case_id+'_'+row.arm+'_'+row.repeat+':'+audit.reason);
   sourceAuditSummary.verified++;
   sourceAuditSummary.by_arm[row.arm].verified++;
  }else{
   sourceAuditSummary.undetermined++;
   sourceAuditSummary.by_arm[row.arm].undetermined++;
   sourceAuditSummary.reasons[row.actual.error??'failed']=(sourceAuditSummary.reasons[row.actual.error??'failed']??0)+1;
  }
  const pair=reviewByBlind.get(row.blind_id);
  const reviews=pair?[pair.first,pair.second]:[];
  records.push({
   case_id:row.case_id,arm:row.arm,repeat:row.repeat,order:row.order,blind_id:row.blind_id,
   scope:structuredClone(row.scope),synthetic_scope_id:row.synthetic_scope_id,
   case_sha256:row.case_sha256,input_sha256:row.input_sha256,config_hash:configHash,
   commit:row.arm==='old'?capture.source_bindings.old_commit:capture.source_bindings.new_commit,
   generated_by:'official-deepseek-paired-collector',terminal_status:row.actual.status,
   logical_calls:1,physical_calls:row.physical_calls,actual_model:row.actual_model,model_fingerprint:row.model_fingerprint,
   request_sha256:row.request_sha256,started_at:row.started_at,ended_at:row.ended_at,observed_ms:row.observed_ms,
   first_event_ms:row.first_event_ms,first_token_ms:row.first_token_ms,final_persisted_result_ms:row.final_persisted_result_ms,
   timing:structuredClone(row.timing),latency_ms:row.latency_ms,
   usage:structuredClone(row.usage),cost:structuredClone(row.cost),output:structuredClone(row.output),
   runtime_sources:structuredClone(row.runtime_sources),deterministic_checks:structuredClone(row.deterministic_checks),
   actual:structuredClone(row.actual),partial_observations:structuredClone(row.partial_observations),
   physical_attempts:structuredClone(row.physical_attempts),reviews:structuredClone(reviews),
   ...row.adjudication?{adjudication:structuredClone(row.adjudication)}:{},
  });
 }
 const run={
  schema_version:'reply-migration-run-v1',protocol_version:'migration-comparison-v1',evidence_kind:'model_run',synthetic_only:true,
  manifest_sha256:capture.source_bindings.manifest_sha256,dataset_sha256:digest(datasetText),
  configuration:config,config_hash:configHash,
  bindings:{
   old:{commit:capture.source_bindings.old_commit,lock_hash:capture.source_bindings.lock_sha256,profile_hash:null},
   new:{commit:capture.source_bindings.new_commit,lock_hash:capture.source_bindings.lock_sha256,profile_hash:capture.source_bindings.profile_sha256,dsh_commit:capture.source_bindings.dsh_commit},
  },
  price_snapshot:priceSnapshot,records,
 };
 const summary={
  schema_version:'ticket25-normalized-run-summary-v1',
  capture_sha256:digest(capture),dataset_sha256:digest(datasetText),visible_sha256:digest(visible),
  reviewers:reviewers.map(reviewer=>({reviewer_id:reviewer.reviewer_id,reviewer_model:reviewer.reviewer_model,reviewer_version:reviewer.reviewer_version,items:reviewer.items.length})),
  records:records.length,successes:records.filter(row=>row.terminal_status==='succeeded').length,
  failures:records.filter(row=>row.terminal_status==='failed').map(row=>`${row.case_id}:${row.arm}:${row.repeat}`),
  reviews:{items:reviewByBlind.size,disagreements:disagreements.length,disagreement_keys:disagreements.map(id=>{
   const row=byOriginal.get(id);return `${row.case_id}:${row.arm}:${row.repeat}`;
  }),adjudicated:adjudicated.size},
  configuration:{provider:config.provider,endpoint:config.endpoint,request_model:config.request_model,temperature:config.temperature,top_p:config.top_p,max_output_tokens:config.max_output_tokens,reasoning:config.reasoning,timeout_ms:config.timeout_ms,max_retries:config.max_retries,config_hash:configHash,provider_protocol_equivalence:config.provider_protocol_equivalence,prompt_equivalence:config.prompt_equivalence},
  price_snapshot:{currency:priceSnapshot.currency,sha256:priceSnapshot.sha256,billed_model:priceSnapshot.billed_model,cache_hit_usd_per_million:priceSnapshot.cache_hit_usd_per_million,cache_miss_usd_per_million:priceSnapshot.cache_miss_usd_per_million,output_usd_per_million:priceSnapshot.output_usd_per_million},
  source_audit:sourceAuditSummary,
  timing:{
   successful_observations:records.filter(row=>row.terminal_status==='succeeded'&&row.latency_ms!==null).length,
   arms:Object.fromEntries(ARMS.map(arm=>{
    const values=records.filter(row=>row.arm===arm&&row.terminal_status==='succeeded'&&row.latency_ms!==null).map(row=>row.latency_ms);
    return [arm,{observations:values.length,p50_ms:quantile(values,.5),p95_ms:quantile(values,.95)}];
   })),
  },
  real_model_quality_verified:false,production_switch_approved:false,
 };
 await writeFile(args.output,JSON.stringify(run,null,2)+'\n',{flag:'wx',mode:0o600});
 await writeFile(args['summary-output'],JSON.stringify(summary,null,2)+'\n',{flag:'wx',mode:0o600});
 process.stdout.write(JSON.stringify({records:summary.records,successes:summary.successes,failures:summary.failures,reviews:summary.reviews,config_hash:configHash,real_model_quality_verified:false,production_switch_approved:false})+'\n');
}

main().catch(error=>{process.stderr.write(String(process.env.NOTALONE_TICKET25_DEBUG?error?.stack??error:error?.message??error)+'\n');process.exitCode=1;});
