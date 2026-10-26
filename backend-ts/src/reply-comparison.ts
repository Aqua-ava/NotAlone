/** 仅审计显式提供的合成离线证据，不执行模型、读取环境或连接数据库。 */
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {comparisonPairOrders,comparisonTotal,pairedCaseInterval,REPLY_COMPARISON_BOOTSTRAP,type ComparisonStatistic} from './reply-comparison-statistics.ts';
import {auditReplyRuntimeSources,replyRuntimeSourceSubjectBinding,type ReplyRuntimeSourceAudit,type ReplyRuntimeSourceSubjectBinding} from './reply-comparison-sources.ts';
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
 // 冻结清单中的路径是历史来源键；当前数据已迁至 backend-ts/test/fixtures，清单字节与摘要保持不变。
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
export interface ReplyComparisonReportOptions {
 costWaiver?:{status:'waived_by_user';scope_ref:string;scope_sha256:string};
}
/** 只投影合同列出的标量元数据；其余对象仍留在显式输入证据中。 */
function metadataFields(value:unknown,fields:readonly string[]):Row|null {
 if(!object(value))return null;
 return Object.fromEntries(fields.filter(key=>Object.hasOwn(value,key)).map(key=>{const item=value[key];return [key,typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item)?item:null];}));
}
const metadataText=(value:unknown):string|null=>typeof value==='string'?value:null;
const reviewProjection=(r:Row)=>({review_id:r.review_id,reviewer_id:r.reviewer_id,reviewer_type:r.reviewer_type,reviewer_model:metadataText(r.reviewer_model),reviewer_version:metadataText(r.reviewer_version),subject_sha256:r.subject_sha256,candidates:r.candidates.map((candidate:Row)=>({...metadataFields(candidate,['candidate_id','basis']),scores:metadataFields(candidate.scores,DIMENSIONS),severe_errors:metadataFields(candidate.severe_errors,SEVERE)}))});
function sourceAuditProjection(audit:ReplyRuntimeSourceAudit):Row {
 return {...metadataFields(audit,['status','reason','binding_sha256','output_scope','attempt_count','request_id','contract_scope']),allowed_citation_ids:[...audit.allowed_citation_ids],attempt_ids:[...audit.attempt_ids],attempt_observations:audit.attempt_observations.map(value=>metadataFields(value,['attempt_id','request_sha256','request_hash_kind','catalog_sha256','response_started_at'])),...audit.derived_proof?{derived_proof:{...metadataFields(audit.derived_proof,['schema_version','contract_scope','internal_consistency_only','derived_after_capture','runtime_sources_sha256','transition_sha256','partial_observations_sha256','actual_result_sha256','physical_trace_sha256','real_model_quality_verified','production_switch_approved','sha256']),attempt_bundle:audit.derived_proof.attempt_bundle.map((attempt:Row)=>metadataFields(attempt,['attempt_id','request_sha256','catalog_sha256']))}}:{}};
}
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
interface LatencyAudit {latency_ms:number|null;diagnostics:Row;phase_coverage:Row|null}
const DIAGNOSTICS=['first_event_ms','first_token_ms'] as const;
const LATENCY_PHASES=['queue','retrieval','network_model','validation','persistence'];
interface TimingSegment {name:string;started_ms:number;ended_ms:number}
const spanProjection=(value:Row):Row=>({...metadataFields(value,['started_ms','ended_ms']),...value.markers!==undefined?{markers:metadataFields(value.markers,['start','end'])}:{}});
const overheadProjection=(entries:Row[]):Row[]=>entries.map(entry=>({...spanProjection(entry),...metadataFields(entry,['kind','reason'])}));
function timingProjection(value:unknown):Row|null {
 if(!object(value))return null;
 const phase=(entry:any):any=>entry==null?null:Array.isArray(entry)?entry.map(spanProjection):spanProjection(entry);
 return {...metadataFields(value,['schema_version','clock','observed_ms','first_event_ms','first_token_ms','final_persisted_result_ms']),phases:Object.fromEntries(LATENCY_PHASES.map(name=>[name,phase(value.phases[name])])),
  ...value.overhead!==undefined?{overhead:overheadProjection(value.overhead)}:{},
  ...value.diagnostics!==undefined?{diagnostics:value.diagnostics===null?null:{...metadataFields(value.diagnostics,['request_sha256']),...Object.fromEntries(DIAGNOSTICS.map(name=>[name,metadataFields(value.diagnostics[name],['observability','definition','reason'])]))}}:{}};
}
/** 使用区间并集保留真实重叠和间隙，不把方法时长相加或猜给某个阶段。 */
function timingRegions(segments:readonly TimingSegment[]):{started_ms:number;ended_ms:number}[]{
 const regions:{started_ms:number;ended_ms:number}[]=[];
 for(const segment of [...segments].filter(item=>item.ended_ms>item.started_ms).sort((a,b)=>a.started_ms-b.started_ms)){
  const last=regions.at(-1);
  if(last&&segment.started_ms<=last.ended_ms)last.ended_ms=Math.max(last.ended_ms,segment.ended_ms);
  else regions.push({started_ms:segment.started_ms,ended_ms:segment.ended_ms});
 }
 return regions;
}
function auditPhaseCoverage(timing:Row,id:string,unknown:(id:string,reason:string,blocking?:boolean)=>void):{segments:TimingSegment[];coverage:Row}{
 if(Object.keys(timing.phases).sort().join(',')!==[...LATENCY_PHASES].sort().join(','))invalid('latency_phases');
 const markerTimes=new Map<string,number>();let distinguished=true;
 const interval=(value:unknown,name:string,fields:readonly string[]=['started_ms','ended_ms','markers']):TimingSegment=>{if(!object(value)||!nonnegative(value.started_ms)||!nonnegative(value.ended_ms)||value.ended_ms<value.started_ms||value.ended_ms>timing.observed_ms)invalid('latency_phase_order');if(Object.keys(value).some(key=>!fields.includes(key)))invalid('latency_interval_fields');return {name,started_ms:value.started_ms,ended_ms:value.ended_ms};};
 const markers=(value:Row,segment:TimingSegment):boolean=>{
  if(value.markers==null)return false;
  if(!object(value.markers)||Object.keys(value.markers).sort().join(',')!=='end,start'||!text(value.markers.start)||!text(value.markers.end)||value.markers.start===value.markers.end)invalid('latency_phase_markers');
  for(const [marker,at]of [[value.markers.start,segment.started_ms],[value.markers.end,segment.ended_ms]] as [string,number][]){if(markerTimes.has(marker)&&markerTimes.get(marker)!==at)invalid('latency_phase_marker_time');markerTimes.set(marker,at);}
  return true;
 };
 const segments:TimingSegment[]=[],observedPhases:string[]=[];
 for(const name of LATENCY_PHASES){
  const value=timing.phases[name],entries=value==null?[]:Array.isArray(value)?value:[value];let knownPhase=entries.length>0;
  for(const entry of entries){const segment=interval(entry,name),marked=markers(entry,segment);segments.push(segment);if((timing.schema_version==='reply-latency-v2'||segment.started_ms===segment.ended_ms)&&!marked)knownPhase=false;}
  if(knownPhase)observedPhases.push(name);else{distinguished=false;unknown(id,'latency_phase_'+name+'_unknown');}
 }
 if(timing.overhead!==undefined&&!Array.isArray(timing.overhead))invalid('latency_overhead');
 const overhead:TimingSegment[]=(timing.overhead??[]).map((entry:unknown)=>{
  const segment=interval(entry,'framework_overhead',['started_ms','ended_ms','kind','reason','markers']);
  if(!object(entry)||entry.kind!=='framework_overhead'||!text(entry.reason)||!markers(entry,segment))invalid('latency_overhead');
  if(segments.some(phase=>Math.max(phase.started_ms,segment.started_ms)<Math.min(phase.ended_ms,segment.ended_ms)))invalid('latency_overhead_phase_overlap');
  return segment;
 });
 const phaseRegions=timingRegions(segments),overheadRegions=timingRegions(overhead),allRegions=timingRegions([...segments,...overhead]);
 const unclassified:Row[]=[];let end=0;
 for(const region of allRegions){if(region.started_ms>end)unclassified.push({started_ms:end,ended_ms:region.started_ms});end=region.ended_ms;}
 if(end<timing.observed_ms)unclassified.push({started_ms:end,ended_ms:timing.observed_ms});
 if(unclassified.length){distinguished=false;unknown(id,'latency_unclassified_may_include_target_phase');}
 const duration=(regions:{started_ms:number;ended_ms:number}[])=>comparisonTotal(regions.map(region=>region.ended_ms-region.started_ms));
 return {segments,coverage:{observed_phases:observedPhases,observed_phase_union_ms:duration(phaseRegions),framework_overhead_ms:duration(overheadRegions),framework_overhead:overheadProjection(timing.overhead??[]),unclassified,unclassified_ms:duration(unclassified as {started_ms:number;ended_ms:number}[]),target_phases_distinguished:distinguished,exclusive_partition_required:false,durations_not_summed:true,marker_contract:timing.schema_version==='reply-latency-v2'?'explicit_start_end_markers':'legacy_declared_positive_intervals'}};
}
/** 复用实际请求观测的摘要合同；请求正文不复制到报告。 */
function diagnosticRequest(row:Row,id:string,unknown:(id:string,reason:string,blocking?:boolean)=>void,sourceAudit?:ReplyRuntimeSourceAudit):{stream:boolean|null;runtime_source_proof_sha256?:string} {
 const attempts=row.runtime_sources?.attempts;
 const binding=sourceAudit?replyRuntimeSourceSubjectBinding(sourceAudit):null;
 if(binding?.runtime_source_proof_sha256){
  if(!object(row.runtime_sources)||digest(row.runtime_sources)!==binding.runtime_sources_sha256||!Array.isArray(attempts)||attempts.length!==sourceAudit!.attempt_count)invalid('latency_diagnostic_source_binding');
  const modes=attempts.map((attempt:Row)=>attempt.request?.body?.stream),proof={runtime_source_proof_sha256:binding.runtime_source_proof_sha256};
  if(modes.some(mode=>typeof mode!=='boolean')||!modes.every(mode=>mode===modes[0])){unknown(id,'latency_diagnostic_stream_mode_unknown');return {stream:null,...proof};}
  return {stream:modes[0],...proof};
 }
 const request=Array.isArray(attempts)&&attempts.length===1?attempts[0]?.request:row.runtime_sources===undefined?row.request_observation:undefined;
 if(request==null||!hashString(row.request_sha256)){unknown(id,'latency_diagnostic_request_unknown');return {stream:null};}
 if(!object(request)||!object(request.body)||request.sha256!==row.request_sha256)invalid('latency_diagnostic_request_binding');
 if(request.hash_kind==='wire_utf8_sha256'){
  if(typeof request.raw_utf8!=='string'||digest(request.raw_utf8)!==request.sha256)invalid('latency_diagnostic_request_hash');
  let parsed:unknown;try{parsed=JSON.parse(request.raw_utf8);}catch{return invalid('latency_diagnostic_request_json');}
  if(canonical(parsed)!==canonical(request.body))invalid('latency_diagnostic_request_body');
 }else if(request.hash_kind!=='canonical_json_sha256'||request.raw_utf8!==undefined||digest(request.body)!==request.sha256)invalid('latency_diagnostic_request_hash');
 if(typeof request.body.stream!=='boolean'){unknown(id,'latency_diagnostic_stream_mode_unknown');return {stream:null};}
 return {stream:request.body.stream};
}
/** 所有阶段使用同一单调时钟的相对毫秒；墙钟只按ISO毫秒精度核对总时长。 */
function auditLatency(row:Row,id:string,unknown:(id:string,reason:string,blocking?:boolean)=>void,persistedResultKnown:boolean,sourceAudit?:ReplyRuntimeSourceAudit):LatencyAudit {
 const result:LatencyAudit={latency_ms:null,diagnostics:{},phase_coverage:null};
 if(row.latency_ms!==null&&!nonnegative(row.latency_ms))invalid('latency');
 const timing=row.timing;
 if(timing===null||timing===undefined){unknown(id,'latency_evidence_unknown');return result;}
 if(!object(timing)||!['reply-latency-v1','reply-latency-v2'].includes(timing.schema_version)||timing.clock!=='monotonic'||!object(timing.phases))invalid('latency_evidence_structure');
 if(Object.keys(timing).some(key=>!['schema_version','clock','observed_ms','first_event_ms','first_token_ms','final_persisted_result_ms','phases','overhead','diagnostics'].includes(key)))invalid('latency_timing_fields');
 if(!nonnegative(timing.observed_ms))invalid('latency_observed');
 const {segments,coverage}=auditPhaseCoverage(timing,id,unknown);result.phase_coverage=coverage;
 const model=segments.filter(segment=>segment.name==='network_model');
 let resultTimeKnown=true;
 const declared=timing.schema_version==='reply-latency-v2'||timing.diagnostics!==undefined?timing.diagnostics:null;
 if(timing.schema_version==='reply-latency-v2'&&declared===null||declared!==null&&(!object(declared)||Object.keys(declared).sort().join(',')!=='first_event_ms,first_token_ms,request_sha256'||declared.request_sha256!==row.request_sha256))invalid('latency_diagnostic_contract');
 const request=declared!==null||row.runtime_sources!==undefined||row.request_observation!==undefined?diagnosticRequest(row,id,unknown,sourceAudit):{stream:null},stream=request.stream;
 if(stream===false&&timing.first_token_ms!==null)invalid('latency_diagnostic_contradiction');
 // 可观测性未知不能伪装不可观测；旧v1的保守处理不构成协议额外阈值。
 for(const name of DIAGNOSTICS){
  let unobservable=false,definition:string|null=null,reason:string|null=null;
  if(declared!==null){
   const entry=declared[name];
   if(!object(entry)||Object.keys(entry).sort().join(',')!=='definition,observability,reason'||!['observable','unobservable'].includes(entry.observability)||!['first_incremental_event','completed_sdk_response','first_incremental_token'].includes(entry.definition)||name==='first_token_ms'&&entry.definition!=='first_incremental_token'||name==='first_event_ms'&&entry.definition==='first_incremental_token'||entry.reason!==null&&!text(entry.reason))invalid('latency_diagnostic_observability');
   definition=entry.definition;reason=entry.reason;
   if(entry.observability==='unobservable'){
    if(!text(reason)||timing[name]!==null||stream===true||definition==='completed_sdk_response')invalid('latency_diagnostic_contradiction');
    unobservable=stream===false;
   }else if(name==='first_token_ms'&&stream===false)invalid('latency_diagnostic_contradiction');
   if(name==='first_event_ms'&&(stream===true&&definition==='completed_sdk_response'||stream===false&&definition==='first_incremental_event'&&entry.observability==='observable'))invalid('latency_diagnostic_contradiction');
  }
  if(timing[name]===null){
   reason??='缺少可观测性绑定或实际marker，不能把未知写成0。';
   if(row.terminal_status==='succeeded')unknown(id,'latency_'+name+'_unknown',!unobservable);
  }else if(!nonnegative(timing[name])||!model.some(segment=>timing[name]>=segment.started_ms&&timing[name]<=segment.ended_ms))invalid('latency_'+name);
  result.diagnostics[name]={value_ms:timing[name],observability:timing[name]!==null?'observed':unobservable?'unobservable':'missing',definition,reason,request_sha256:declared?.request_sha256??null,...request.runtime_source_proof_sha256?{runtime_source_proof_sha256:request.runtime_source_proof_sha256}:{}};
 }
 if(timing.first_event_ms!==null&&timing.first_token_ms!==null&&timing.first_token_ms<timing.first_event_ms)invalid('latency_event_token_order');
 if(row.terminal_status==='succeeded'){
  if(timing.final_persisted_result_ms===null){unknown(id,'latency_final_persisted_result_unknown');resultTimeKnown=false;}
  else if(!nonnegative(timing.final_persisted_result_ms)||timing.final_persisted_result_ms!==timing.observed_ms)invalid('latency_final_persisted_result');
  if(!persistedResultKnown){unknown(id,'latency_persisted_result_binding_unknown');resultTimeKnown=false;}
 }else if(timing.final_persisted_result_ms!==null)invalid('latency_failed_result_persisted');
 if(!known(row.started_at)||!known(row.ended_at)||!Number.isFinite(Date.parse(row.started_at))||!Number.isFinite(Date.parse(row.ended_at))){unknown(id,'run_times_unknown');return result;}
 const elapsed=Date.parse(row.ended_at)-Date.parse(row.started_at);
 if(elapsed<0||Math.abs(elapsed-timing.observed_ms)>1)invalid('latency_wall_clock_duration');
 if(row.latency_ms===null)return result;
 if(row.latency_ms!==timing.observed_ms)invalid('latency_duration_binding');
 result.latency_ms=resultTimeKnown?row.latency_ms:null;return result;
}
/**
 * 唯一报告接缝：原始输入不改写，输出不复制正文。前3维所有候选均须为2才满足事实/意图；
 * 关系与中文分别无0且组均分>=1.5。未知值保持null，分母始终每臂48。
 */
export function buildReplyComparisonReport(manifestText:string,datasetText:string,value:unknown,options:ReplyComparisonReportOptions={}){
 if(!object(options)||Object.keys(options).some(key=>key!=='costWaiver'))invalid('report_options');
 const costWaiver=options.costWaiver;
 if(costWaiver!==undefined&&(!object(costWaiver)||Object.keys(costWaiver).sort().join(',')!=='scope_ref,scope_sha256,status'||costWaiver.status!=='waived_by_user'||!known(costWaiver.scope_ref)||!hashString(costWaiver.scope_sha256)))invalid('cost_waiver');
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
 if(run.price_snapshot===null)unknown(null,'price_snapshot_unknown',costWaiver===undefined);
 const byId=new Map<string,Row>(),blindIds=new Set<string>(),deferredRequestHashes=new Set<string>(),orders=new Map(createReplyComparisonPlan(manifestText,datasetText).map(p=>[p.case_id+':'+p.repeat,p.order]));
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
  // 只延后候选multi的null；最终必须完整来源审计与公共subject接缝成立，否则仍unknown。
  if(row.request_sha256===null&&Array.isArray(row.runtime_sources?.attempts)&&row.runtime_sources.attempts.length>1)deferredRequestHashes.add(id);else checkHash(row.request_sha256,id,'request_sha256_unknown');
  if(run.evidence_kind!=='reporter_fixture'&&row.request_observation!==undefined)invalid('latency_diagnostic_fixture_request_forbidden');
  if(!object(row.deterministic_checks)||!['passed','failed','unknown'].includes(row.deterministic_checks.status))invalid('deterministic_checks');
  if(row.deterministic_checks.source_binding_sha256===null)unknown(id,'deterministic_source_binding_unknown');else if(row.deterministic_checks.source_binding_sha256!==row.input_sha256)invalid('deterministic_source_binding');
  if(row.deterministic_checks.status==='unknown')unknown(id,'deterministic_checks_unknown');if(row.deterministic_checks.status==='failed')failures.push({record_id:id,reason:'deterministic_checks_failed'});
  byId.set(id,row);
 }
 const audited:Audited[]=[],runtimeRequestIds=new Set<string>(),runtimeAttemptIds=new Set<string>(),sourceSubjects=new Map<string,ReplyRuntimeSourceSubjectBinding>();
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
   const binding=replyRuntimeSourceSubjectBinding(item.source_audit);if(binding)sourceSubjects.set(id,binding);
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
  const subject=digest({blind_id:row.blind_id,case_sha256:row.case_sha256,input_sha256:row.input_sha256,output,...sourceSubjects.has(id)?{...sourceSubjects.get(id),request_sha256:row.request_sha256}:{}});
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
 for(const id of deferredRequestHashes)if(!sourceSubjects.get(id)?.runtime_source_proof_sha256)unknown(id,'request_sha256_unknown');
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
 const measurements=new Map<string,Row>(),latencyAudits=new Map<string,LatencyAudit>();
 for(const item of audited){const row=item.record;if(!row)continue;const usage=row.usage;
  if(row.physical_calls!==null&&!integer(row.physical_calls))invalid('physical_calls');
  let total:number|null=null;
  if(usage!==null){if(!object(usage)||['input_tokens','output_tokens','reasoning_tokens','cache_hit_tokens','cache_miss_tokens'].some(k=>usage[k]!==null&&!integer(usage[k])))invalid('usage');if(Object.values(usage).every(v=>v!==null)){if(usage.reasoning_tokens>usage.output_tokens||usage.cache_hit_tokens+usage.cache_miss_tokens>usage.input_tokens)invalid('usage_components');total=usage.input_tokens+usage.output_tokens;}}
  if(row.cost!==null&&(!object(row.cost)||!nonnegative(row.cost.amount)||row.cost.currency!==run.price_snapshot?.currency||row.cost.price_snapshot_sha256!==run.price_snapshot?.sha256))invalid('cost_or_price_binding');
  const runtime=run.evidence_kind==='model_run'||row.runtime_sources!==undefined;
  const persistedResultKnown=runtime?item.source_audit?.status==='verified':row.deterministic_checks.status==='passed'&&object(row.output)&&row.deterministic_checks.output_sha256===digest(row.output);
  const measuredLatency=auditLatency(row,item.id,unknown,persistedResultKnown,item.source_audit);latencyAudits.set(item.id,measuredLatency);
  const metric={physical_calls:row.physical_calls,total_tokens:total,cost:row.cost?.amount??null,latency_ms:measuredLatency.latency_ms};measurements.set(item.id,metric);
  for(const k of telemetryFields)if(metric[k]===null)unknown(item.id,k+'_unknown',k!=='cost'||costWaiver===undefined);
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
 const latencyDiagnostics=Object.fromEntries(DIAGNOSTICS.map(name=>[name,Object.fromEntries(ARMS.map(arm=>{const rows=audited.filter(row=>row.arm===arm),count=(status:string)=>rows.filter(row=>(latencyAudits.get(row.id)?.diagnostics[name]?.observability??'missing')===status).length;return [arm,{denominator:48,observed:count('observed'),unobservable:count('unobservable'),missing:count('missing')}];}))]));
 // 用户本轮豁免仅影响费用资格；原测量、历史阈值结论及其他失败仍保留。
 const overall=combineStatus([semanticStatus,failureRate.status,...Object.entries(metrics).filter(([key])=>key!=='cost'||costWaiver===undefined).map(([,metric])=>metric.status),failures.some(f=>f.blocking!==false)?'failed':unknowns.some(u=>u.blocking!==false)?'undetermined':'passed']);
 return {schema_version:'reply-migration-report-v1',protocol_version:run.protocol_version,domain:'reply',evidence_kind:run.evidence_kind,
  ...costWaiver?{cost_status:'waived_by_user' as const,cost_qualification:{...costWaiver,threshold_applied:false}}:{},
  audit_scope:'offline_supplied_evidence_only',production_switch_approved:false,real_model_quality_verified:false,
  model_equivalence:{conclusion:unknowns.some(u=>['actual_model_unknown','model_fingerprint_unknown','response_model_or_fingerprint_drift_requires_split'].includes(u.reason))?'same_request_configuration_only':'same_observed_response_version',underlying_model_equivalence_verified:false},
  bindings:{manifest_sha256:MANIFEST_SHA,dataset_sha256:run.dataset_sha256,config_hash:run.config_hash,price_snapshot:metadataFields(run.price_snapshot,['currency','sha256']),arms:{old:metadataFields(run.bindings.old,['commit','lock_hash','profile_hash']),new:metadataFields(run.bindings.new,['commit','lock_hash','profile_hash','dsh_commit'])}},
  population:{planned:96,received:run.records.length,missing:96-run.records.length},bootstrap:REPLY_COMPARISON_BOOTSTRAP,
  scoring:{factual_dimensions: DIMENSIONS.slice(0,3),required_factual_score:2,usable_dimensions:DIMENSIONS.slice(3),minimum_group_mean:1.5,zero_disallowed:true},
  arms,semantic_quality:{status:semanticStatus,pass_rate_difference:passDifference,usability_difference:usabilityDifference,severe_errors:severe,limits:{pass_rate_difference:-0.03,usability_difference:-0.10},absolute_quality_verified:false},
  failure_rate:failureRate,latency_diagnostics:latencyDiagnostics,latency_observations:audited.map(r=>({record_id:r.id,status:r.status,kind:r.status==='succeeded'?'final_persisted_result':r.status==='timeout'?'timeout_lower_bound':'terminal_observation',elapsed_ms:r.record?.timing?.observed_ms??null,diagnostics:latencyAudits.get(r.id)?.diagnostics??{},phase_coverage:latencyAudits.get(r.id)?.phase_coverage??null})),metrics,overall:{status:overall},unknowns,failures,records:audited.map(r=>({id:r.id,case_id:r.case_id,arm:r.arm,repeat:r.repeat,status:r.status,pass:r.pass,usability:r.usability,severe:r.severe,reviews:r.reviews,output_sha256:r.output_sha256,...r.source_audit?{source_audit:sourceAuditProjection(r.source_audit)}:{},
   ...Object.fromEntries(['blind_id','order','case_sha256','input_sha256','config_hash','commit','request_sha256','actual_model','model_fingerprint','started_at','ended_at'].map(k=>[k,metadataText(r.record?.[k])])),logical_calls:r.record?.logical_calls??null,physical_calls:r.record?.physical_calls??null,latency_ms:r.record?.latency_ms??null,
   usage:metadataFields(r.record?.usage,['input_tokens','output_tokens','reasoning_tokens','cache_hit_tokens','cache_miss_tokens']),cost:metadataFields(r.record?.cost,['amount','currency','price_snapshot_sha256']),timing:timingProjection(r.record?.timing),
   deterministic_checks:metadataFields(r.record?.deterministic_checks,['status','source_binding_sha256','output_sha256','runtime_sources_sha256'])}))};
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
