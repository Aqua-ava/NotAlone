/** 最终pin仅执行一对既有localhost成功样例；不执行8项套件或96次采集。 */
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const ROOT=fileURLToPath(new URL('../../../../',import.meta.url));
const OUT=fileURLToPath(new URL('.',import.meta.url));
const PIN='e60074b5946b8d1c990fcb75ba13bd58f789b2fb';
const PREFIX='.scratch/dsh-ts-migration/reply-output-cost-update/';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
const digest=value=>sha(canonical(value));
const pinned=name=>execFileSync('git',['show',PIN+':'+name],{cwd:ROOT,maxBuffer:8*1024*1024});
const frozenCore=['artifact-manifest.json','SHA256SUMS','verification.json','report.md','handoff.md'];
const coreBefore=Object.fromEntries(await Promise.all(frozenCore.map(async name=>{
 const bytes=await readFile(join(ROOT,PREFIX,name));assert.equal(sha(bytes),sha(pinned(PREFIX+name)),'冻结核心证据已漂移');return [name,sha(bytes)];
})));
const helper=PREFIX+'prepare-archive.mjs';
assert.equal(sha(await readFile(join(ROOT,helper))),sha(pinned(helper)),'archive入口须等于最终pin');
const prepared=JSON.parse(execFileSync(process.execPath,[join(ROOT,helper),PIN],{cwd:ROOT,encoding:'utf8',maxBuffer:65536}));
assert.equal(prepared.source_commit,PIN);
assert.ok(prepared.deltas.every(delta=>delta.before_sha256===delta.after_sha256),'最终archive不得混入工作树增量');
const originalDirectory=process.cwd();
let capture,evidence,failure;
try{
 const sourceFiles=await Promise.all(prepared.deltas.map(async entry=>{
  const bytes=await readFile(join(prepared.archive,entry.path));assert.equal(sha(bytes),sha(pinned(entry.path)),'最终源码字节不等于pin');
  return {path:entry.path,sha256:sha(bytes),equals_final_pin:true};
 }));
 const policyBytes=pinned(PREFIX+'execution-policy.json'),scopeBytes=pinned(PREFIX+'scope-snapshot.md');
 const policy=JSON.parse(policyBytes);assert.equal(policy.scope_sha256,sha(scopeBytes));
 const {collectLocal}=await import(pathToFileURL(join(prepared.archive,'.scratch/dsh-ts-migration/ticket25-final-run/runner.mjs')));
 const {verifyExecutionPolicyBinding}=await import(pathToFileURL(join(prepared.archive,'.scratch/dsh-ts-migration/ticket25-final-run/execution-snapshot.mjs')));
 const {verifyCapturedSources}=await import(pathToFileURL(join(prepared.archive,'.scratch/dsh-ts-migration/ticket25-final-run/capture-contract.mjs')));
 capture=await collectLocal({sourceCommit:PIN,localOnly:true,executionPolicy:policy,caseId:'paired-decline',repeat:1});
 assert.equal(capture.received,2);assert.equal(capture.records.length,2);assert.equal(capture.planned,96);
 assert.equal(capture.source_bindings.new_commit,PIN);assert.equal(capture.source_bindings.collector_binding.source_commit,PIN);
 assert.equal(capture.source_bindings.workspace_changed_during_execution,false);
 assert.equal(capture.source_bindings.fixed_git_source_changed_during_execution,false);
 assert.equal(capture.source_bindings.dependency_snapshot_equal,true);
 assert.equal(capture.problem_budget.external_execution_enabled,false);assert.equal(capture.production_switch_approved,false);
 verifyExecutionPolicyBinding(capture,policy);
 const materials=JSON.parse(await readFile(join(prepared.archive,'backend/tests/fixtures/fidelity/synthetic-v1.json'),'utf8'));
 const surfaces=verifyCapturedSources(capture,materials);
 const rows=[];
 for(const row of capture.records){
  assert.equal(row.actual.status,'succeeded',row.actual.error);assert.equal(row.physical_calls,1);assert.equal(row.source_audit.status,'verified');
  assert.equal(row.runtime_sources.attempts.length,1);assert.equal(row.physical_attempts.length,1);
  const attempt=row.runtime_sources.attempts[0],call=row.physical_attempts[0],timing=row.timing;
  assert.equal(JSON.parse(attempt.request.raw_utf8).max_tokens,393216);assert.equal(call.request.max_tokens,393216);
  assert.equal(attempt.request.sha256,sha(attempt.request.raw_utf8));assert.equal(row.request_sha256,attempt.request.sha256);
  assert.equal(row.runtime_sources.persistence.verified_after_completion,true);
  assert.equal(timing.diagnostics.request_sha256,attempt.request.sha256);
  assert.deepEqual(Object.keys(timing.phases),['queue','retrieval','network_model','validation','persistence']);
  let edge=0;
  for(const phase of Object.values(timing.phases)){assert.equal(phase.started_ms,edge);assert.ok(phase.ended_ms>=phase.started_ms);assert.ok(phase.markers.start&&phase.markers.end);edge=phase.ended_ms;}
  for(const overhead of timing.overhead??[]){assert.equal(overhead.started_ms,edge);assert.ok(overhead.ended_ms>=edge);edge=overhead.ended_ms;}
  assert.equal(edge,timing.observed_ms);assert.equal(timing.final_persisted_result_ms,timing.observed_ms);
  rows.push({arm:row.arm,status:row.actual.status,physical_calls:row.physical_calls,wire_max_tokens:call.request.max_tokens,wire_sha256:attempt.request.sha256,source_audit_status:row.source_audit.status,source_catalog_schema:attempt.catalog.schema_version,runtime_sources_sha256:digest(row.runtime_sources),source_persistence_sha256:digest(row.runtime_sources.persistence),five_phase_request_binding:timing.diagnostics.request_sha256,timing_sha256:digest(timing),observed_ms:timing.observed_ms,final_persisted_result_ms:timing.final_persisted_result_ms,actual_model:row.actual_model,model_fingerprint:row.model_fingerprint,usage:row.usage,cost:row.cost});
 }
 assert.equal(capture.arms_configuration_equal,false,'不能把输出相等误报完整配置等价');
 await writeFile(join(prepared.raw,'final-pair-capture.json'),JSON.stringify(capture)+'\n',{flag:'wx',mode:0o600});
 evidence={schema_version:'reply-output-cost-final-pair-v1',source_commit:PIN,status:'passed_localhost_pair_only',fixed_denominator:96,executed_logical_records:2,loopback_business_http_requests:2,real_model_calls:0,actual_app_runs:0,fixed_96_collections_executed:0,full_eight_case_suite_executed:false,source_files:sourceFiles,collector_source_tree_sha256:capture.source_bindings.collector_binding.source_tree_sha256,candidate_source_files_sha256:capture.source_bindings.new_source_sha256,executed_profile_sha256:capture.source_bindings.profile_sha256,legacy_profile_sha256:capture.source_bindings.old_profile_sha256,policy:{path:PREFIX+'execution-policy.json',file_sha256:sha(policyBytes),canonical_sha256:capture.execution_policy_sha256,scope_snapshot_sha256:sha(scopeBytes),max_output_tokens:policy.controls.max_output_tokens,cost_status:policy.cost_status,output_status:policy.output_status},evaluation_runtime:{original_files:capture.source_bindings.evaluation_runtime_original_files,executed_files:capture.source_bindings.evaluation_runtime_files,sha256:capture.source_bindings.evaluation_runtime_sha256,control_adaptations:capture.source_bindings.evaluation_control_adaptations},candidate_source:{matches_commit_tree:capture.source_bindings.candidate_source_manifest.matches_commit_tree,modified_paths:capture.source_bindings.candidate_source_manifest.modified_or_deleted_paths,observation_adaptations:capture.source_bindings.candidate_source_manifest.observation_adaptations},runtime_dependency_snapshot_equal:true,runtime_dependency_snapshot_sha256:digest(capture.source_bindings.dependencies_before),rows,model_surface_hashes:{prompt_hash:surfaces.prompt_hash,tool_schema_hash:surfaces.tool_schema_hash},unknowns:{arms_configuration_equal:capture.arms_configuration_equal,configuration_unknown_reasons:capture.configuration_unknown_reasons,prompt_semantic_equivalence:'not_verified',protocol_semantic_equivalence:'not_verified',underlying_response_model_version:'not_verified',real_model_quality:'not_verified',strict_route:'not_exercised_by_reply_pair'},frozen_core_sha256:coreBefore,raw_artifacts:[{path:'<private>/reply-output-cost-final-e60074b5/raw/final-pair-capture.json',sha256:sha(await readFile(join(prepared.raw,'final-pair-capture.json'))),mode:'0600'},{path:'<private>/reply-output-cost-final-e60074b5/archive-receipt.json',sha256:sha(await readFile(join(prepared.home,'archive-receipt.json'))),mode:'0600'}],cleanup:{collector:capture.cleanup},production_switch_approved:false,ticket25_approved:false,ticket26_approved:false};
}catch(error){failure=error;}
finally{
 process.chdir(ROOT);
 const beforeKib=Number(execFileSync('du',['-sk',prepared.home],{encoding:'utf8'}).split(/\s/)[0]);
 const removed=[];
 for(const name of ['archive','reporter-delta']){
  const path=join(prepared.home,name),check=spawnSync('/usr/sbin/lsof',['-t','+D',path],{encoding:'utf8'});
  assert.ok([0,1].includes(check.status)&&!check.stdout.trim(),'自有源码副本仍有引用或扫描未知');
  await rm(path,{recursive:true});removed.push(name);
 }
 const afterKib=Number(execFileSync('du',['-sk',prepared.home],{encoding:'utf8'}).split(/\s/)[0]);
 for(const name of frozenCore)assert.equal(sha(await readFile(join(ROOT,PREFIX,name))),coreBefore[name],'冻结核心证据被改动');
 if(evidence)evidence.cleanup={...evidence.cleanup,idle_copies:{exact_owned_directory_names:removed,live_file_references_before_removal:0,before_kib:beforeKib,after_kib:afterKib,raw_evidence_preserved:true},frozen_core_unchanged:true};
 process.chdir(originalDirectory);
}
if(failure)throw failure;
await writeFile(join(OUT,'verification.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({status:evidence.status,source_commit:PIN,received:2,wire_max_tokens:evidence.rows.map(row=>({arm:row.arm,max_tokens:row.wire_max_tokens})),source_verified:true,five_phases_bound:true,unknowns_retained:true,real_model_calls:0,actual_app_runs:0,cleanup:evidence.cleanup.idle_copies,raw_home:prepared.home})+'\n');
