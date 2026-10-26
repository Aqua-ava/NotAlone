import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as sources from '../src/reply-comparison-sources.ts';
import {buildReplyComparisonReport} from '../src/reply-comparison.ts';
import {createBlindPacket,bindSubmittedReview,digest} from '../experiments/reply-blind-packet.mjs';
const manifestText=await readFile(new URL('./fixtures/reply-comparison-material-manifest.json',import.meta.url),'utf8');
const datasetText=await readFile(new URL('./fixtures/fidelity/synthetic-v1.json',import.meta.url),'utf8'),dataset=JSON.parse(datasetText),manifest=JSON.parse(manifestText);
const fixtureText=await readFile(new URL('./fixtures/reply-comparison-multi-attempt-v4.json',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(fixtureText).digest('hex'),'7ccaff5445d3ba12db5bd7483e6732ab88a5e54153ebba688260a8cdd4c334b6');
const given=JSON.parse(fixtureText),seed='67'.repeat(32),dimensions=['evidence_correctness','intent_preservation','no_unsupported_content','relationship_fit','chinese_usability'];
const capture=()=>({schema_version:'reply-local-paired-collector-v1',protocol_version:'migration-comparison-v1',evidence_kind:'localhost_fake_provider_actual_business_pipelines',synthetic_only:true,real_model_quality_verified:false,production_switch_approved:false,records:structuredClone(given.records)});
const audit=row=>sources.auditReplyRuntimeSources(dataset.cases.find(member=>member.case_id===row.case_id),row,row.output);
function callbackChange(original){
 const changed=structuredClone(original),row=changed.records.find(row=>row.arm==='old'),events=row.partial_observations.events,index=events.findIndex(event=>event.type==='actual_read_file_scope_denied');
 assert.ok(index>=0&&index<events.length-1);assert.ok(events[index+1].at_ms>events[index].at_ms);
 events[index].at_ms=(events[index].at_ms+events[index+1].at_ms)/2;row.actual.partial_observations=structuredClone(row.partial_observations);
 return changed;
}
// 只构造报告器载体元数据；不把新增配置/评审声明追认为原采集或真人盲评。
function reportRun(collection,packet){
 const configuration={provider:'offline-given-capture',endpoint:'http://127.0.0.1',request_model:collection.records[0].runtime_sources.attempts[0].request.body.model,temperature:0,top_p:1,reasoning:'off',max_output_tokens:4096,stop:[],timeout_ms:10000,max_retries:0,seed:null,prompt_hash:'a'.repeat(64),tool_schema_hash:'b'.repeat(64),environment_hash:'c'.repeat(64)};
 const bindings={old:{commit:manifest.baseline_commit,lock_hash:'d'.repeat(64),profile_hash:'e'.repeat(64)},new:{commit:'2'.repeat(40),lock_hash:'f'.repeat(64),profile_hash:'0'.repeat(64),dsh_commit:'687f282e8625c6b8d11ff58211a90524be2e4317'}};
 const run={schema_version:'reply-migration-run-v1',protocol_version:'migration-comparison-v1',evidence_kind:'model_run',synthetic_only:true,manifest_sha256:createHash('sha256').update(manifestText).digest('hex'),dataset_sha256:createHash('sha256').update(datasetText).digest('hex'),configuration,config_hash:digest(configuration),bindings,price_snapshot:null,
  records:collection.records.map(row=>({...structuredClone(row),config_hash:digest(configuration),commit:bindings[row.arm].commit,generated_by:'synthetic-capture-carrier',terminal_status:row.actual.status,latency_ms:null,reviews:[]}))};
 if(packet)for(const row of run.records){
  const binding=packet.binding.items.find(item=>item.original_blind_id===row.blind_id),item=packet.visible.items.find(item=>item.blind_id===binding.blind_id);
  row.reviews=[1,2].map(index=>bindSubmittedReview({capture:collection,dataset,...packet,review:submission(item,index)}));
 }
 return run;
}
function submission(item,index){return {review_id:item.blind_id+'-synthetic-review-'+index,reviewer_id:'independent-synthetic-'+index,reviewer_type:'agent',reviewer_model:'synthetic-review-model',reviewer_version:'synthetic-version',independent:true,blinded:true,blind_id:item.blind_id,subject_sha256:item.review_subject_sha256,candidates:item.candidates.map(candidate=>({candidate:candidate.candidate,basis:'纯离线合成评审绑定用例，不是模型质量结论。',scores:Object.fromEntries(dimensions.map(key=>[key,2])),severe_errors:{false_fact:0,wrong_person:0,unsupported_commitment:0}}))};}
test('多attempt接线：合法callback时间变化必须改变盲评和报告subject，原runtime摘要不变',()=>{
 const original=capture(),changed=callbackChange(original),first=original.records.find(row=>row.arm==='old'),second=changed.records.find(row=>row.arm==='old');
 const before=audit(first),after=audit(second);assert.equal(before.status,'verified');assert.equal(after.status,'verified');
 assert.equal(digest(first.runtime_sources),digest(second.runtime_sources));assert.equal(before.binding_sha256,after.binding_sha256);assert.notEqual(before.derived_proof.sha256,after.derived_proof.sha256);
 const left=createBlindPacket({capture:original,dataset,seed}),right=createBlindPacket({capture:changed,dataset,seed}),binding=packet=>packet.binding.items.find(item=>item.arm==='old');
 assert.notEqual(binding(left).reporter_subject_sha256,binding(right).reporter_subject_sha256);
 assert.notEqual(binding(left).review_subject_sha256,binding(right).review_subject_sha256);assert.notEqual(digest(left.visible),digest(right.visible));
});
test('多attempt接线：两独立合成评审绑定后可报告，94缺失仍未定且不发明单请求hash',()=>{
 const collection=capture(),packet=createBlindPacket({capture:collection,dataset,seed}),run=reportRun(collection,packet),before=structuredClone(run),report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.overall.status,'undetermined');assert.equal(report.population.planned,96);assert.equal(report.population.missing,94);assert.equal(report.arms.old.passed,1);assert.equal(report.arms.new.passed,1);
 assert.equal(report.real_model_quality_verified,false);assert.equal(report.production_switch_approved,false);assert.deepEqual(run,before);assert.deepEqual(collection.records,given.records);
 for(const row of run.records){
  const record=report.records.find(record=>record.id===`${row.case_id}:${row.arm}:${row.repeat}`),proof=record.source_audit.derived_proof;
  assert.equal(record.source_audit.status,'verified');assert.equal(record.source_audit.contract_scope,'constant_workspace_noSkill_read_denied_v1');assert.equal(record.request_sha256,null);
  assert.equal(record.source_audit.binding_sha256,digest(row.runtime_sources));assert.equal(record.deterministic_checks.runtime_sources_sha256,digest(row.runtime_sources));
  assert.equal(proof.runtime_sources_sha256,digest(row.runtime_sources));assert.equal(proof.attempt_bundle.length,2);assert.equal(proof.sha256,audit(row).derived_proof.sha256);
  assert.equal(record.reviews.length,2);assert.ok(!report.unknowns.some(issue=>issue.record_id===record.id&&issue.reason==='request_sha256_unknown'));
 }
 const keys=[];const visit=value=>{if(value&&typeof value==='object')for(const [key,child]of Object.entries(value)){keys.push(key);visit(child);}};visit(report);
 for(const privateKey of ['body','messages','runtime_sources','actual','partial_observations','physical_attempts','request_observation'])assert.equal(keys.includes(privateKey),false,privateKey);
});
test('多attempt接线：callback变化后的新包不能复用旧盲评或旧reporter评审',()=>{
 const original=capture(),left=createBlindPacket({capture:original,dataset,seed}),oldRun=reportRun(original,left),changed=callbackChange(original),right=createBlindPacket({capture:changed,dataset,seed});
 const oldBinding=left.binding.items.find(item=>item.arm==='old'),oldItem=left.visible.items.find(item=>item.blind_id===oldBinding.blind_id);
 assert.throws(()=>bindSubmittedReview({capture:changed,dataset,...right,review:submission(oldItem,1)}),/submitted_review_binding/);
 const run=reportRun(changed);for(const row of run.records)row.reviews=structuredClone(oldRun.records.find(old=>old.arm===row.arm).reviews);
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/independent_blind_review_binding/);
 const rebound=reportRun(changed,right);assert.doesNotThrow(()=>buildReplyComparisonReport(manifestText,datasetText,rebound));
});
test('多attempt接线：公共subject接缝只接完整匹配的已核proof及有序bundle',()=>{
 const row=capture().records[0],original=audit(row),before=structuredClone(original),binding=sources.replyRuntimeSourceSubjectBinding(original);
 assert.deepEqual(binding,{runtime_sources_sha256:digest(row.runtime_sources),runtime_source_proof_sha256:original.derived_proof.sha256});assert.deepEqual(original,before);
 const {sha256,...body}=original.derived_proof;assert.equal(digest(body),sha256);
 for(const mutate of [
  audit=>{delete audit.derived_proof;},audit=>{audit.contract_scope='unsupported_source_contract';},audit=>{audit.derived_proof.sha256='0'.repeat(64);},
  audit=>{audit.derived_proof.runtime_sources_sha256='0'.repeat(64);},audit=>{audit.derived_proof.attempt_bundle.reverse();const {sha256,...body}=audit.derived_proof;audit.derived_proof.sha256=digest(body);},
  audit=>{audit.derived_proof.request_debug={body:{messages:[]}};},
 ]){const changed=structuredClone(original);mutate(changed);assert.throws(()=>sources.replyRuntimeSourceSubjectBinding(changed),/runtime_subject_/);}
 const pending={...structuredClone(original),status:'undetermined'};assert.equal(sources.replyRuntimeSourceSubjectBinding(pending),null);
});
test('多attempt接线：未核验的拒绝scope及其它工具结果不能借首目录通过或豁免未知',()=>{
 for(const mutate of [
  row=>{row.partial_observations.primary_tool_events[0].scope.ownerId='10000000-0000-4000-8000-000000000001';},
  row=>{row.partial_observations.primary_tool_events[0].outcome='succeeded';row.partial_observations.primary_tool_events[0].result='新工具正文';},
 ]){
  const collection=capture(),row=collection.records.find(row=>row.arm==='new');mutate(row);assert.throws(()=>createBlindPacket({capture:collection,dataset,seed}),/runtime_|complete_source_audit_required/);
  let audited;try{audited=audit(row);}catch(error){assert.match(error.message,/runtime_/);continue;}
  assert.equal(audited.status,'undetermined');assert.equal(sources.replyRuntimeSourceSubjectBinding(audited),null);
  const report=buildReplyComparisonReport(manifestText,datasetText,reportRun(collection));assert.equal(report.overall.status,'undetermined');assert.ok(report.unknowns.some(issue=>issue.record_id===`${row.case_id}:${row.arm}:${row.repeat}`&&issue.reason==='request_sha256_unknown'));
 }
});
test('多attempt接线：单臂和缺原来源均保持未知，不能从其它原始观察猜证明',()=>{
 const one=capture();one.records=one.records.filter(row=>row.arm==='old');assert.throws(()=>createBlindPacket({capture:one,dataset,seed}),/complete_pair_required/);
 const incomplete=buildReplyComparisonReport(manifestText,datasetText,reportRun(one));assert.equal(incomplete.overall.status,'undetermined');assert.equal(incomplete.population.missing,95);
 const missing=capture();delete missing.records[0].runtime_sources;
 const run=reportRun(capture());delete run.records[0].runtime_sources;
 const report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.overall.status,'undetermined');assert.ok(report.unknowns.some(issue=>issue.reason==='runtime_sources_missing'));assert.ok(report.unknowns.some(issue=>issue.reason==='request_sha256_unknown'));
 assert.throws(()=>createBlindPacket({capture:missing,dataset,seed}),/complete_source_audit_required/);
});
test('多attempt接线：原single attempt公共片段与盲评及reporter公式保持原样',async()=>{
 const single=JSON.parse(await readFile(new URL('./fixtures/reply-blind-packet-pilot.json',import.meta.url),'utf8')),packet=createBlindPacket({capture:single,dataset,seed});
 for(const row of single.records){
  const audited=audit(row),binding=sources.replyRuntimeSourceSubjectBinding(audited);assert.deepEqual(binding,{runtime_sources_sha256:audited.binding_sha256});
  const privateRow=packet.binding.items.find(item=>item.original_blind_id===row.blind_id),item=packet.visible.items.find(item=>item.blind_id===privateRow.blind_id),{review_subject_sha256,...semantic}=item;
  assert.equal(privateRow.runtime_source_proof_sha256,undefined);
  assert.equal(review_subject_sha256,digest({semantic,raw_output_sha256:digest(row.output),runtime_sources_sha256:audited.binding_sha256,case_sha256:row.case_sha256,input_sha256:row.input_sha256}));
  assert.equal(privateRow.reporter_subject_sha256,digest({blind_id:row.blind_id,case_sha256:row.case_sha256,input_sha256:row.input_sha256,output:row.output,runtime_sources_sha256:audited.binding_sha256,request_sha256:row.request_sha256}));
 }
});
// 仅在内存声明“点与阶段均未知”以触发诊断审计，不是v4实测marker或阶段证明。
function unknownTiming(row){
 row.timing={schema_version:'reply-latency-v2',clock:'monotonic',observed_ms:Date.parse(row.ended_at)-Date.parse(row.started_at),first_event_ms:null,first_token_ms:null,final_persisted_result_ms:null,
  phases:Object.fromEntries(['queue','retrieval','network_model','validation','persistence'].map(name=>[name,null])),
  diagnostics:{request_sha256:null,first_event_ms:{observability:'observable',definition:row.arm==='old'?'completed_sdk_response':'first_incremental_event',reason:'合成：首点未观测。'},first_token_ms:{observability:row.arm==='old'?'unobservable':'observable',definition:'first_incremental_token',reason:row.arm==='old'?'合成：已验证非流式请求没有增量token。':'合成：首token未观测。'}}};
}
test('多attempt诊断：完整proof绑定全部请求模式，不额外造singlehash未知且缺点阶段仍未知',()=>{
 const collection=capture(),packet=createBlindPacket({capture:collection,dataset,seed}),run=reportRun(collection,packet);run.records.forEach(unknownTiming);
 const before=structuredClone(run),report=buildReplyComparisonReport(manifestText,datasetText,run);
 for(const row of run.records){
  const id=`${row.case_id}:${row.arm}:${row.repeat}`,observed=report.latency_observations.find(item=>item.record_id===id),issues=report.unknowns.filter(issue=>issue.record_id===id);
  assert.equal(row.request_sha256,null);assert.ok(!issues.some(issue=>['request_sha256_unknown','latency_diagnostic_request_unknown'].includes(issue.reason)));
  assert.equal(observed.diagnostics.first_token_ms.request_sha256,null);assert.equal(observed.diagnostics.first_token_ms.runtime_source_proof_sha256,audit(row).derived_proof.sha256);
  assert.ok(issues.some(issue=>issue.reason==='latency_phase_queue_unknown'&&issue.blocking));assert.ok(issues.some(issue=>issue.reason==='latency_final_persisted_result_unknown'&&issue.blocking));
  assert.ok(issues.some(issue=>issue.reason==='latency_first_event_ms_unknown'&&issue.blocking));
 }
 assert.equal(report.overall.status,'undetermined');assert.equal(report.metrics.latency_p50.status,'undetermined');assert.deepEqual(run,before);
 const illegal=structuredClone(run),old=illegal.records.find(row=>row.arm==='old');old.timing.first_token_ms=1;
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,illegal),/latency_diagnostic_contradiction/);
});
function rebindStream(row,index,stream){
 const attempt=row.runtime_sources.attempts[index],request=attempt.request,trace=row.physical_attempts[index];
 if(stream===undefined)delete request.body.stream;else request.body.stream=stream;
 if(request.hash_kind==='wire_utf8_sha256'){request.raw_utf8=JSON.stringify(request.body);request.sha256=createHash('sha256').update(request.raw_utf8).digest('hex');}else request.sha256=digest(request.body);
 attempt.catalog.request_sha256=request.sha256;attempt.catalog_sha256=digest(attempt.catalog);
 trace.request=structuredClone(request.body);trace.request_sha256=request.sha256;trace.source_catalog=structuredClone(attempt.catalog);trace.source_catalog_sha256=attempt.catalog_sha256;
 if(request.raw_utf8!==undefined)trace.raw_utf8=request.raw_utf8;
 row.runtime_sources.persistence.catalog_sha256=row.runtime_sources.attempts[0].catalog_sha256;row.deterministic_checks.runtime_sources_sha256=digest(row.runtime_sources);
}
test('多attempt诊断：缺失模式不猜默认值，未核proof不借原请求模式，混合配置仍拒绝',()=>{
 const missing=capture(),old=missing.records.find(row=>row.arm==='old');rebindStream(old,0,undefined);rebindStream(old,1,undefined);assert.equal(audit(old).status,'verified');
 let run=reportRun(missing);run.records.forEach(unknownTiming);let report=buildReplyComparisonReport(manifestText,datasetText,run);
 let id=`${old.case_id}:${old.arm}:${old.repeat}`;assert.ok(report.unknowns.some(issue=>issue.record_id===id&&issue.reason==='latency_diagnostic_stream_mode_unknown'&&issue.blocking));
 assert.equal(report.latency_observations.find(item=>item.record_id===id).diagnostics.first_token_ms.observability,'missing');assert.equal(report.overall.status,'undetermined');
 const pending=capture(),unsupported=pending.records.find(row=>row.arm==='old');unsupported.partial_observations.events.find(event=>event.type==='actual_read_file_scope_denied').tool='read_file';unsupported.actual.partial_observations=structuredClone(unsupported.partial_observations);
 assert.equal(audit(unsupported).status,'undetermined');run=reportRun(pending);run.records.forEach(unknownTiming);report=buildReplyComparisonReport(manifestText,datasetText,run);id=`${unsupported.case_id}:${unsupported.arm}:${unsupported.repeat}`;
 assert.ok(report.unknowns.some(issue=>issue.record_id===id&&issue.reason==='latency_diagnostic_request_unknown'&&issue.blocking));assert.equal(report.latency_observations.find(item=>item.record_id===id).diagnostics.first_token_ms.observability,'missing');
 const mixed=capture(),row=mixed.records.find(row=>row.arm==='old');rebindStream(row,1,true);assert.throws(()=>audit(row),/multi_request_configuration_changed/);
});
