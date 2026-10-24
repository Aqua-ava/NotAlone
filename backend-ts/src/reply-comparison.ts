/** 仅审计显式提供的合成离线证据，不执行模型、读取环境或连接数据库。 */
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {comparisonPairOrders,comparisonTotal,pairedCaseInterval,REPLY_COMPARISON_BOOTSTRAP,type ComparisonStatistic} from './reply-comparison-statistics.ts';
import {auditReplyRuntimeSources,type ReplyRuntimeSourceAudit} from './reply-comparison-sources.ts';
type Row=Record<string,any>;
type Status='passed'|'failed'|'undetermined';
const MANIFEST_SHA='84b81a3255bffe8bc69da6f38c0dd79e1ba83510454ef8a9091c947b995b362b';
const DSH_COMMIT='687f282e8625c6b8d11ff58211a90524be2e4317';
const INPUT_FIELDS=['current_intent','available_facts','unknowns','allowed_changes','current_message','recent_context'];
const DIMENSIONS=['evidence_correctness','intent_preservation','no_unsupported_content','relationship_fit','chinese_usability'];
const SEVERE=['false_fact','wrong_person','unsupported_commitment'];
const ARMS=['old','new'] as const;
const object=(v:unknown):v is Row=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const known=(v:unknown)=>text(v)&&!['unknown','unavailable'].includes(v.trim().toLowerCase());
const hashString=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const nonnegative=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
/** 计数不能借浮点舍入丢掉新增；相加前检查剩余安全整数范围。 */
function integerTotal(values:readonly number[]):number {let total=0;for(const value of values){if(!integer(value)||value>Number.MAX_SAFE_INTEGER-total)invalid('integer_aggregate_overflow');total+=value;}return total;}
function invalid(code:string):never{throw new Error('reply_comparison_invalid:'+code);}
function canonical(value:any):string {
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(object(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 return invalid('non_json_value');
}
const digest=(value:any)=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const inputFor=(member:Row)=>Object.fromEntries(INPUT_FIELDS.filter(k=>k in member).map(k=>[k,member[k]]));
function frozen(manifestText:string,datasetText:string){
 if(digest(manifestText)!==MANIFEST_SHA)invalid('frozen_manifest_sha256');
 const manifest=JSON.parse(manifestText),dataset=JSON.parse(datasetText);
 const suite=manifest.suites.find((s:Row)=>s.suite==='reply_fidelity');
 const material=manifest.materials.find((m:Row)=>m.path==='backend/tests/fixtures/fidelity/synthetic-v1.json');
 if(!material||digest(datasetText)!==material.sha256)invalid('frozen_dataset_sha256');
 if(suite.count!==16||!Array.isArray(dataset.cases)||dataset.cases.length!==16||new Set(dataset.cases.map((c:Row)=>c.case_id)).size!==16)invalid('frozen_cases');
 for(const c of dataset.cases)if(suite.cases.find((s:Row)=>s.case_id===c.case_id)?.canonical_case_sha256!==digest(c))invalid('frozen_case_sha256');
 return {manifest,cases:dataset.cases as Row[]};
}
/** 后续真实runner可复用这份固定AB/BA计划；它只返回标识，不执行请求。 */
export function createReplyComparisonPlan(manifestText:string,datasetText:string){
 const {cases}=frozen(manifestText,datasetText),orders=comparisonPairOrders();
 return cases.flatMap((c,index)=>[1,2,3].map((repeat,i)=>({case_id:c.case_id,repeat,order:orders[index*3+i]})));
}
interface Audited {record:Row|null;id:string;case_id:string;arm:'old'|'new';repeat:number;status:string;pass:number;usability:number|null;severe:Row|null;reviews:Row[];output_sha256:string|null;source_audit?:ReplyRuntimeSourceAudit}
interface Issue {record_id:string|null;reason:string;blocking?:boolean}
const reviewProjection=(r:Row)=>({review_id:r.review_id,reviewer_id:r.reviewer_id,reviewer_type:r.reviewer_type,reviewer_model:r.reviewer_model??null,reviewer_version:r.reviewer_version??null,subject_sha256:r.subject_sha256,candidates:structuredClone(r.candidates)});
function scoreReview(review:unknown,row:Row,output:Row,subject:string):Row {
 if(!object(review)||!text(review.review_id)||review.blind_id!==row.blind_id||review.subject_sha256!==subject||!text(review.reviewer_id)||review.reviewer_id===row.generated_by||!['human','agent'].includes(review.reviewer_type)||review.independent!==true||review.blinded!==true)invalid('independent_blind_review_binding');
 if(!Array.isArray(review.candidates)||review.candidates.length!==output.candidates.length||new Set(review.candidates.map((c:Row)=>c.candidate_id)).size!==output.candidates.length)invalid('review_all_candidates');
 for(const candidate of output.candidates){
  const item=review.candidates.find((c:Row)=>c.candidate_id===candidate.candidate_id);
  if(!item||!text(item.basis)||!object(item.scores)||Object.keys(item.scores).sort().join(',')!==[...DIMENSIONS].sort().join(',')||DIMENSIONS.some(k=>item.scores[k]!==null&&![0,1,2].includes(item.scores[k])))invalid('review_scores');
  if(!object(item.severe_errors)||Object.keys(item.severe_errors).sort().join(',')!==[...SEVERE].sort().join(',')||SEVERE.some(k=>item.severe_errors[k]!==null&&!integer(item.severe_errors[k])))invalid('review_severe_errors');
 }
 return review;
}
function combineStatus(states:Status[]):Status{return states.includes('failed')?'failed':states.includes('undetermined')?'undetermined':'passed';}
function lowerGate(interval:{estimate:number;ci95:number[]},limit:number):Status{return interval.ci95[0]>=limit-1e-12?'passed':interval.ci95[1]<limit-1e-12?'failed':'undetermined';}
function upperGate(interval:{estimate:number;ci95:number[]},limit:number):Status{return interval.ci95[1]<=limit+1e-12?'passed':interval.ci95[0]>limit+1e-12?'failed':'undetermined';}
/** 所有阶段使用同一单调时钟的相对毫秒；墙钟只按ISO毫秒精度核对总时长。 */
function auditLatency(row:Row,id:string,unknown:(id:string,reason:string)=>void):number|null {
 if(row.latency_ms!==null&&!nonnegative(row.latency_ms))invalid('latency');
 const timing=row.timing;
 if(timing===null||timing===undefined){unknown(id,'latency_evidence_unknown');return null;}
 if(!object(timing)||timing.schema_version!=='reply-latency-v1'||timing.clock!=='monotonic'||!object(timing.phases))invalid('latency_evidence_structure');
 const phases=['queue','retrieval','network_model','validation','persistence'];
 if(Object.keys(timing.phases).sort().join(',')!==[...phases].sort().join(','))invalid('latency_phases');
 if(!nonnegative(timing.observed_ms))invalid('latency_observed');
 const segments=phases.flatMap(name=>{const entries=Array.isArray(timing.phases[name])?timing.phases[name]:[timing.phases[name]];return entries.map((phase:unknown)=>{if(!object(phase)||!nonnegative(phase.started_ms)||!nonnegative(phase.ended_ms)||phase.ended_ms<phase.started_ms||phase.ended_ms>timing.observed_ms)invalid('latency_phase_order');return {name,started_ms:phase.started_ms,ended_ms:phase.ended_ms};});});
 const active=segments.filter(segment=>segment.ended_ms>segment.started_ms).sort((a,b)=>a.started_ms-b.started_ms);
 let prior=0;
 for(const segment of active){if(segment.started_ms!==prior)invalid('latency_phase_order');prior=segment.ended_ms;}
 if(prior!==timing.observed_ms)invalid('latency_phase_total');
 const model=segments.filter(segment=>segment.name==='network_model');
 let resultTimeKnown=true;
 // 首事件与首token是独立诊断项；未知仍阻断整体资格，但不抹去已证最终时长。
 for(const name of ['first_event_ms','first_token_ms']){
  if(timing[name]===null){if(row.terminal_status==='succeeded'){unknown(id,'latency_'+name+'_unknown');}}
  else if(!nonnegative(timing[name])||!model.some(segment=>timing[name]>=segment.started_ms&&timing[name]<=segment.ended_ms))invalid('latency_'+name);
 }
 if(timing.first_event_ms!==null&&timing.first_token_ms!==null&&timing.first_token_ms<timing.first_event_ms)invalid('latency_event_token_order');
 if(row.terminal_status==='succeeded'){
  if(timing.final_persisted_result_ms===null){unknown(id,'latency_final_persisted_result_unknown');resultTimeKnown=false;}
  else if(!nonnegative(timing.final_persisted_result_ms)||timing.final_persisted_result_ms!==timing.observed_ms||!segments.some(segment=>segment.name==='persistence'&&segment.ended_ms===timing.observed_ms)||timing.observed_ms>0&&active.at(-1)?.name!=='persistence')invalid('latency_final_persisted_result');
 }else if(timing.final_persisted_result_ms!==null)invalid('latency_failed_result_persisted');
 if(!known(row.started_at)||!known(row.ended_at)||!Number.isFinite(Date.parse(row.started_at))||!Number.isFinite(Date.parse(row.ended_at))){unknown(id,'run_times_unknown');return null;}
 const elapsed=Date.parse(row.ended_at)-Date.parse(row.started_at);
 if(elapsed<0||Math.abs(elapsed-timing.observed_ms)>1)invalid('latency_wall_clock_duration');
 if(row.latency_ms===null)return null;
 if(row.latency_ms!==timing.observed_ms)invalid('latency_duration_binding');
 return resultTimeKnown?row.latency_ms:null;
}
/**
 * 唯一报告接缝：原始输入不改写，输出不复制正文。前3维所有候选均须为2才满足事实/意图；
 * 关系与中文分别无0且组均分>=1.5。未知值保持null，分母始终每臂48。
 */
export function buildReplyComparisonReport(manifestText:string,datasetText:string,value:unknown){
 const {manifest,cases}=frozen(manifestText,datasetText);
 if(!object(value))return invalid('run');const run=value;
 if(run.schema_version!=='reply-migration-run-v1'||run.protocol_version!=='migration-comparison-v1'||run.synthetic_only!==true||!['model_run','reporter_fixture'].includes(run.evidence_kind)||run.manifest_sha256!==MANIFEST_SHA||run.dataset_sha256!==digest(datasetText)||!Array.isArray(run.records))invalid('run_binding');
 const unknowns:Issue[]=[],failures:Issue[]=[];
 const unknown=(id:string|null,reason:string,blocking=true)=>unknowns.push({record_id:id,reason,blocking});
 const checkHash=(value:unknown,id:string|null,reason:string)=>{if(value===null){unknown(id,reason);return;}if(!hashString(value))invalid(reason);};
 if(!object(run.configuration))invalid('configuration');
 const config=run.configuration;
 for(const k of ['provider','endpoint','request_model','reasoning'])if(!known(config[k]))invalid('configuration_'+k);
 if(!nonnegative(config.temperature)||config.temperature>2||!nonnegative(config.top_p)||config.top_p>1||!integer(config.max_output_tokens)||config.max_output_tokens<1||!integer(config.timeout_ms)||config.timeout_ms<1||!integer(config.max_retries)||!Array.isArray(config.stop)||config.stop.some((s:unknown)=>typeof s!=='string')||config.seed!==null&&!Number.isSafeInteger(config.seed))invalid('configuration_controls');
 for(const k of ['prompt_hash','tool_schema_hash','environment_hash'])checkHash(config[k],null,k+'_unknown');
 checkHash(run.config_hash,null,'config_hash_unknown');if(run.config_hash!==null&&run.config_hash!==digest(config))invalid('config_hash');
 if(!object(run.bindings))invalid('arm_bindings');
 for(const arm of ARMS){const binding=run.bindings[arm];if(!object(binding)||typeof binding.commit!=='string'||!/^[a-f0-9]{40}$/.test(binding.commit))invalid('commit_binding');for(const key of ['lock_hash','profile_hash'])checkHash(binding[key],null,arm+'_'+key+'_unknown');}
 if(run.bindings.old.commit!==manifest.baseline_commit||run.bindings.new.dsh_commit!==DSH_COMMIT)invalid('baseline_or_dsh_commit');
 if(run.price_snapshot!==null&&(!object(run.price_snapshot)||!known(run.price_snapshot.currency)||!hashString(run.price_snapshot.sha256)))invalid('price_snapshot');
 if(run.price_snapshot===null)unknown(null,'price_snapshot_unknown');
 const byId=new Map<string,Row>(),blindIds=new Set<string>(),orders=new Map(createReplyComparisonPlan(manifestText,datasetText).map(p=>[p.case_id+':'+p.repeat,p.order]));
 const members=new Map(cases.map(c=>[c.case_id,c]));
 for(const row of run.records){
  if(!object(row)||!members.has(row.case_id)||!ARMS.includes(row.arm)||![1,2,3].includes(row.repeat))invalid('case_arm_repeat');
  const id=`${row.case_id}:${row.arm}:${row.repeat}`,member=members.get(row.case_id)!;
  if(byId.has(id))invalid('duplicate_case_arm_repeat');
  if(!known(row.blind_id)||blindIds.has(row.blind_id)||/\b(old|new|baseline|candidate)\b/i.test(row.blind_id))invalid('blind_id');blindIds.add(row.blind_id);
  if(row.case_sha256!==digest(member)||row.input_sha256!==digest(inputFor(member))||row.commit!==run.bindings[row.arm].commit)invalid('material_or_commit_binding');
  checkHash(row.config_hash,id,'record_config_hash_unknown');if(row.config_hash!==null&&row.config_hash!==run.config_hash)invalid('record_config_hash');
  if(row.order!==orders.get(row.case_id+':'+row.repeat))invalid('paired_order');
  if(!['succeeded','failed','cancelled','timeout','unknown'].includes(row.terminal_status)||row.logical_calls!==1)invalid('terminal_status_or_logical_calls');
  if(!known(row.generated_by))unknown(id,'generator_identity_unknown');
  if(!known(row.actual_model))unknown(id,'actual_model_unknown',false);if(!known(row.model_fingerprint))unknown(id,'model_fingerprint_unknown',false);
  checkHash(row.request_sha256,id,'request_sha256_unknown');
  if(!object(row.deterministic_checks)||!['passed','failed','unknown'].includes(row.deterministic_checks.status))invalid('deterministic_checks');
  if(row.deterministic_checks.source_binding_sha256===null)unknown(id,'deterministic_source_binding_unknown');else if(row.deterministic_checks.source_binding_sha256!==row.input_sha256)invalid('deterministic_source_binding');
  if(row.deterministic_checks.status==='unknown')unknown(id,'deterministic_checks_unknown');if(row.deterministic_checks.status==='failed')failures.push({record_id:id,reason:'deterministic_checks_failed'});
  byId.set(id,row);
 }
 const audited:Audited[]=[],runtimeRequestIds=new Set<string>(),runtimeAttemptIds=new Set<string>();
 for(const member of cases)for(const arm of ARMS)for(const repeat of [1,2,3]){
  const id=`${member.case_id}:${arm}:${repeat}`,row=byId.get(id),base={id,case_id:member.case_id,arm,repeat,pass:0,usability:null,severe:null,reviews:[],output_sha256:null};
  if(!row){unknown(id,'record_missing');audited.push({...base,record:null,status:'missing'});continue;}
  const item:Audited={...base,record:row,status:row.terminal_status};audited.push(item);
  if(row.terminal_status!=='succeeded'){
   if(row.terminal_status==='unknown')unknown(id,'terminal_status_unknown');
   else {failures.push({record_id:id,reason:'terminal_'+row.terminal_status,blocking:false});item.usability=0;item.severe=Object.fromEntries(SEVERE.map(k=>[k,0]));}
   continue;
  }
  const output=row.output;
  if(!object(output)||!Array.isArray(output.candidates)||output.candidates.length<1||output.candidates.length>3||new Set(output.candidates.map((c:Row)=>c.candidate_id)).size!==output.candidates.length||output.candidates.some((c:Row)=>!object(c)||!text(c.candidate_id)||!text(c.text)||!text(c.basis)||!Array.isArray(c.citation_ids)||c.citation_ids.some((v:unknown)=>!text(v))))invalid('candidate_structure');
  const runtime=run.evidence_kind==='model_run'||row.runtime_sources!==undefined;
  if(runtime){
   item.source_audit=auditReplyRuntimeSources(member,row,output,run.evidence_kind);
   if(item.source_audit.status==='verified'){
    if(runtimeRequestIds.has(item.source_audit.request_id!))invalid('runtime_request_reused');
    runtimeRequestIds.add(item.source_audit.request_id!);
    for(const attemptId of item.source_audit.attempt_ids){if(runtimeAttemptIds.has(attemptId))invalid('runtime_attempt_reused');runtimeAttemptIds.add(attemptId);}
    if(row.deterministic_checks.runtime_sources_sha256==null)unknown(id,'runtime_deterministic_binding_unknown');
    else if(row.deterministic_checks.runtime_sources_sha256!==item.source_audit.binding_sha256)invalid('runtime_deterministic_binding');
   }
   if(item.source_audit.status==='undetermined')unknown(id,item.source_audit.reason!);
   else if(output.candidates.some((c:Row)=>c.citation_ids.some((citation:string)=>!item.source_audit!.allowed_citation_ids.includes(citation))))invalid('runtime_citation_allowlist');
  }else if(output.candidates.some((c:Row)=>c.citation_ids.some((citation:string)=>!(member.allowed_citations??[]).includes(citation))))invalid('citation_allowlist');
  item.output_sha256=digest(output);
  if(row.deterministic_checks.output_sha256===null)unknown(id,'deterministic_output_binding_unknown');else if(row.deterministic_checks.output_sha256!==item.output_sha256)invalid('deterministic_output_binding');
  const subject=digest({blind_id:row.blind_id,case_sha256:row.case_sha256,input_sha256:row.input_sha256,output,...item.source_audit?.status==='verified'?{runtime_sources_sha256:item.source_audit.binding_sha256,request_sha256:row.request_sha256}:{}});
  if(!Array.isArray(row.reviews))invalid('initial_reviews');
  const reviews=row.reviews.map((r:unknown)=>scoreReview(r,row,output,subject));
  item.reviews=reviews.map(reviewProjection);
  if(reviews.length<2){unknown(id,'independent_reviews_missing');continue;}
  if(reviews.length!==2)invalid('initial_review_count');
  if(reviews[0].reviewer_id===reviews[1].reviewer_id||reviews[0].review_id===reviews[1].review_id)invalid('reviewer_independence');
  const normalized=(r:Row)=>output.candidates.map((c:Row)=>{const v=r.candidates.find((v:Row)=>v.candidate_id===c.candidate_id);return {candidate_id:c.candidate_id,scores:v.scores,severe_errors:v.severe_errors};});
  let selected=reviews[0];
  if(canonical(normalized(reviews[0]))!==canonical(normalized(reviews[1]))){
   if(!row.adjudication){unknown(id,'review_disagreement_unresolved');continue;}
   selected=scoreReview(row.adjudication,row,output,subject);
   if(reviews.some((r:Row)=>r.reviewer_id===selected.reviewer_id||r.review_id===selected.review_id)||!Array.isArray(selected.resolves_review_ids)||canonical([...selected.resolves_review_ids].sort())!==canonical(reviews.map((r:Row)=>r.review_id).sort()))invalid('third_reviewer_adjudication');
   reviews.push(selected);
  }
  item.reviews=reviews.map(reviewProjection);
  if(reviews.some((r:Row)=>!known(r.reviewer_version)||r.reviewer_type==='agent'&&!known(r.reviewer_model))){unknown(id,'reviewer_version_unknown');continue;}
  if(item.source_audit?.status==='undetermined')continue;
  const scores=selected.candidates;
  if(scores.some((c:Row)=>DIMENSIONS.some(k=>c.scores[k]===null)||SEVERE.some(k=>c.severe_errors[k]===null))){unknown(id,'semantic_score_unknown');continue;}
  const mean=(dimension:string)=>scores.reduce((sum:number,c:Row)=>sum+c.scores[dimension],0)/scores.length;
  const usable=['relationship_fit','chinese_usability'].every(k=>scores.every((c:Row)=>c.scores[k]>0)&&mean(k)>=1.5);
  item.pass=Number(usable&&scores.every((c:Row)=>DIMENSIONS.slice(0,3).every(k=>c.scores[k]===2)&&SEVERE.every(k=>c.severe_errors[k]===0)));
  item.usability=(mean('relationship_fit')+mean('chinese_usability'))/2;
  item.severe=Object.fromEntries(SEVERE.map(k=>[k,integerTotal(scores.map((c:Row)=>c.severe_errors[k]))]));
 }
 const arms=Object.fromEntries(ARMS.map(arm=>{const rows=audited.filter(r=>r.arm===arm),knownRows=rows.filter(r=>r.usability!==null);return [arm,{denominator:48,completed:rows.filter(r=>r.status==='succeeded').length,missing:rows.filter(r=>r.status==='missing').length,failed:rows.filter(r=>r.status==='failed').length,cancelled:rows.filter(r=>r.status==='cancelled').length,timeout:rows.filter(r=>r.status==='timeout').length,unknown:rows.filter(r=>r.status==='unknown').length,reviewed:knownRows.filter(r=>r.status==='succeeded').length,scored:knownRows.length,passed:rows.reduce((s,r)=>s+r.pass,0),pass_rate:rows.reduce((s,r)=>s+r.pass,0)/48,usability_mean:knownRows.length===48?knownRows.reduce((s,r)=>s+r.usability!,0)/48:null,known_failure_ids:rows.filter(r=>r.usability!==null&&!r.pass).map(r=>r.id)}];}));
 const paired=(get:(r:Audited)=>number)=>cases.map(c=>Object.fromEntries(ARMS.map(a=>[a,audited.filter(r=>r.case_id===c.case_id&&r.arm===a).map(get)])) as {old:number[];new:number[]});
 const terminalComplete=audited.every(r=>!['missing','unknown'].includes(r.status));
 const failureCounts=Object.fromEntries(ARMS.map(arm=>[arm,audited.filter(r=>r.arm===arm&&['failed','cancelled','timeout'].includes(r.status)).length]));
 const failureRate={status:(!terminalComplete?'undetermined':failureCounts.new>failureCounts.old?'failed':'passed') as Status,old:terminalComplete?failureCounts.old/48:null,new:terminalComplete?failureCounts.new/48:null,denominator:48,known_failures:failureCounts,limit:'new_not_above_old'};
 const semanticComplete=audited.every(r=>r.usability!==null);
 const passDifference=semanticComplete?pairedCaseInterval(paired(r=>r.pass),'mean_difference'):null;
 const usabilityDifference=semanticComplete?pairedCaseInterval(paired(r=>r.usability!),'mean_difference'):null;
 const severe=Object.fromEntries(SEVERE.map(k=>{
  const introduced=cases.flatMap(c=>[1,2,3].flatMap(repeat=>{
   const old=audited.find(r=>r.case_id===c.case_id&&r.arm==='old'&&r.repeat===repeat)!,fresh=audited.find(r=>r.case_id===c.case_id&&r.arm==='new'&&r.repeat===repeat)!;
   return old.severe!==null&&fresh.severe!==null&&fresh.severe[k]>old.severe[k]?[{id:`${c.case_id}:${repeat}`,count:fresh.severe[k]-old.severe[k]}]:[];
  }));
  return [k,{old:semanticComplete?integerTotal(audited.filter(r=>r.arm==='old').map(r=>r.severe![k])):null,new:semanticComplete?integerTotal(audited.filter(r=>r.arm==='new').map(r=>r.severe![k])):null,newly_introduced:integerTotal(introduced.map(pair=>pair.count)),introduced_at:introduced.map(pair=>pair.id)}];
 }));
 const semanticStatus:Status=combineStatus([semanticComplete?combineStatus([lowerGate(passDifference!,-0.03),lowerGate(usabilityDifference!,-0.10)]):'undetermined',...Object.values(severe).map(v=>v.newly_introduced>0?'failed' as const:'passed' as const)]);
 const telemetryFields=['physical_calls','total_tokens','cost','latency_ms'] as const;
 const measurements=new Map<string,Row>();
 for(const item of audited){const row=item.record;if(!row)continue;const usage=row.usage;
  if(row.physical_calls!==null&&!integer(row.physical_calls))invalid('physical_calls');
  let total:number|null=null;
  if(usage!==null){if(!object(usage)||['input_tokens','output_tokens','reasoning_tokens','cache_hit_tokens','cache_miss_tokens'].some(k=>usage[k]!==null&&!integer(usage[k])))invalid('usage');if(Object.values(usage).every(v=>v!==null)){if(usage.reasoning_tokens>usage.output_tokens||usage.cache_hit_tokens+usage.cache_miss_tokens>usage.input_tokens)invalid('usage_components');total=usage.input_tokens+usage.output_tokens;}}
  if(row.cost!==null&&(!object(row.cost)||!nonnegative(row.cost.amount)||row.cost.currency!==run.price_snapshot?.currency||row.cost.price_snapshot_sha256!==run.price_snapshot?.sha256))invalid('cost_or_price_binding');
  const measuredLatency=auditLatency(row,item.id,unknown);
  const metric={physical_calls:row.physical_calls,total_tokens:total,cost:row.cost?.amount??null,latency_ms:measuredLatency};measurements.set(item.id,metric);
  for(const k of telemetryFields)if(metric[k]===null)unknown(item.id,k+'_unknown');
 }
 const actualModels=new Set(audited.flatMap(r=>r.record&&known(r.record.actual_model)?[r.record.actual_model]:[])),fingerprints=new Set(audited.flatMap(r=>r.record&&known(r.record.model_fingerprint)?[r.record.model_fingerprint]:[]));
 if(actualModels.size>1||fingerprints.size>1)unknown(null,'response_model_or_fingerprint_drift_requires_split');
 // 按冻结计划核对实际时间；字段声称AB/BA不足以证明串行配对执行。
 let priorEnd:number|null=null;
 for(const pair of createReplyComparisonPlan(manifestText,datasetText))for(const arm of pair.order==='AB'?['old','new']:['new','old']){
  const row=byId.get(`${pair.case_id}:${arm}:${pair.repeat}`);
  if(!row||!known(row.started_at)||!known(row.ended_at)||!Number.isFinite(Date.parse(row.started_at))||!Number.isFinite(Date.parse(row.ended_at))){priorEnd=null;continue;}
  const started=Date.parse(row.started_at),ended=Date.parse(row.ended_at);
  if(priorEnd!==null&&started<priorEnd)failures.push({record_id:`${pair.case_id}:${arm}:${pair.repeat}`,reason:'execution_order_or_concurrency'});
  priorEnd=ended;
 }
 const metricGate=(field:string,limit:number,statistic:ComparisonStatistic)=>{
  const latency=field==='latency_ms';
  const successfulObservations=cases.map(c=>Object.fromEntries(ARMS.map(arm=>[arm,audited.filter(r=>r.case_id===c.case_id&&r.arm===arm&&r.status==='succeeded').map(r=>measurements.get(r.id)![field])]))) as {old:number[];new:number[]}[];
  const pairedSuccesses=cases.reduce((sum,c)=>sum+[1,2,3].filter(repeat=>ARMS.every(arm=>audited.find(r=>r.case_id===c.case_id&&r.arm===arm&&r.repeat===repeat)!.status==='succeeded')).length,0);
  const samples=latency?{basis:'all_successes_by_case',planned_pairs:48,paired_successes:pairedSuccesses,old_successes:successfulObservations.reduce((sum,c)=>sum+c.old.length,0),new_successes:successfulObservations.reduce((sum,c)=>sum+c.new.length,0)}:{basis:'all_terminal_observations',planned_pairs:48};
  const complete=terminalComplete&&audited.every(r=>measurements.get(r.id)?.[field]!=null)&&(!latency||successfulObservations.every(c=>c.old.length>0&&c.new.length>0));
  const totals=Object.fromEntries(ARMS.map(a=>{const rows=audited.filter(r=>r.arm===a),knownRows=rows.filter(r=>measurements.get(r.id)?.[field]!=null);return [a,{denominator:48,known:knownRows.length,total:knownRows.length===48?comparisonTotal(knownRows.map(r=>measurements.get(r.id)![field])):null,known_total:comparisonTotal(knownRows.map(r=>measurements.get(r.id)![field]))}];}));
  if(!complete)return {status:'undetermined' as Status,limit,statistic,interval:null,totals,samples};
  const interval=pairedCaseInterval(latency?successfulObservations:paired(r=>measurements.get(r.id)![field]),statistic,latency?'successful_observations':'all_repeats');
  const observed={old:interval.baseline,new:interval.candidate};
  if(interval.baseline===0)return {status:(field==='latency_ms'?'undetermined':interval.candidate===0?'passed':'failed') as Status,limit,statistic,interval:null,observed,totals,samples,reason:field==='latency_ms'?'zero_latency_baseline_not_comparable':'zero_baseline_requires_new_zero'};
  return {status:upperGate(interval,limit),limit,statistic,interval:{estimate:Number.isFinite(interval.estimate)?interval.estimate:null,ci95:interval.ci95.map(v=>Number.isFinite(v)?v:null),unbounded:interval.ci95.some(v=>!Number.isFinite(v))},observed,totals,samples};
 };
 const metrics={physical_calls:metricGate('physical_calls',1.05,'total_ratio'),total_tokens:metricGate('total_tokens',1.10,'total_ratio'),cost:metricGate('cost',1.10,'total_ratio'),latency_p50:metricGate('latency_ms',1.15,'p50_ratio'),latency_p95:metricGate('latency_ms',1.25,'p95_ratio')};
 const overall=combineStatus([semanticStatus,failureRate.status,...Object.values(metrics).map(m=>m.status),failures.some(f=>f.blocking!==false)?'failed':unknowns.some(u=>u.blocking!==false)?'undetermined':'passed']);
 return {schema_version:'reply-migration-report-v1',protocol_version:run.protocol_version,domain:'reply',evidence_kind:run.evidence_kind,
  audit_scope:'offline_supplied_evidence_only',production_switch_approved:false,real_model_quality_verified:false,
  model_equivalence:{conclusion:unknowns.some(u=>['actual_model_unknown','model_fingerprint_unknown','response_model_or_fingerprint_drift_requires_split'].includes(u.reason))?'same_request_configuration_only':'same_observed_response_version',underlying_model_equivalence_verified:false},
  bindings:{manifest_sha256:MANIFEST_SHA,dataset_sha256:run.dataset_sha256,config_hash:run.config_hash,price_snapshot:structuredClone(run.price_snapshot),arms:structuredClone(run.bindings)},
  population:{planned:96,received:run.records.length,missing:96-run.records.length},bootstrap:REPLY_COMPARISON_BOOTSTRAP,
  scoring:{factual_dimensions: DIMENSIONS.slice(0,3),required_factual_score:2,usable_dimensions:DIMENSIONS.slice(3),minimum_group_mean:1.5,zero_disallowed:true},
  arms,semantic_quality:{status:semanticStatus,pass_rate_difference:passDifference,usability_difference:usabilityDifference,severe_errors:severe,limits:{pass_rate_difference:-0.03,usability_difference:-0.10},absolute_quality_verified:false},
  failure_rate:failureRate,latency_observations:audited.map(r=>({record_id:r.id,status:r.status,kind:r.status==='succeeded'?'final_persisted_result':r.status==='timeout'?'timeout_lower_bound':'terminal_observation',elapsed_ms:r.record?.timing?.observed_ms??null})),metrics,overall:{status:overall},unknowns,failures,records:audited.map(({record,...rest})=>({...rest,
   ...Object.fromEntries(['blind_id','order','case_sha256','input_sha256','config_hash','commit','request_sha256','actual_model','model_fingerprint','started_at','ended_at','logical_calls','physical_calls','usage','cost','latency_ms','timing','deterministic_checks'].map(k=>[k,record?.[k]===undefined?null:structuredClone(record[k])]))}))};
}
/** 只读取四个显式参数路径；退出2表示证据未通过，退出1表示结构或摘要非法。 */
async function cli(){
 const args=process.argv.slice(2),allowed=['--manifest','--dataset','--run','--output'];
 if(args.length!==8||args.some((arg,index)=>index%2===0&&!allowed.includes(arg))||new Set(args.filter((_,index)=>index%2===0)).size!==4)invalid('usage:--manifest PATH --dataset PATH --run PATH --output PATH');
 const options=Object.fromEntries([0,2,4,6].map(i=>[args[i],args[i+1]]));
 if(['--manifest','--dataset','--run'].some(k=>resolve(options[k])===resolve(options['--output'])))invalid('output_overwrites_input');
 const [manifest,dataset,run]=await Promise.all([readFile(options['--manifest'],'utf8'),readFile(options['--dataset'],'utf8'),readFile(options['--run'],'utf8')]);
 const report=buildReplyComparisonReport(manifest,dataset,JSON.parse(run));await writeFile(options['--output'],JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 process.stdout.write(JSON.stringify({status:report.overall.status,evidence_kind:report.evidence_kind,planned:96,unknowns:report.unknowns.length,failures:report.failures.length})+'\n');process.exitCode=report.overall.status==='passed'?0:2;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))cli().catch(()=>{process.stderr.write('回复离线审计失败：输入结构、摘要或文件路径无效。\n');process.exitCode=1;});
