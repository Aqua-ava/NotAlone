// 仅补审小差异：复用旧合成 fixture 作为输入，独立检查豁免边界与冻结 wire。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const state=JSON.parse(await readFile(process.env.SPEC_FINAL_STATE,'utf8'));
const a=state.archive,own=new URL('./',import.meta.url);
const at=p=>import(pathToFileURL(resolve(a,p)));
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const sha=v=>createHash('sha256').update(v).digest('hex');
const {freezeExecutionPolicy,verifyExecutionPolicyBinding,captureEvaluationRuntime}=await at('.scratch/dsh-ts-migration/ticket25-final-run/execution-snapshot.mjs');
const {buildReplyComparisonReport,createReplyComparisonPlan}=await at('backend-ts/src/reply-comparison.ts');
const collector=resolve(a,'.scratch/dsh-ts-migration/ticket25-final-run');
const primary=await readFile(resolve(collector,'primary.json'));
const policy=JSON.parse(await readFile(resolve(a,'.scratch/dsh-ts-migration/reply-output-cost-update/execution-policy.json'),'utf8'));
const results=[];

test('显式策略绑定真实范围和原 primary；仅适配输出，不改冻结材料/默认 4096',async()=>{
  assert.equal(sha(await readFile(resolve(a,'.scratch/dsh-ts-migration/acceptance-scope-update.md'))),policy.scope_sha256);
  assert.equal(sha(primary),policy.primary_sha256);
  const old=await captureEvaluationRuntime({collectorRoot:collector,moduleRoot:resolve(a,'backend/src')});
  const current=await captureEvaluationRuntime({collectorRoot:collector,moduleRoot:resolve(a,'backend/src'),executionPolicy:policy});
  assert.equal(JSON.parse(old.bytes.get('collector/primary.json')).controls.max_output_tokens,4096);
  assert.equal(JSON.parse(current.bytes.get('collector/primary.json')).controls.max_output_tokens,393216);
  assert.deepEqual(old.original_files,current.original_files);
  assert.deepEqual(current.control_adaptations.map(x=>x.path).sort(),['collector/old-arm.py','collector/primary.json','collector/vendor-forward.mjs']);
  for(const update of [{...policy,automatic_retries:1},{...policy,controls:{...policy.controls,temperature:0.1}},{...policy,controls:{...policy.controls,max_output_tokens:393217}}])
    assert.throws(()=>freezeExecutionPolicy(update,primary));
  results.push({name:'execution_policy_freeze',passed:true,legacy_output:4096,explicit_output:393216,immutable_materials:true});
});

test('双臂实际 wire 绑定：单改任一输出、丢失请求哈希或伪造零调用都拒绝',()=>{
  const request=()=>{const body={model:'deepseek-flash',max_tokens:393216,temperature:0,top_p:1,thinking:{type:'disabled'},stream:true};const raw_utf8=JSON.stringify(body);return {body,raw_utf8,hash_kind:'wire_utf8_sha256',sha256:sha(raw_utf8)};};
  const capture={execution_policy:structuredClone(policy),execution_policy_sha256:sha(canonical(policy)),source_bindings:{old_profile:{controls:structuredClone(policy.controls)}},records:['old','new'].map(arm=>({arm,physical_calls:1,runtime_sources:{attempts:[{request:request()}]}}))};
  verifyExecutionPolicyBinding(capture,policy);
  for(const mutate of [
    x=>{const r=x.records[1].runtime_sources.attempts[0].request;r.body.max_tokens=4096;r.raw_utf8=JSON.stringify(r.body);r.sha256=sha(r.raw_utf8);},
    x=>{delete x.records[0].runtime_sources.attempts[0].request.sha256;},
    x=>{x.records[1].physical_calls=0;},
  ]){const altered=structuredClone(capture);mutate(altered);assert.throws(()=>verifyExecutionPolicyBinding(altered,policy));}
  results.push({name:'wire_binding_counterexamples',passed:true,negative_cases:3});
});

test('费用高/未知仍照记；新增严重假事、usage unknown 与缺记录不得借豁免通过',async()=>{
  const manifestText=await readFile(resolve(a,'backend-ts/test/fixtures/reply-comparison-material-manifest.json'),'utf8');
  const datasetText=await readFile(resolve(a,'backend/tests/fixtures/fidelity/synthetic-v1.json'),'utf8');
  // 只读取既有 fixture 定义，不执行该文件的测试或任何采集入口。
  const source=await readFile(resolve(a,'backend-ts/test/reply-comparison.test.mjs'),'utf8');
  const prefix=source.slice(source.indexOf('const canonical='),source.indexOf("test('完整16例"));
  const fixture=new Function('createHash','createReplyComparisonPlan','manifestText','datasetText','manifest','dataset',prefix+'\nreturn fixture;')(
    createHash,createReplyComparisonPlan,manifestText,datasetText,JSON.parse(manifestText),JSON.parse(datasetText));
  const opts={costWaiver:{status:'waived_by_user',scope_ref:policy.scope_ref,scope_sha256:policy.scope_sha256}};
  const run=fixture();for(const row of run.records)if(row.arm==='new')row.cost.amount=100;
  const before=structuredClone(run);
  assert.equal(buildReplyComparisonReport(manifestText,datasetText,run).overall.status,'failed');
  const waived=buildReplyComparisonReport(manifestText,datasetText,run,opts);
  assert.equal(waived.overall.status,'passed');assert.equal(waived.metrics.cost.status,'failed');
  assert.deepEqual(run,before);
  for(const mutate of [
    x=>{const r=x.records.find(y=>y.arm==='new');for(const review of r.reviews){review.candidates[0].severe_errors.false_fact=1;review.candidates[0].scores.no_unsupported_content=0;}},
    x=>{x.records[0].usage=null;},
    x=>{x.records.splice(0,1);},
  ]){const altered=fixture();mutate(altered);const report=buildReplyComparisonReport(manifestText,datasetText,altered,opts);assert.notEqual(report.overall.status,'passed');assert.equal(report.population.planned,96);assert.equal(report.arms.old.denominator,48);assert.equal(report.arms.new.denominator,48);}
  const missing=fixture();missing.price_snapshot=null;for(const row of missing.records)row.cost=null;
  const unknown=buildReplyComparisonReport(manifestText,datasetText,missing,opts);
  assert.equal(unknown.overall.status,'passed');assert.equal(unknown.metrics.cost.status,'undetermined');
  assert.equal(unknown.records.length,96);assert.ok(unknown.records.every(row=>row.cost===null));
  assert.equal(unknown.real_model_quality_verified,false);assert.equal(unknown.production_switch_approved,false);
  results.push({name:'cost_waiver_boundary',passed:true,negative_cases:3,fixed_population:96,per_arm_denominator:48,quality_approval:false});
});

test('非回复工程执行器没有根端口就不能越过正式资格',async()=>{
  const {FormalExecutor}=await at('.scratch/dsh-ts-migration/nonreply-formal-model-seam/formal-executor.mjs');
  await assert.rejects(new FormalExecutor().preflight({qualityMode:'formal'}),/root_permission_required/);
  results.push({name:'no_default_formal_ports',passed:true});
});

test.after(async()=>{await writeFile(new URL('probe-results.json',own),JSON.stringify({candidate:state.pin,base:state.base,results,real_model_calls:0,app_runs:0},null,2)+'\n');});
