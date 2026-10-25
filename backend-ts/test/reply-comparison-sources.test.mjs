import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {buildReplyComparisonReport} from '../src/reply-comparison.ts';
import {auditReplyRuntimeSources,captureReplyRuntimeSourceAttempt,replyComparisonCollectorBinding} from '../src/reply-comparison-sources.ts';
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const manifestText=await readFile(new URL('./fixtures/reply-comparison-material-manifest.json',import.meta.url),'utf8');
const datasetText=await readFile(new URL('../../backend/tests/fixtures/fidelity/synthetic-v1.json',import.meta.url),'utf8');
const originalPilot=JSON.parse(await readFile(new URL('./fixtures/reply-comparison-source-pilot.json',import.meta.url),'utf8'));
function reportRun(collection){
 const configuration={provider:'syntax-probe-only',endpoint:'http://127.0.0.1',request_model:'syntax-probe-only',temperature:0,top_p:1,reasoning:'off',max_output_tokens:4096,stop:[],timeout_ms:10000,max_retries:0,seed:null,prompt_hash:null,tool_schema_hash:null,environment_hash:null};
 return {schema_version:'reply-migration-run-v1',protocol_version:'migration-comparison-v1',evidence_kind:'model_run',synthetic_only:true,manifest_sha256:hash(manifestText),dataset_sha256:hash(datasetText),configuration,config_hash:null,
  bindings:{old:{commit:collection.source_bindings.old_commit,lock_hash:null,profile_hash:null},new:{commit:collection.source_bindings.new_commit,dsh_commit:collection.source_bindings.dsh_commit,lock_hash:null,profile_hash:null}},price_snapshot:null,
  records:collection.records.map(row=>{const output={candidates:row.actual.result.candidates.map(c=>({candidate_id:c.candidate_id,text:c.text,basis:c.basis,citation_ids:c.citation_ids}))};return {
   case_id:row.case_id,arm:row.arm,repeat:row.repeat,order:row.order,blind_id:row.blind_id,case_sha256:row.case_sha256,input_sha256:row.input_sha256,config_hash:null,commit:row.arm==='old'?collection.source_bindings.old_commit:collection.source_bindings.new_commit,
   generated_by:'localhost-response-fixture',terminal_status:row.actual.status,logical_calls:1,physical_calls:row.physical_calls,actual_model:row.actual_model,model_fingerprint:null,started_at:row.started_at,ended_at:row.ended_at,
   latency_ms:null,timing:null,request_sha256:row.request_sha256,usage:row.usage,cost:null,output,reviews:[],runtime_sources:row.runtime_sources,
   deterministic_checks:{status:'passed',source_binding_sha256:row.input_sha256,output_sha256:hash(output)}};})};
}
test('真实旧新pilot引用保持原样，缺更强采集目录应未定而非误报冻结引用非法',()=>{
 const run=reportRun(originalPilot),before=structuredClone(run);
 const report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.overall.status,'undetermined');
 assert.ok(report.unknowns.some(item=>item.reason==='runtime_sources_missing'));
 assert.equal(report.records.filter(item=>item.record_id===null).length,0);
 assert.deepEqual(run,before);
});
/** 下面的时间/目录是审计器合成声明，专测规则；不得冒充原pilot的历史事实。 */
function syntheticAuditRun(){
 const run=reportRun(originalPilot);run.evidence_kind='reporter_fixture';
 for(const [index,row]of run.records.entries()){
  const raw=structuredClone(originalPilot.records[index]),physical=raw.physical_attempts[0],previous=physical.source_catalog;
  const start=Date.UTC(2026,9,24,10)+index*1000;
  row.started_at=new Date(start).toISOString();row.ended_at=new Date(start+100).toISOString();row.scope=raw.scope;
  const kind=row.arm==='old'?'wire_utf8_sha256':'canonical_json_sha256';
  const body=physical.request,wire=JSON.stringify(body),requestHash=kind==='wire_utf8_sha256'?hash(wire):hash(body);row.request_sha256=requestHash;
  const catalog={schema_version:'reply-runtime-source-catalog-v1',case_id:row.case_id,repeat:row.repeat,arm:row.arm,case_sha256:row.case_sha256,input_sha256:row.input_sha256,
   request_sha256:requestHash,request_hash_kind:kind,scope:raw.scope,request_id:raw.actual.result.reply_request_id,
   entries:physical.evidence.map(source=>({...source,...Object.fromEntries(Object.entries(previous.entries.find(e=>e.evidence_id===source.evidence_id)).filter(([key])=>['text_sha256','case_fields','origin','source_ids','not_confirmed_memory'].includes(key)))})),
   strategy_fields:previous.strategy_fields,covered_input_fields:previous.covered_input_fields,oracle_fields_excluded:previous.oracle_fields_excluded,
   captured_at:new Date(start+10).toISOString(),capture_boundary:'request_received_before_supplier_response',stored_evidence_verified_after_completion:false};
  row.runtime_sources={schema_version:'reply-runtime-sources-v1',scope:raw.scope,request_id:catalog.request_id,
   attempts:[{attempt_id:index?'a0000000-0000-4000-8000-000000000002':'a0000000-0000-4000-8000-000000000001',attempt_id_kind:'collector_http_observation_not_ledger_id',request:{body,hash_kind:kind,sha256:requestHash,...kind==='wire_utf8_sha256'?{raw_utf8:wire}:{}},response_started_at:new Date(start+20).toISOString(),catalog,catalog_sha256:hash(catalog)}],
   persistence:{catalog_sha256:hash(catalog),request_id:catalog.request_id,scope:raw.scope,snapshot:raw.source_storage_receipt.snapshot,snapshot_sha256:hash(raw.source_storage_receipt.snapshot),output:structuredClone(row.output),output_sha256:hash(row.output),observed_at:new Date(start+110).toISOString(),verified_after_completion:true}};
  row.deterministic_checks.runtime_sources_sha256=hash(row.runtime_sources);
 }
 return run;
}
test('严格目录由实际请求三路六字段与同scope PG声明导出引用，合成声明不认证历史事实',()=>{
 const run=syntheticAuditRun(),before=structuredClone(run),report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.deepEqual(report.records.filter(r=>r.status==='succeeded').map(r=>r.source_audit.status),['verified','verified']);
 assert.equal(report.overall.status,'undetermined');assert.equal(report.audit_scope,'offline_supplied_evidence_only');assert.deepEqual(run,before);
});
function aliasedAuditRun(){
 const run=syntheticAuditRun();
 for(const row of run.records.filter(item=>item.arm==='new')){
  rewritePayload(row,payload=>{
   payload.evidence.forEach((source,index)=>{source.evidence_id=`c${index+1}`;});
   payload.citation_policy.allowed_evidence_ids=payload.evidence.map(source=>source.evidence_id);
  });
  const catalog=row.runtime_sources.attempts[0].catalog;
  catalog.schema_version='reply-runtime-source-catalog-v2';
  row.runtime_sources.attempts[0].model_alias_mapping=catalog.entries.map((entry,index)=>({model_evidence_id:`c${index+1}`,evidence_id:entry.evidence_id}));
  const argvSha256='d'.repeat(64),catalogSha256=hash(catalog);
  row.runtime_sources.attempts[0].source_binding={source_commit:row.commit,argv_sha256:argvSha256,
   attempt_binding_sha256:hash({source_commit:row.commit,argv_sha256:argvSha256,request_sha256:row.runtime_sources.attempts[0].request.sha256,catalog_sha256:catalogSha256})};
  seal(row);
 }
 return run;
}
test('新臂模型目录不含别名，映射独立保存在同一私有attempt中',()=>{
 const run=aliasedAuditRun(),row=run.records.find(item=>item.arm==='new');
 assert.ok(row.runtime_sources.attempts[0].catalog.entries.every(entry=>!('model_evidence_id'in entry)));
 assert.deepEqual(row.runtime_sources.attempts[0].model_alias_mapping.map(entry=>entry.model_evidence_id),['c1','c2','c3']);
 assert.deepEqual(row.runtime_sources.attempts[0].catalog.entries.map(entry=>entry.evidence_id),row.runtime_sources.attempts[0].model_alias_mapping.map(entry=>entry.evidence_id));
 assert.ok(row.runtime_sources.attempts[0].model_alias_mapping.every(entry=>/^[a-f0-9-]{36}$/.test(entry.evidence_id)));
 assert.equal(hash(row.runtime_sources.attempts[0].catalog),row.runtime_sources.attempts[0].catalog_sha256);
 const report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.records.find(item=>item.arm==='new'&&item.source_audit)?.source_audit.status,'verified');
});
function productionCapturedAuditRun(){
 const run=aliasedAuditRun(),row=run.records.find(item=>item.arm==='new'),attempt=row.runtime_sources.attempts[0],persistence=row.runtime_sources.persistence;
 const member=JSON.parse(datasetText).cases.find(item=>item.case_id===row.case_id);
 const collectorBinding=replyComparisonCollectorBinding(new URL('../..',import.meta.url).pathname,['--synthetic-production-capture',`--case=${row.case_id}`]);
 row.commit=collectorBinding.source_commit;
 const captured=captureReplyRuntimeSourceAttempt({member,body:structuredClone(attempt.request.body),
  request:{request_id:persistence.request_id,hash_kind:attempt.request.hash_kind,sha256:attempt.request.sha256,...attempt.request.raw_utf8!==undefined?{raw_utf8:attempt.request.raw_utf8}:{}},
  scope:structuredClone(row.scope),case_id:row.case_id,repeat:row.repeat,arm:row.arm,attempt_id:attempt.attempt_id,
  started_at:row.started_at,captured_at:attempt.catalog.captured_at,response_started_at:attempt.response_started_at,
  persisted_sources:structuredClone(persistence.snapshot),collector_binding:collectorBinding});
 row.runtime_sources.attempts[0]=captured.attempt;persistence.catalog_sha256=captured.catalog_sha256;seal(row);
 return {run,row,captured,collectorBinding};
}
test('生产采集器从实际请求与PG来源生成v2 catalog和独立mapping并交审计通过',()=>{
 const {run,row,captured,collectorBinding}=productionCapturedAuditRun();
 assert.equal(collectorBinding.source_commit,execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());
 assert.equal(collectorBinding.argv_sha256,hash(['--synthetic-production-capture',`--case=${row.case_id}`]));
 assert.deepEqual({source_commit:captured.attempt.source_binding.source_commit,argv_sha256:captured.attempt.source_binding.argv_sha256},collectorBinding);
 assert.ok(captured.catalog.entries.every(entry=>/^[a-f0-9-]{36}$/.test(entry.evidence_id)&&!('model_evidence_id'in entry)));
 assert.deepEqual(captured.model_alias_mapping.map(entry=>[entry.model_evidence_id,entry.evidence_id]),captured.catalog.entries.map((entry,index)=>[`c${index+1}`,entry.evidence_id]));
 const member=JSON.parse(datasetText).cases.find(item=>item.case_id===row.case_id);
 const sourceAudit=auditReplyRuntimeSources(member,{...row,terminal_status:'succeeded'},row.output,'reporter_fixture');
 assert.equal(sourceAudit.status,'verified',sourceAudit.reason);
 const wrongCommit=productionCapturedAuditRun();wrongCommit.row.runtime_sources.attempts[0].source_binding.source_commit='0'.repeat(40);
 wrongCommit.row.deterministic_checks.runtime_sources_sha256=hash(wrongCommit.row.runtime_sources);
 assert.throws(()=>auditReplyRuntimeSources(member,{...wrongCommit.row,terminal_status:'succeeded'},wrongCommit.row.output,'reporter_fixture'),/runtime_collector_source_binding/);
 const wrongArgv=productionCapturedAuditRun();wrongArgv.row.runtime_sources.attempts[0].source_binding.argv_sha256='not-a-digest';
 wrongArgv.row.deterministic_checks.runtime_sources_sha256=hash(wrongArgv.row.runtime_sources);
 assert.throws(()=>auditReplyRuntimeSources(member,{...wrongArgv.row,terminal_status:'succeeded'},wrongArgv.row.output,'reporter_fixture'),/runtime_collector_source_binding/);
 const wrongAttempt=productionCapturedAuditRun();wrongAttempt.row.runtime_sources.attempts[0].source_binding.attempt_binding_sha256='0'.repeat(64);
 wrongAttempt.row.deterministic_checks.runtime_sources_sha256=hash(wrongAttempt.row.runtime_sources);
 assert.throws(()=>auditReplyRuntimeSources(member,{...wrongAttempt.row,terminal_status:'succeeded'},wrongAttempt.row.output,'reporter_fixture'),/runtime_collector_source_binding/);
});
test('v2来源审计拒绝catalog别名、交换、复用和未授权映射，重签目录也不能放宽',()=>{
 const mutate=(change)=>{
  const run=aliasedAuditRun(),row=run.records.find(item=>item.arm==='new');
  rewritePayload(row,payload=>change(payload,row.runtime_sources.attempts[0]));
  seal(row);
  assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/reply_comparison_invalid:runtime_/);
 };
 mutate((payload,attempt)=>{attempt.catalog.entries[0].model_evidence_id='c1';});
 mutate((payload,attempt)=>{
  [payload.evidence[0].evidence_id,payload.evidence[1].evidence_id]=[payload.evidence[1].evidence_id,payload.evidence[0].evidence_id];
  payload.citation_policy.allowed_evidence_ids=payload.evidence.map(source=>source.evidence_id);
  [attempt.model_alias_mapping[0].model_evidence_id,attempt.model_alias_mapping[1].model_evidence_id]=[attempt.model_alias_mapping[1].model_evidence_id,attempt.model_alias_mapping[0].model_evidence_id];
 });
 mutate((payload,attempt)=>{
  payload.evidence[1].evidence_id=payload.evidence[0].evidence_id;
  payload.citation_policy.allowed_evidence_ids=payload.evidence.map(source=>source.evidence_id);
  attempt.model_alias_mapping[1].model_evidence_id=payload.evidence[1].evidence_id;
 });
 mutate((payload,attempt)=>{
  payload.evidence[0].evidence_id='c9';
  payload.citation_policy.allowed_evidence_ids=payload.evidence.map(source=>source.evidence_id);
  attempt.model_alias_mapping[0].model_evidence_id='c9';
 });
 mutate((_payload,attempt)=>{attempt.model_alias_mapping[0].evidence_id='f0000000-0000-4000-8000-000000000001';});
});
function attachReviews(row,bindSources=true){
 const subject={blind_id:row.blind_id,case_sha256:row.case_sha256,input_sha256:row.input_sha256,output:row.output,...bindSources?{runtime_sources_sha256:hash(row.runtime_sources),request_sha256:row.request_sha256}:{}};
 row.reviews=['auditor-one','auditor-two'].map((id,index)=>({review_id:row.blind_id+index,reviewer_id:id,reviewer_type:'human',reviewer_version:'synthetic-v1',independent:true,blinded:true,blind_id:row.blind_id,subject_sha256:hash(subject),candidates:row.output.candidates.map(candidate=>({candidate_id:candidate.candidate_id,basis:'仅合成审计器规则用例',scores:{evidence_correctness:2,intent_preservation:2,no_unsupported_content:2,relationship_fit:2,chinese_usability:2},severe_errors:{false_fact:0,wrong_person:0,unsupported_commitment:0}}))}));
}
test('运行目录与真实请求摘要进入审阅subject，过期输入输出审阅不能复用',()=>{
 const stale=syntheticAuditRun();attachReviews(stale.records[0],false);
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,stale),/review_binding/);
 const bound=syntheticAuditRun();bound.records.forEach(row=>attachReviews(row));
 assert.doesNotThrow(()=>buildReplyComparisonReport(manifestText,datasetText,bound));
});
test('确定性输出回执另绑定完整运行目录，缺摘要未定，坏摘要拒绝',()=>{
 const missing=syntheticAuditRun();delete missing.records[0].deterministic_checks.runtime_sources_sha256;
 const report=buildReplyComparisonReport(manifestText,datasetText,missing);
 assert.ok(report.unknowns.some(item=>item.reason==='runtime_deterministic_binding_unknown'));
 const bad=syntheticAuditRun();bad.records[0].deterministic_checks.runtime_sources_sha256='0'.repeat(64);
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,bad),/runtime_deterministic_binding/);
});
function seal(row){
 const evidence=row.runtime_sources;
 for(const attempt of evidence.attempts)attempt.catalog_sha256=hash(attempt.catalog);
 if(evidence.persistence){evidence.persistence.catalog_sha256=evidence.attempts[0].catalog_sha256;evidence.persistence.snapshot_sha256=hash(evidence.persistence.snapshot);evidence.persistence.output_sha256=hash(evidence.persistence.output);}
 row.deterministic_checks.runtime_sources_sha256=hash(evidence);
}
test('不同逻辑回复不得复用同一运行请求或同一物理采集标识',()=>{
 for(const reuse of ['request','attempt']){
  const run=syntheticAuditRun(),[first,second]=run.records;
  if(reuse==='request'){
   const id=first.runtime_sources.request_id;second.runtime_sources.request_id=id;second.runtime_sources.attempts[0].catalog.request_id=id;second.runtime_sources.persistence.request_id=id;
  }else second.runtime_sources.attempts[0].attempt_id=first.runtime_sources.attempts[0].attempt_id;
  seal(second);assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),new RegExp('runtime_'+reuse+'_reused'));
 }
});
function requestChanged(row){
 const request=row.runtime_sources.attempts[0].request;
 if(request.hash_kind==='wire_utf8_sha256')request.raw_utf8=JSON.stringify(request.body);
 request.sha256=hash(request.hash_kind==='wire_utf8_sha256'?request.raw_utf8:request.body);row.request_sha256=request.sha256;
 row.runtime_sources.attempts[0].catalog.request_sha256=request.sha256;seal(row);
}
function rewritePayload(row,change){
 const visit=value=>{
  if(Array.isArray(value))return value.map(visit);
  if(value&&typeof value==='object'){
   if(Array.isArray(value.evidence)&&value.fidelity_contract){change(value);return value;}
   return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item)]));
  }
  if(typeof value!=='string')return value;
  try{return JSON.stringify(visit(JSON.parse(value)));}catch{const a=value.indexOf('{'),b=value.lastIndexOf('}');if(a<0||b<=a)return value;try{return value.slice(0,a)+JSON.stringify(visit(JSON.parse(value.slice(a,b+1))))+value.slice(b+1);}catch{return value;}}
 };
 const request=row.runtime_sources.attempts[0].request;request.body=visit(request.body);requestChanged(row);
}
const badChanges=[
 ['case',row=>{row.runtime_sources.attempts[0].catalog.case_id='paired-accept';seal(row);},/runtime_catalog_case_id/],
 ['repeat',row=>{row.runtime_sources.attempts[0].catalog.repeat=2;seal(row);},/runtime_catalog_repeat/],
 ['arm',row=>{row.runtime_sources.attempts[0].catalog.arm='old';seal(row);},/runtime_catalog_arm/],
 ['scope',row=>{row.runtime_sources.attempts[0].catalog.scope={...row.scope,contact_id:'a0000000-0000-4000-8000-000000000099'};seal(row);},/runtime_catalog_scope/],
 ['text',row=>{row.runtime_sources.attempts[0].catalog.entries[1].text='未提供的事实';seal(row);},/runtime_catalog_entries/],
 ['request_hash',row=>{row.runtime_sources.attempts[0].request.sha256='a'.repeat(64);},/runtime_request_canonical_hash/],
 ['catalog_hash',row=>{row.runtime_sources.attempts[0].catalog_sha256='a'.repeat(64);},/runtime_catalog_hash/],
 ['PG',row=>{row.runtime_sources.persistence.snapshot[1].evidence_text='未提供的事实';seal(row);},/runtime_persistence_sources/],
 ['PG_scope',row=>{row.runtime_sources.persistence.snapshot[1].owner_id='a0000000-0000-4000-8000-000000000099';seal(row);},/runtime_persistence_sources/],
 ['capture_time',row=>{row.runtime_sources.attempts[0].catalog.captured_at=row.ended_at;seal(row);},/runtime_capture_response_order/],
 ['persist_time',row=>{row.runtime_sources.persistence.observed_at=row.started_at;seal(row);},/runtime_persistence_order/],
 ['catalog_missing',row=>{delete row.runtime_sources.attempts[0].catalog;},/runtime_catalog_hash/],
 ['strategy_citable',row=>{row.runtime_sources.attempts[0].catalog.strategy_fields.citable=true;seal(row);},/runtime_strategy_projection/],
 ['uncovered_input',row=>{row.runtime_sources.attempts[0].catalog.covered_input_fields.pop();seal(row);},/runtime_covered_input_fields/],
 ['oracle_key_outside_payload',row=>{row.runtime_sources.attempts[0].request.body.extra={forbidden_additions:['答应参加']};requestChanged(row);},/runtime_oracle_field_leak/],
 ['oracle_key_in_payload',row=>{rewritePayload(row,payload=>{payload.forbidden_additions=['答应参加'];});},/runtime_oracle_field_leak/],
 ['strategy_missing',row=>{rewritePayload(row,payload=>{payload.user_instruction='{}';});},/runtime_generation_input_projection/],
 ['wrong_source_role',row=>{rewritePayload(row,payload=>{payload.evidence[1].factual_role='confirmed_memory';});},/runtime_source_role_or_text/],
 ['upgraded_source_kind',row=>{rewritePayload(row,payload=>{payload.evidence[1].kind='confirmed_memory';});},/runtime_source_kind/],
 ['source_status',row=>{rewritePayload(row,payload=>{payload.evidence[1].status='active';});},/runtime_source_identity_or_status/],
 ['payload_policy',row=>{rewritePayload(row,payload=>{payload.citation_policy.allowed_evidence_ids.push('policy-fake-id');});},/runtime_payload_citation_policy/],
 ['multiple_payloads',row=>{const body=row.runtime_sources.attempts[0].request.body;body.extra=structuredClone(body);requestChanged(row);},/runtime_unique_payload/],
 ['candidate_PG',row=>{row.runtime_sources.persistence.output.candidates[0].text='另一个候选';seal(row);},/runtime_persistence_output_hash/],
];
for(const [name,mutate,reason]of badChanges)test('真实来源内部一致性拒绝篡改：'+name,()=>{
 const run=syntheticAuditRun();mutate(run.records[0]);assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),reason);
});
test('user_purpose保留真实payload引用资格；策略字段不得虚构引用ID',()=>{
 const valid=syntheticAuditRun(),row=valid.records[0];row.output.candidates[0].citation_ids=[row.runtime_sources.attempts[0].catalog.entries[0].evidence_id];
 row.runtime_sources.persistence.output=structuredClone(row.output);row.deterministic_checks.output_sha256=hash(row.output);seal(row);
 assert.doesNotThrow(()=>buildReplyComparisonReport(manifestText,datasetText,valid));
 const invalid=structuredClone(valid);invalid.records[0].output.candidates[0].citation_ids=['user_instruction'];invalid.records[0].runtime_sources.persistence.output=structuredClone(invalid.records[0].output);invalid.records[0].deterministic_checks.output_sha256=hash(invalid.records[0].output);seal(invalid.records[0]);
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,invalid),/runtime_citation_allowlist/);
});
test('多物理attempt保持未定和完整数量，不只信最后一次目录；缺PG声明也未定',()=>{
 const multi=syntheticAuditRun(),row=multi.records[0];row.physical_calls=2;row.runtime_sources.attempts.push(structuredClone(row.runtime_sources.attempts[0]));
 const report=buildReplyComparisonReport(manifestText,datasetText,multi);assert.equal(report.overall.status,'undetermined');
 const audited=report.records.find(item=>item.case_id===row.case_id&&item.arm===row.arm&&item.repeat===row.repeat);assert.equal(audited.source_audit.attempt_count,2);assert.equal(row.runtime_sources.attempts.length,2);
 assert.ok(report.unknowns.some(item=>item.reason==='runtime_multiple_attempts_unsupported'));
 const noPG=syntheticAuditRun();delete noPG.records[0].runtime_sources.persistence;
 assert.ok(buildReplyComparisonReport(manifestText,datasetText,noPG).unknowns.some(item=>item.reason==='runtime_persistence_missing'));
});
test('业务payload不能夹带未声明的评价文字，六字段以外的扩展需新合同',()=>{
 const run=syntheticAuditRun();rewritePayload(run.records[0],payload=>{payload.extra_instructions='答应参加';});
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/runtime_payload_fields/);
});
test('多attempt报告保留逐次观测摘要，不只留下计数或最后一条',()=>{
 const run=syntheticAuditRun(),row=run.records[0],second=structuredClone(row.runtime_sources.attempts[0]);
 second.attempt_id='a0000000-0000-4000-8000-000000000003';second.request.sha256='1'.repeat(64);row.runtime_sources.attempts.push(second);row.physical_calls=2;
 const report=buildReplyComparisonReport(manifestText,datasetText,run),audited=report.records.find(item=>item.arm===row.arm&&item.status==='succeeded');
 assert.deepEqual(audited.source_audit.attempt_observations.map(item=>[item.attempt_id,item.request_sha256]),row.runtime_sources.attempts.map(item=>[item.attempt_id,item.request.sha256]));
 assert.equal(audited.source_audit.status,'undetermined');
});
test('来源目录未定时审阅满分仍不能把该记录记为语义通过',()=>{
 const run=syntheticAuditRun();for(const row of run.records){delete row.runtime_sources;attachReviews(row,false);}run.evidence_kind='model_run';
 const report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.arms.old.passed,0);assert.equal(report.arms.new.passed,0);
 assert.equal(report.semantic_quality.status,'undetermined');
});
test('wire摘要绑定真实UTF8文字，canonical摘要只承诺JSON值，二者不能混称',()=>{
 const wire=syntheticAuditRun(),old=wire.records.find(row=>row.arm==='old');old.runtime_sources.attempts[0].request.raw_utf8+='\n';
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,wire),/runtime_request_wire_hash/);
 const body=syntheticAuditRun(),oldBody=body.records.find(row=>row.arm==='old');oldBody.runtime_sources.attempts[0].request.body.max_tokens++;
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,body),/runtime_request_wire_body/);
 const canonical=syntheticAuditRun(),newRow=canonical.records.find(row=>row.arm==='new'),request=newRow.runtime_sources.attempts[0].request;
 request.body=Object.fromEntries(Object.entries(request.body).reverse());
 assert.doesNotThrow(()=>buildReplyComparisonReport(manifestText,datasetText,canonical));
});
test('冻结case标识也是采集元资料，不得经SDK请求扩展字段出站',()=>{
 const run=syntheticAuditRun(),row=run.records[0];row.runtime_sources.attempts[0].request.body.case_id=row.case_id;requestChanged(row);
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/runtime_oracle_field_leak/);
});
test('真实model_run不得把四字段旧投影冒充完整生成输出',()=>{
 const run=syntheticAuditRun();run.evidence_kind='model_run';
 const report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.ok(report.unknowns.some(item=>item.reason==='runtime_complete_output_missing'));
 assert.equal(report.arms.old.passed,0);assert.equal(report.arms.new.passed,0);
});
function completeAuditRun(){
 const run=syntheticAuditRun();run.evidence_kind='model_run';
 for(const [index,row]of run.records.entries()){
  row.output=structuredClone(originalPilot.records[index].actual.result);
  const evidence=row.runtime_sources,persisted=evidence.persistence,ids=Object.fromEntries(['owner_id','contact_id','conversation_binding_id'].map(key=>[key,row.scope[key]]));
  persisted.output=structuredClone(row.output);
  persisted.candidate_snapshot=row.output.candidates.map(candidate=>({...structuredClone(candidate),...ids,reply_request_id:evidence.request_id}));
  persisted.request_snapshot={id:evidence.request_id,...ids,skill_id:null,skill_version_id:null,skill_name:null,skill_selection_method:null,skill_selection_reason:null,skill_load_state:null,skill_loaded_resources:null};
  row.deterministic_checks.output_sha256=hash(row.output);seal(row);
 }
 return run;
}
test('完整实际DTO可审计；risk_notes即使重签输出也必须核对原PG值',()=>{
 const valid=completeAuditRun();assert.doesNotThrow(()=>buildReplyComparisonReport(manifestText,datasetText,valid));
 const changed=completeAuditRun(),row=changed.records[0];row.output.candidates[0].risk_notes=['没有来源的新增承诺'];row.runtime_sources.persistence.output=structuredClone(row.output);row.deterministic_checks.output_sha256=hash(row.output);seal(row);
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,changed),/runtime_persistence_candidates/);
});
test('完整DTO的messages、Skill元数据和PG scope均受约束，旧完整审阅不能复用',()=>{
 for(const field of ['messages','skill','PGscope','PGrequest']){
  const run=completeAuditRun(),row=run.records[0];
  if(field==='messages')row.runtime_sources.persistence.candidate_snapshot[0].messages[0].text='被改写';
  if(field==='skill')row.runtime_sources.persistence.request_snapshot.skill_version_id='a0000000-0000-4000-8000-000000000098';
  if(field==='PGscope')row.runtime_sources.persistence.candidate_snapshot[0].contact_id='a0000000-0000-4000-8000-000000000098';
  if(field==='PGrequest')row.runtime_sources.persistence.request_snapshot.id='a0000000-0000-4000-8000-000000000098';
  seal(row);assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/runtime_persistence_(candidates|request_skill)/,field);
 }
 const changed=completeAuditRun(),row=changed.records[0];attachReviews(row);
 row.output.candidates[0].risk_notes=['新风险文字'];row.runtime_sources.persistence.candidate_snapshot[0].risk_notes=['新风险文字'];row.runtime_sources.persistence.output=structuredClone(row.output);row.deterministic_checks.output_sha256=hash(row.output);seal(row);
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,changed),/review_binding/);
});
test('真实runtime缺risk_notes或PG完整输出原值时未定，不能静默用空组补齐',()=>{
 for(const omit of ['risk_notes','messages','PGcandidate','PGrequest']){
  const run=completeAuditRun(),row=run.records[0];
  if(omit==='risk_notes'||omit==='messages')delete row.output.candidates[0][omit];
  if(omit==='PGcandidate')delete row.runtime_sources.persistence.candidate_snapshot;
  if(omit==='PGrequest')delete row.runtime_sources.persistence.request_snapshot;
  row.runtime_sources.persistence.output=structuredClone(row.output);row.deterministic_checks.output_sha256=hash(row.output);seal(row);
  const report=buildReplyComparisonReport(manifestText,datasetText,run);
  assert.equal(report.overall.status,'undetermined');assert.ok(report.unknowns.some(issue=>issue.reason.startsWith('runtime_complete_')),omit);
 }
});
test('严格runtime复用产品候选合同：空引用即使PG声明同步为空并重签也拒绝',()=>{
 const run=completeAuditRun(),row=run.records[0];row.output.candidates[0].citation_ids=[];row.runtime_sources.persistence.candidate_snapshot[0].citation_ids=[];row.runtime_sources.persistence.output=structuredClone(row.output);row.deterministic_checks.output_sha256=hash(row.output);seal(row);
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/runtime_complete_candidate_structure/);
});
for(const arm of ['old','new'])test('完整回执集合必须等于真实候选引用union，重签无关来源仍拒绝：'+arm,()=>{
 const run=completeAuditRun(),row=run.records.find(candidate=>candidate.arm===arm);
 row.output.context_receipt.evidence_ids=['00000000-0000-4000-8000-000000000000'];
 row.runtime_sources.persistence.output=structuredClone(row.output);row.deterministic_checks.output_sha256=hash(row.output);seal(row);
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/runtime_context_receipt_evidence/);
});
function signCompleteOutput(row){row.runtime_sources.persistence.output=structuredClone(row.output);row.deterministic_checks.output_sha256=hash(row.output);seal(row);}
test('完整回执按全组候选引用union核对，合法集合可换序且布尔失败flag可为true',()=>{
 const run=completeAuditRun(),row=run.records[0],sources=row.runtime_sources.attempts[0].catalog.entries.map(entry=>entry.evidence_id);
 row.output.candidates[0].citation_ids=[sources[1],sources[2]];
 const second=structuredClone(row.output.candidates[0]);second.candidate_id='a0000000-0000-4000-8000-000000000087';second.messages[0].message_id='a0000000-0000-4000-8000-000000000088';second.citation_ids=[sources[0],sources[1]];row.output.candidates.push(second);
 row.output.context_receipt.evidence_ids=[sources[2],sources[0],sources[1]];
 for(const key of ['layered_read_failed','owner_layered_read_failed','overview_read_failed'])row.output.context_receipt[key]=true;
 const ids=Object.fromEntries(['owner_id','contact_id','conversation_binding_id'].map(key=>[key,row.scope[key]]));
 row.runtime_sources.persistence.candidate_snapshot=row.output.candidates.map(candidate=>({...structuredClone(candidate),...ids,reply_request_id:row.runtime_sources.request_id}));signCompleteOutput(row);
 assert.doesNotThrow(()=>buildReplyComparisonReport(manifestText,datasetText,run));
 row.output.context_receipt.evidence_ids.pop();signCompleteOutput(row);
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/runtime_context_receipt_evidence/);
});
test('当前无表达偏好的payload不能在完整回执中凭空增加偏好ID或正文',()=>{
 for(const field of ['expression_preference_ids','expression_preferences']){
  const run=completeAuditRun(),row=run.records[0];
  row.output.context_receipt[field]=field==='expression_preference_ids'?['a0000000-0000-4000-8000-000000000089']:[{preference_id:'a0000000-0000-4000-8000-000000000089',text:'无来源的其他范围偏好',revision:1,scope:{contact_id:'a0000000-0000-4000-8000-000000000090',reply_mode:null}}];signCompleteOutput(row);
  assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/runtime_context_receipt_preferences/);
 }
});
test('完整回执失败flag必须是真实布尔类型，未知或字符串不得补成false',()=>{
 for(const key of ['layered_read_failed','owner_layered_read_failed','overview_read_failed'])for(const value of [null,0,'false',[]]){
  const run=completeAuditRun(),row=run.records[0];row.output.context_receipt[key]=value;signCompleteOutput(row);
  assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/runtime_context_receipt_flags/);
 }
});
for(const arm of ['old','new'])test('完整消息组内message_id必须唯一，重签正文及PG也不能复用标识：'+arm,()=>{
 const run=completeAuditRun(),row=run.records.find(candidate=>candidate.arm===arm),candidate=row.output.candidates[0],id=candidate.messages[0].message_id;
 candidate.messages=[{message_id:id,text:'第一条表达'},{message_id:id,text:'第二条表达'}];candidate.text='第一条表达\n\n第二条表达';
 const ids=Object.fromEntries(['owner_id','contact_id','conversation_binding_id'].map(key=>[key,row.scope[key]]));
 row.runtime_sources.persistence.candidate_snapshot=row.output.candidates.map(candidate=>({...structuredClone(candidate),...ids,reply_request_id:row.runtime_sources.request_id}));signCompleteOutput(row);
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/runtime_complete_message_identity/);
});
test('消息ID唯一约束只限组内，不凭空要求不同候选的消息ID全局唯一',()=>{
 const run=completeAuditRun(),row=run.records[0],second=structuredClone(row.output.candidates[0]);second.candidate_id='a0000000-0000-4000-8000-000000000091';row.output.candidates.push(second);
 const ids=Object.fromEntries(['owner_id','contact_id','conversation_binding_id'].map(key=>[key,row.scope[key]]));
 row.runtime_sources.persistence.candidate_snapshot=row.output.candidates.map(candidate=>({...structuredClone(candidate),...ids,reply_request_id:row.runtime_sources.request_id}));signCompleteOutput(row);
 assert.doesNotThrow(()=>buildReplyComparisonReport(manifestText,datasetText,run));
});
