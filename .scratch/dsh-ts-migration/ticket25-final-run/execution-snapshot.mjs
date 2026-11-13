/** 固定评估脚本与唯一问题总账源码；不实现另一套预算。 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {join,dirname,isAbsolute} from 'node:path';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const scriptNames=['runner.mjs','old-arm.py','source-snapshot.mjs','observe-plugin.mjs','complete-output.mjs','bridge.mjs','bridge.py','execution-snapshot.mjs','primary.json','dependencies.mjs','local-provider.mjs','vendor-forward.mjs','legacy-system.json','run-full.mjs'];
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';

/** 只允许显式本轮策略改变输出控制；冻结材料、重试和原始primary不变。 */
export function freezeExecutionPolicy(value,primaryBytes){
 if(value===undefined)return undefined;
 const keys='automatic_retries,capacity,controls,cost_status,output_status,primary_sha256,schema_version,scope_ref,scope_sha256';
 assert.ok(value&&typeof value==='object'&&Object.keys(value).sort().join(',')===keys,'execution_policy_shape');
 assert.equal(value.schema_version,'reply-comparison-execution-policy-v1','execution_policy_schema');
 assert.equal(value.primary_sha256,sha(primaryBytes),'execution_policy_primary_binding');
 assert.equal(value.cost_status,'waived_by_user','execution_policy_cost_status');
 assert.equal(value.output_status,'waived_by_user','execution_policy_output_status');
 assert.equal(value.automatic_retries,0,'execution_policy_retry');
 assert.ok(typeof value.scope_ref==='string'&&value.scope_ref.trim()&&/^[a-f0-9]{64}$/.test(value.scope_sha256),'execution_policy_scope');
 const capacity=value.capacity;
 assert.ok(capacity&&Object.keys(capacity).sort().join(',')==='checked_on,context_window_tokens,max_output_tokens,model,safety_margin_tokens,source_url','execution_policy_capacity');
 // 官方模型目录于2026-10-25核实；不得把上下文容量当输出容量。
 assert.equal(capacity.model,'deepseek-flash');assert.equal(capacity.max_output_tokens,393216);
 assert.equal(capacity.context_window_tokens,1048576);assert.equal(capacity.safety_margin_tokens,65536);
 assert.equal(capacity.source_url,'https://api-docs.deepseek.com/api/list-models/');assert.equal(capacity.checked_on,'2026-10-25');
 const controls=value.controls,original=JSON.parse(primaryBytes).controls;
 assert.ok(controls&&Number.isSafeInteger(controls.max_output_tokens)&&controls.max_output_tokens>0&&controls.max_output_tokens<=capacity.max_output_tokens,'execution_policy_output_cap');
 assert.equal(canonical({...controls,max_output_tokens:original.max_output_tokens}),canonical(original),'execution_policy_non_output_controls');
 return freeze(structuredClone(value));
}

/** 绑定实际wire，不能仅凭policy或变量声称两臂参数相等。 */
export function verifyExecutionPolicyBinding(capture,policy){
 if(!policy){assert.equal(capture.execution_policy,undefined,'explicit_execution_policy_required');return;}
 assert.equal(canonical(capture.execution_policy),canonical(policy),'capture_execution_policy_mismatch');
 assert.equal(capture.execution_policy_sha256,sha(canonical(policy)),'capture_execution_policy_digest');
 assert.equal(canonical(capture.source_bindings?.old_profile?.controls),canonical(policy.controls),'legacy_execution_controls_mismatch');
 for(const row of capture.records){
  assert.ok(['old','new'].includes(row.arm),'execution_control_arm');
  const attempts=row.runtime_sources?.attempts;
  assert.ok(Array.isArray(attempts)&&attempts.length===row.physical_calls,'execution_control_attempt_count');
  for(const attempt of attempts){
   const request=attempt.request;
   assert.equal(request?.hash_kind,'wire_utf8_sha256','execution_control_wire_required');
   assert.equal(sha(request.raw_utf8),request.sha256,'execution_control_wire_hash');
   const body=JSON.parse(request.raw_utf8);
   assert.equal(canonical(body),canonical(request.body),'execution_control_wire_body');
   assert.equal(body.max_tokens,policy.controls.max_output_tokens,'execution_control_wire_output');
   assert.equal(body.model,policy.controls.model,'execution_control_wire_model');
   assert.equal(body.temperature,policy.controls.temperature,'execution_control_wire_temperature');
   assert.equal(body.top_p??1,policy.controls.top_p,'execution_control_wire_top_p');
   assert.equal(canonical(body.thinking),'{"type":"disabled"}','execution_control_wire_thinking');
   assert.equal(body.stream,true,'execution_control_wire_stream');
  }
 }
}

export function freezeProblemBudgetConfiguration(value,expected){
 if(!value||Object.keys(value).sort().join(',')!=='budget,moduleRoot,python,repositoryRoot'||!['python','moduleRoot','repositoryRoot'].every(key=>value[key]===expected[key])||!value.budget||Object.keys(value.budget).sort().join(',')!=='ledger,problem_id,round'||!['ledger','round','problem_id'].every(key=>typeof value.budget[key]==='string'&&value.budget[key].trim()===value.budget[key]&&value.budget[key])||!isAbsolute(value.budget.ledger))throw Error('budget_configuration_required');
 return freeze(structuredClone(value));
}

export async function captureEvaluationRuntime({collectorRoot,moduleRoot,executionPolicy}){
 const entries=await Promise.all([
  ...scriptNames.map(async name=>['collector/'+name,await readFile(join(collectorRoot,name))]),
  ...['__init__.py','problem_budget.py'].map(async name=>['budget-modules/notalone/'+name,await readFile(join(moduleRoot,'notalone',name))]),
 ]);
 const bytes=new Map(entries),originalFiles=Object.fromEntries(entries.map(([name,value])=>[name,sha(value)]));
 const policy=freezeExecutionPolicy(executionPolicy,bytes.get('collector/primary.json'));
 const adaptations=[];
 if(policy){
  const primary=JSON.parse(bytes.get('collector/primary.json'));primary.controls=policy.controls;
  bytes.set('collector/primary.json',Buffer.from(JSON.stringify(primary,null,2)+'\n'));
  const replace=(name,from,to)=>{const source=bytes.get(name).toString('utf8');assert.equal(source.split(from).length,2,'execution_control_seam_changed:'+name);bytes.set(name,Buffer.from(source.replace(from,to)));};
  replace('collector/vendor-forward.mjs','body.max_tokens!==4096','body.max_tokens!==primary.controls.max_output_tokens');
  const priceGuard=" if(!priceSnapshot||!Number.isFinite(priceSnapshot.cache_hit_usd_per_million)||!Number.isFinite(priceSnapshot.cache_miss_usd_per_million)||!Number.isFinite(priceSnapshot.output_usd_per_million)||priceSnapshot.currency!=='USD'||!/^[a-f0-9]{64}$/.test(priceSnapshot.sha256))fail('vendor_price_snapshot');";
  replace('collector/vendor-forward.mjs',priceGuard,' if(priceSnapshot!==null){'+priceGuard.trim()+'}');
  replace('collector/vendor-forward.mjs','if(call.usage&&[call.usage.input_tokens','if(call.price_snapshot&&call.usage&&[call.usage.input_tokens');
  replace('collector/old-arm.py','        profile, counter = capability','        profile, counter = capability\n        # 本轮显式输出控制适配，仍用原计量器与中间件。\n        profile = dataclasses.replace(profile, output_reserve_tokens=primary[\'controls\'][\'max_output_tokens\'])\n        counter = input_budget_module.ChatJsonInputTokenCounter(model, profile=profile, base_url=\'https://api.deepseek.com\')');
  for(const name of ['collector/primary.json','collector/vendor-forward.mjs','collector/old-arm.py'])adaptations.push({path:name,before_sha256:originalFiles[name],after_sha256:sha(bytes.get(name)),kind:'explicit_execution_control_only'});
  bytes.set('collector/execution-policy.json',Buffer.from(JSON.stringify(policy,null,2)+'\n'));
 }
 return {bytes,files:Object.fromEntries([...bytes].map(([name,value])=>[name,sha(value)])),original_files:originalFiles,control_adaptations:adaptations,...policy?{execution_policy:policy,execution_policy_sha256:sha(canonical(policy))}:{}};
}

export async function freezeEvaluationRuntime(snapshot,directory){
 for(const [name,bytes]of snapshot.bytes){const path=join(directory,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes,{flag:'wx'});}
 await verifyEvaluationRuntime(snapshot,directory);
}

async function filesBelow(directory,prefix=''){
 const files=[];
 for(const entry of await readdir(directory,{withFileTypes:true})){
  if(entry.isDirectory())files.push(...await filesBelow(join(directory,entry.name),prefix+entry.name+'/'));
  else if(entry.isFile())files.push(prefix+entry.name);
  else throw Error('evaluation_runtime_non_regular_file');
 }
 return files.sort();
}

export async function verifyEvaluationRuntime(snapshot,directory){
 assert.deepEqual(await filesBelow(directory),Object.keys(snapshot.files).sort(),'evaluation_runtime_file_set_changed');
 for(const [name,hash]of Object.entries(snapshot.files))assert.equal(sha(await readFile(join(directory,name))),hash,'evaluation_runtime_bytes_changed: '+name);
}

export function fixedBudgetConfiguration(configuration,directory){
 return freeze({...structuredClone(configuration),moduleRoot:join(directory,'budget-modules')});
}
