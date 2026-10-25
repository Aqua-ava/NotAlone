import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const SOURCE=process.env.REPLY_OUTPUT_ARCHIVE??ROOT;
const policy=JSON.parse(await readFile(new URL('./execution-policy.json',import.meta.url),'utf8'));
const {buildReplyComparisonReport,createReplyComparisonPlan}=await import(pathToFileURL(process.env.REPLY_OUTPUT_SCORER_FILE??join(SOURCE,'backend-ts/src/reply-comparison.ts')));
const manifestText=await readFile(join(SOURCE,'backend-ts/test/fixtures/reply-comparison-material-manifest.json'),'utf8');
const datasetText=await readFile(join(SOURCE,'backend/tests/fixtures/fidelity/synthetic-v1.json'),'utf8');
const manifest=JSON.parse(manifestText),dataset=JSON.parse(datasetText);
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=v=>createHash('sha256').update(typeof v==='string'?v:canonical(v)).digest('hex');
const reportOptions={costWaiver:{status:policy.cost_status,scope_ref:policy.scope_ref,scope_sha256:policy.scope_sha256}};

// 沿用现有 reply-comparison.test.mjs 的报告器合成载体，绝非重新执行96次采集或模型评审。
function reporterFixture(){
 const configuration={provider:'synthetic-local',endpoint:'http://synthetic.invalid',request_model:'synthetic-model',temperature:0,top_p:1,reasoning:'off',max_output_tokens:393216,stop:[],timeout_ms:20000,max_retries:0,seed:102,prompt_hash:'a'.repeat(64),tool_schema_hash:'b'.repeat(64),environment_hash:'c'.repeat(64)};
 const run={schema_version:'reply-migration-run-v1',protocol_version:'migration-comparison-v1',evidence_kind:'reporter_fixture',synthetic_only:true,manifest_sha256:hash(manifestText),dataset_sha256:hash(datasetText),configuration,config_hash:hash(configuration),bindings:{old:{commit:manifest.baseline_commit,lock_hash:'d'.repeat(64),profile_hash:'e'.repeat(64)},new:{commit:'2'.repeat(40),lock_hash:'f'.repeat(64),profile_hash:'0'.repeat(64),dsh_commit:'687f282e8625c6b8d11ff58211a90524be2e4317'}},price_snapshot:{currency:'USD',sha256:'3'.repeat(64)},records:[]};
 const fields=['current_intent','available_facts','unknowns','allowed_changes','current_message','recent_context'];
 for(const [index,pair]of createReplyComparisonPlan(manifestText,datasetText).entries())for(const [offset,arm]of (pair.order==='AB'?['old','new']:['new','old']).entries()){
  const member=dataset.cases.find(c=>c.case_id===pair.case_id),input=Object.fromEntries(fields.filter(k=>k in member).map(k=>[k,member[k]])),start=Date.UTC(2026,9,24)+index*200+offset*100;
  const output={candidates:[{candidate_id:'candidate-1',text:'合成回复',basis:'报告器规则验证',citation_ids:[]}]};
  const row={...pair,arm,blind_id:'opaque-'+index+'-'+offset,case_sha256:hash(member),input_sha256:hash(input),config_hash:run.config_hash,commit:run.bindings[arm].commit,generated_by:'synthetic-generator',terminal_status:'succeeded',logical_calls:1,physical_calls:1,actual_model:'synthetic-model',model_fingerprint:'synthetic-version',started_at:new Date(start).toISOString(),ended_at:new Date(start+100).toISOString(),latency_ms:100,usage:{input_tokens:10,output_tokens:2,reasoning_tokens:0,cache_hit_tokens:0,cache_miss_tokens:10},cost:{amount:arm==='old'?0.01:0.02,currency:'USD',price_snapshot_sha256:run.price_snapshot.sha256},request_sha256:'4'.repeat(64),output,deterministic_checks:{status:'passed',source_binding_sha256:hash(input),output_sha256:hash(output)}};
  row.timing={schema_version:'reply-latency-v1',clock:'monotonic',observed_ms:100,first_event_ms:20,first_token_ms:30,final_persisted_result_ms:100,phases:{queue:{started_ms:0,ended_ms:10},retrieval:{started_ms:10,ended_ms:20},network_model:{started_ms:20,ended_ms:80},validation:{started_ms:80,ended_ms:90},persistence:{started_ms:90,ended_ms:100}}};
  const subject=hash({blind_id:row.blind_id,case_sha256:row.case_sha256,input_sha256:row.input_sha256,output});
  row.reviews=[1,2].map(i=>({review_id:row.blind_id+'-'+i,blind_id:row.blind_id,subject_sha256:subject,reviewer_id:'synthetic-reviewer-'+i,reviewer_type:'agent',reviewer_model:'synthetic-review-model',reviewer_version:'fixture-v1',independent:true,blinded:true,candidates:[{candidate_id:'candidate-1',scores:Object.fromEntries(['evidence_correctness','intent_preservation','no_unsupported_content','relationship_fit','chinese_usability'].map(k=>[k,2])),severe_errors:{false_fact:0,wrong_person:0,unsupported_commitment:0},basis:'报告器合成标注，不是独立模型评审。'}]}));
  run.records.push(row);
 }
 return run;
}

test('费用豁免仅跳过本轮费用门槛，测量和历史默认完整保留',()=>{
 const run=reporterFixture(),before=structuredClone(run);
 const historical=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(historical.metrics.cost.status,'failed');assert.equal(historical.overall.status,'failed');
 const report=buildReplyComparisonReport(manifestText,datasetText,run,reportOptions);
 assert.equal(report.cost_status,'waived_by_user');assert.equal(report.overall.status,'passed');
 assert.equal(report.metrics.cost.status,'failed');assert.equal(report.metrics.cost.interval.estimate,2);
 assert.ok(Math.abs(report.metrics.cost.totals.old.total-0.48)<1e-12);assert.ok(Math.abs(report.metrics.cost.totals.new.total-0.96)<1e-12);
 assert.deepEqual(run,before);assert.equal(report.population.planned,96);assert.equal(report.production_switch_approved,false);
});

test('费用缺失保持unknown，质量、来源、失败率、延迟和配置unknown仍不通过',()=>{
 const run=reporterFixture();for(const row of run.records)row.cost=null;run.price_snapshot=null;
 const missing=buildReplyComparisonReport(manifestText,datasetText,run,reportOptions);
 assert.equal(missing.cost_status,'waived_by_user');assert.equal(missing.overall.status,'passed');
 assert.equal(missing.metrics.cost.status,'undetermined');assert.equal(missing.metrics.cost.totals.old.total,null);
 assert.equal(missing.metrics.cost.totals.new.total,null);assert.equal(missing.metrics.cost.totals.new.known,0);
 assert.ok(missing.records.every(row=>row.cost===null));assert.equal(missing.unknowns.filter(item=>item.reason==='cost_unknown').length,96);
 assert.ok(missing.unknowns.filter(item=>['cost_unknown','price_snapshot_unknown'].includes(item.reason)).every(item=>item.blocking===false));
 for(const change of [
  value=>{value.records.find(row=>row.arm==='new').deterministic_checks.status='failed';},
  value=>{value.records[0].deterministic_checks.source_binding_sha256=null;},
  value=>{value.records[0].timing=null;value.records[0].latency_ms=null;},
  value=>{value.configuration.prompt_hash=null;value.config_hash=hash(value.configuration);for(const row of value.records)row.config_hash=value.config_hash;},
  value=>{const row=value.records.find(row=>row.arm==='new');row.terminal_status='failed';row.output=null;row.reviews=[];row.timing.final_persisted_result_ms=null;},
  value=>{value.records.pop();},
 ]){
  const changed=reporterFixture();change(changed);
  const report=buildReplyComparisonReport(manifestText,datasetText,changed,reportOptions);
  assert.notEqual(report.overall.status,'passed');assert.equal(report.population.planned,96);
 }
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,reporterFixture(),{costWaiver:{...reportOptions.costWaiver,status:'passed'}}),/cost_waiver/);
});

test('本轮一对实际双臂wire使用同一输出配置，保留来源与五阶段', {timeout:60000},async()=>{
 assert.ok(process.env.REPLY_OUTPUT_ARCHIVE,'测试必须使用固定archive，不能运行共享源码树');
 const {collectLocal}=await import(pathToFileURL(join(SOURCE,'.scratch/dsh-ts-migration/ticket25-final-run/runner.mjs')));
 const capture=await collectLocal({sourceCommit:process.env.REPLY_OUTPUT_SOURCE_COMMIT,localOnly:true,executionPolicy:policy,caseId:'paired-decline'});
 assert.equal(capture.received,2);
 for(const row of capture.records){
  assert.equal(row.actual.status,'succeeded',row.actual.error);assert.equal(row.physical_calls,1);
  assert.equal(row.source_audit.status,'verified');assert.ok(row.timing);assert.equal(Object.keys(row.timing.phases).length,5);
  assert.equal(row.physical_attempts[0].request.max_tokens,393216);
  assert.equal(JSON.parse(row.physical_attempts[0].raw_utf8).max_tokens,393216);
 }
 assert.equal(capture.execution_policy.controls.max_output_tokens,393216);
 assert.equal(capture.execution_policy.cost_status,'waived_by_user');assert.equal(capture.planned,96);
 assert.equal(capture.problem_budget.external_execution_enabled,false);
 if(process.env.REPLY_OUTPUT_RAW_DIR)await writeFile(join(process.env.REPLY_OUTPUT_RAW_DIR,'pair-capture.json'),JSON.stringify(capture)+'\n',{flag:'wx',mode:0o600});
});

test('本轮normalizer绑定逐臂实际wire，冻结guard同值且ACK不重复预留',async()=>{
 const raw=process.env.REPLY_OUTPUT_RAW_DIR;assert.ok(raw);
 const capture=JSON.parse(await readFile(join(raw,'pair-capture.json'),'utf8'));
 const {verifyExecutionPolicyBinding,captureEvaluationRuntime,freezeEvaluationRuntime,verifyEvaluationRuntime}=await import(pathToFileURL(join(SOURCE,'.scratch/dsh-ts-migration/ticket25-final-run/execution-snapshot.mjs')));
 assert.doesNotThrow(()=>verifyExecutionPolicyBinding(capture,policy));
 assert.throws(()=>verifyExecutionPolicyBinding(capture),/explicit_execution_policy_required/);
 for(const arm of ['old','new']){
  const changed=structuredClone(capture),attempt=changed.records.find(row=>row.arm===arm).runtime_sources.attempts[0];
  attempt.request.body.max_tokens=4096;attempt.request.raw_utf8=JSON.stringify(attempt.request.body);attempt.request.sha256=hash(attempt.request.raw_utf8);
  assert.throws(()=>verifyExecutionPolicyBinding(changed,policy),/execution_control_wire_output/);
 }
 const policyChanged=structuredClone(capture);policyChanged.execution_policy.controls.max_output_tokens=4096;
 assert.throws(()=>verifyExecutionPolicyBinding(policyChanged,policy),/capture_execution_policy_mismatch/);
 const controlsChanged=structuredClone(capture);controlsChanged.source_bindings.old_profile.controls.max_output_tokens=4096;
 assert.throws(()=>verifyExecutionPolicyBinding(controlsChanged,policy),/legacy_execution_controls_mismatch/);
 const runtime=await captureEvaluationRuntime({collectorRoot:join(SOURCE,'.scratch/dsh-ts-migration/ticket25-final-run'),moduleRoot:join(SOURCE,'backend/src'),executionPolicy:policy});
 const originalPrimary=JSON.parse(await readFile(join(SOURCE,'.scratch/dsh-ts-migration/ticket25-final-run/primary.json'),'utf8')),frozenPrimary=JSON.parse(runtime.bytes.get('collector/primary.json'));
 assert.equal(originalPrimary.controls.max_output_tokens,4096);assert.equal(frozenPrimary.controls.max_output_tokens,393216);
 delete originalPrimary.controls;delete frozenPrimary.controls;assert.deepEqual(frozenPrimary,originalPrimary,'材料、来源及oracle不得因输出策略改变');
 const frozen=await mkdtemp(join(raw,'frozen-guard-'));await freezeEvaluationRuntime(runtime,frozen);
 const vendor=await import(pathToFileURL(join(frozen,'collector/vendor-forward.mjs')));
 for(const row of capture.records){const call=row.physical_attempts[0];assert.match(vendor.validateRequest({arm:row.arm,path:row.arm==='old'?'/python/chat/completions':'/anthropic/v1/messages',raw:call.raw_utf8,body:call.request}),/^https:\/\/api\.deepseek\.com\//);}
 let used=10,sent=0,acks=0;
 const receipt=()=>({schema_version:'reply-budget-bridge-v1',action:'ack',reserved:false,used_reservations:used,max_reservations:1000,deadline:Date.now()/1000+3600});
 const initial=receipt();const forwarder=vendor.createVendorForwarder({key:'synthetic-unused',initialReceipt:initial,priceSnapshot:null,acknowledge:async()=>{acks++;return {...initial,used_reservations:used};},send:async()=>{sent++;throw Error('vendor_upstream_failed');}});
 const row=capture.records.find(row=>row.arm==='new'),call=row.physical_attempts[0],input={arm:'new',path:'/anthropic/v1/messages',raw:call.raw_utf8,body:call.request,res:{},call:{}};
 used++;await assert.rejects(forwarder.forward(input),/vendor_upstream_failed/);
 assert.equal(sent,1);assert.equal(acks,1);assert.equal(used,11);assert.equal(forwarder.summary().automatic_retries,0);
 assert.equal(forwarder.summary().actual_usage_cost_usd,null);assert.equal(forwarder.summary().new_reservations_acknowledged,1);
 await assert.rejects(forwarder.forward({...input,call:{}}),/vendor_fresh_reservation_required/);
 assert.equal(sent,1);assert.equal(used,11);assert.equal(acks,2);forwarder.close('synthetic_test_finished');
 // 缺价格的真实relay解析路径仍保存usage并明确cost=null，不把缺失价格写成0。
 const response=new EventEmitter();response.writableFinished=false;response.setHeader=()=>{};response.write=()=>{};response.end=()=>{response.writableFinished=true;};
 const transportCall={arm:'new'};
 const requestImpl=(_target,_options,callback)=>{
  const request=new EventEmitter();request.destroy=error=>request.emit('error',error);request.end=()=>queueMicrotask(()=>{
   const incoming=new EventEmitter();incoming.statusCode=200;incoming.headers={'content-type':'text/event-stream'};callback(incoming);
   const events=[{type:'message_start',message:{model:'deepseek-flash',usage:{input_tokens:10,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},{type:'message_delta',usage:{output_tokens:2}},{type:'message_stop'}];
   incoming.emit('data',Buffer.from(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')));incoming.emit('end');
  });return request;
 };
 await vendor.relayOfficial({target:'https://api.deepseek.com/anthropic/v1/messages',raw:call.raw_utf8,key:'synthetic-unused',res:response,call:transportCall,priceSnapshot:null,requestImpl});
 assert.equal(transportCall.cost,null);assert.equal(transportCall.usage.input_tokens,10);assert.equal(transportCall.usage.output_tokens,2);
 assert.equal(transportCall.response_complete,true);
 await verifyEvaluationRuntime(runtime,frozen);
 await writeFile(join(raw,'evaluation-adaptations-'+randomUUID()+'.json'),JSON.stringify({original_files:runtime.original_files,executed_files:runtime.files,adaptations:runtime.control_adaptations},null,2)+'\n',{flag:'wx',mode:0o600});
});

test('实际normalizer先核两臂wire，最小pair不能冒充固定96',async()=>{
 const raw=process.env.REPLY_OUTPUT_RAW_DIR,capture=JSON.parse(await readFile(join(raw,'pair-capture.json'),'utf8'));
 const temp=await mkdtemp(join(raw,'normalize-')),input=join(temp,'capture.json');
 for(const name of ['visible.json','binding.json','config.json','review1.json','review2.json'])await writeFile(join(temp,name),'{}',{mode:0o600});
 const args=[join(SOURCE,'.scratch/dsh-ts-migration/ticket25-final-run/normalize.mjs'),'--mode','local-only','--source-commit',process.env.REPLY_OUTPUT_SOURCE_COMMIT,'--execution-policy',fileURLToPath(new URL('./execution-policy.json',import.meta.url)),'--capture',input,'--dataset',join(SOURCE,'backend/tests/fixtures/fidelity/synthetic-v1.json'),'--visible',join(temp,'visible.json'),'--binding',join(temp,'binding.json'),'--config',join(temp,'config.json'),'--review',join(temp,'review1.json'),'--review',join(temp,'review2.json'),'--output',join(temp,'run.json'),'--summary-output',join(temp,'summary.json')];
 await writeFile(input,JSON.stringify(capture),{mode:0o600});
 let result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:5000});assert.equal(result.status,1);assert.match(result.stderr,/capture_contract/);
 for(const arm of ['old','new']){
  const changed=structuredClone(capture),attempt=changed.records.find(row=>row.arm===arm).runtime_sources.attempts[0];
  attempt.request.body.max_tokens=4096;attempt.request.raw_utf8=JSON.stringify(attempt.request.body);attempt.request.sha256=hash(attempt.request.raw_utf8);
  await writeFile(input,JSON.stringify(changed),{mode:0o600});result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);assert.match(result.stderr,/execution_control_wire_output/);
 }
});

test('显式报告入口绑定规范化policy并保留费用比，不覆盖历史输入',async()=>{
 const {reportCurrent}=await import('./report-current.mjs'),raw=process.env.REPLY_OUTPUT_RAW_DIR;
 const directory=await mkdtemp(join(raw,'report-')),run=reporterFixture(),policySha=hash(policy);
 run.execution_policy=policy;run.execution_policy_sha256=policySha;run.configuration.execution_policy_sha256=policySha;
 run.config_hash=hash(run.configuration);for(const row of run.records)row.config_hash=run.config_hash;
 const runFile=join(directory,'run.json'),bytes=JSON.stringify(run);await writeFile(runFile,bytes,{mode:0o600});
 const options={manifest:join(SOURCE,'backend-ts/test/fixtures/reply-comparison-material-manifest.json'),dataset:join(SOURCE,'backend/tests/fixtures/fidelity/synthetic-v1.json'),run:runFile,executionPolicy:fileURLToPath(new URL('./execution-policy.json',import.meta.url)),output:join(directory,'report.json')};
 const report=await reportCurrent(options);assert.equal(report.cost_status,'waived_by_user');assert.equal(report.metrics.cost.interval.estimate,2);assert.equal(report.overall.status,'passed');
 assert.equal(await readFile(runFile,'utf8'),bytes);await assert.rejects(reportCurrent({...options,output:runFile}),/report_overwrites_input/);
 run.configuration.max_output_tokens=4096;await writeFile(runFile,JSON.stringify(run),{mode:0o600});
 await assert.rejects(reportCurrent({...options,output:join(directory,'rejected.json')}),/normalized_output_control_binding/);
});

test('缺完整pin、既有预算或显式策略绑定时先失败，不生成请求',async()=>{
 const {runFixed96}=await import(pathToFileURL(join(SOURCE,'.scratch/dsh-ts-migration/ticket25-final-run/run-full.mjs')));
 await assert.rejects(runFixed96({sourceCommit:undefined,output:'/tmp/unused-output-cost-test'}),/完整源码commit必填/);
 await assert.rejects(runFixed96({sourceCommit:process.env.REPLY_OUTPUT_SOURCE_COMMIT,output:'/tmp/unused-output-cost-test'}),/既有私有预算配置/);
 const {collectLocal}=await import(pathToFileURL(join(SOURCE,'.scratch/dsh-ts-migration/ticket25-final-run/runner.mjs')));
 await assert.rejects(collectLocal({localOnly:true,executionPolicy:policy}),/explicit_source_commit_required/);
 await assert.rejects(collectLocal({sourceCommit:process.env.REPLY_OUTPUT_SOURCE_COMMIT,localOnly:true,vendorForward:()=>{}}),/local_provider_boundary_invalid/);
});

test('官方DSH故障在新输出配置下仍只实际尝试一次并保留失败', {timeout:60000},async()=>{
 const {collectLocal}=await import(pathToFileURL(join(SOURCE,'.scratch/dsh-ts-migration/ticket25-final-run/runner.mjs')));
 const capture=await collectLocal({sourceCommit:process.env.REPLY_OUTPUT_SOURCE_COMMIT,localOnly:true,executionPolicy:policy,caseId:'paired-decline',localFaults:{new:'provider_failure'}});
 const row=capture.records.find(row=>row.arm==='new');assert.equal(row.actual.status,'failed');assert.equal(row.physical_calls,1);
 assert.equal(row.physical_attempts[0].request.max_tokens,393216);assert.equal(row.output,null);assert.equal(row.source_storage_receipt,null);
 assert.equal(row.source_audit.status,'undetermined');assert.equal(row.usage,null);assert.equal(row.cost,null);assert.equal(capture.planned,96);
 assert.equal(capture.records.find(row=>row.arm==='old').actual.status,'succeeded');
 await writeFile(join(process.env.REPLY_OUTPUT_RAW_DIR,'failure-pair.json'),JSON.stringify(capture)+'\n',{flag:'wx',mode:0o600});
});
