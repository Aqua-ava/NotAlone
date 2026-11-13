/** 冻结非回复材料的成对调度与完整分母报告；默认零执行。 */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {resolve,join,dirname,basename} from 'node:path';
import {realpathSync} from 'node:fs';
import {mkdir,writeFile,readFile,chmod,realpath} from 'node:fs/promises';

const execute=promisify(execFile);
export const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
export const BASELINE='3c168296e9e8edaa43b8b323ff693e790e709069';
export const MANIFEST_SHA='84b81a3255bffe8bc69da6f38c0dd79e1ba83510454ef8a9091c947b995b362b';
export const DSH_COMMIT='687f282e8625c6b8d11ff58211a90524be2e4317';
export const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export async function canonicalDestination(path){
  let current=resolve(path);const missing=[];
  for(;;){
    try{return join(await realpath(current),...missing.reverse());}
    catch(error){
      if(error.code!=='ENOENT'||dirname(current)===current)throw error;
      missing.push(basename(current));current=dirname(current);
    }
  }
}
const verifiedBundles=new WeakMap();
function freeze(value){
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value))freeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function loadFrozenMaterials(){
  const python=join(homedir(),'miniconda3/envs/NotAlone/bin/python');
  const result=await execute(python,[fileURLToPath(new URL('./material-export.py',import.meta.url))],{
    cwd:ROOT,timeout:60000,maxBuffer:8*1024*1024,
    env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',NOTALONE_DISABLE_DOTENV:'1'},
  });
  const bundle=JSON.parse(result.stdout);
  verifiedBundles.set(bundle,sha(bundle));
  return freeze(bundle);
}

function symbolicUUID(value){
  const hex=sha(`migration-comparison-v1:${value}`).slice(0,32);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20)}`;
}

export function createPlan(bundle,{newCommit}={}){
  assert.match(newCommit??'',/^[a-f0-9]{8,40}$/,'new_commit_pin_required');
  assert.equal(verifiedBundles.get(bundle),sha(bundle),'material_bundle_not_verified');
  assert.equal(bundle.manifest_sha256,MANIFEST_SHA,'material_manifest_drift');
  assert.equal(bundle.baseline_commit,BASELINE,'material_baseline_drift');
  assert.equal(bundle.total_unique_cases,301,'material_total_drift');
  assert.equal(bundle.cases.length,176,'material_nonreply_count_drift');
  const domains={memory_extraction:{cases:140,logical_runs:840},l2_scenario:{cases:12,logical_runs:72},
    l3_profile:{cases:12,logical_runs:72},skill_learning:{cases:12,logical_runs:72}};
  for(const [domain,count]of Object.entries(domains))
    assert.equal(bundle.cases.filter(c=>c.domain===domain).length,count.cases,'material_domain_drift');
  const runs=[];
  for(const pair of bundle.pairs){
    const item=bundle.cases[pair.case_index];
    assert.ok(item&&[1,2,3].includes(pair.repeat)&&['AB','BA'].includes(pair.order),'material_pair_invalid');
    const scope=item.material.input?.scope??{owner_id:`extraction-owner:${item.case_id}`,contact_id:`extraction-contact:${item.case_id}`};
    const mapped={owner_id:symbolicUUID(scope.owner_id),contact_id:symbolicUUID(`${scope.owner_id}:${scope.contact_id}:${pair.repeat}`)};
    for(const arm of pair.order==='AB'?['old','new']:['new','old'])runs.push({
      run_id:`${item.domain}:${item.case_id}:${pair.repeat}:${arm}`,case_id:item.case_id,domain:item.domain,
      arm,repeat:pair.repeat,order:pair.order,sequence:runs.length,scope:mapped,
      synthetic_scope_id:sha({case_id:item.case_id,repeat:pair.repeat,scope:mapped}),
      case_sha256:item.case_sha256,material:item.material,commit:arm==='old'?BASELINE:newCommit,
    });
  }
  assert.equal(runs.length,1056,'material_pair_count_drift');
  assert.equal(new Set(runs.map(r=>r.run_id)).size,1056,'material_duplicate_run');
  return freeze({schema_version:'nonreply-paired-plan-v1',protocol_version:'migration-comparison-v1',
    old_commit:BASELINE,new_commit:newCommit,dsh_commit:DSH_COMMIT,dsh_version:'0.2.1-rc.2',
    material_hash:MANIFEST_SHA,materials_verified:bundle.material_checks.length,
    canonical_cases_sha256:bundle.canonical_cases_sha256,seed:102,concurrency:1,
    domains,runs,synthetic_only:true,formal_120_qualification:'not_executed_separate_requirement'});
}

export async function runPlan(plan,{execute:run,selectedRunIds,onResult}={}){
  if(typeof run!=='function')throw Error('arm_adapter_required');
  const selected=selectedRunIds?new Set(selectedRunIds):new Set(plan.runs.map(r=>r.run_id));
  for(const id of selected)assert.ok(plan.runs.some(r=>r.run_id===id),'unplanned_selection');
  // 选择必须成对；样本筛选只影响已执行状态，完整报告仍保留1056分母。
  for(let i=0;i<plan.runs.length;i+=2){
    const [a,b]=plan.runs.slice(i,i+2);
    assert.equal(selected.has(a.run_id),selected.has(b.run_id),'unpaired_selection');
  }
  const results=[];
  for(const entry of plan.runs){
    if(!selected.has(entry.run_id))continue;
    const started=new Date().toISOString();
    let result;
    try{
      result=await run(entry);
      assert.equal(result.provider_kind,'loopback_fake','offline_provider_required');
      assert.ok(['succeeded','failed','cancelled','unknown'].includes(result.terminal_status),'terminal_status_invalid');
    }catch(error){result={terminal_status:'failed',provider_kind:'loopback_fake',physical_calls:null,
      error_code:/^[a-z][a-z0-9_]{1,100}$/i.test(error.code??error.message??'')?(error.code??error.message):'adapter_failed',
      error_sha256:sha(String(error.stack??error.message)),unknown_reason:'adapter_failed_observation_may_be_incomplete'};}
    const record={...result,run_id:entry.run_id,case_id:entry.case_id,domain:entry.domain,arm:entry.arm,
      repeat:entry.repeat,order:entry.order,sequence:entry.sequence,scope:entry.scope,
      synthetic_scope_id:entry.synthetic_scope_id,case_sha256:entry.case_sha256,commit:entry.commit,
      started_at:started,ended_at:new Date().toISOString(),real_model_calls:0,
      logical_calls:1,requested_model:'deepseek-flash',actual_model:null,model_fingerprint:null,
      lock_hash:result.lock_hash??null,profile_hash:result.provenance?.profile_sha256??null,
      config_hash:result.config_hash??null,latency_stages:null,
      usage:{input_tokens:null,output_tokens:null,reasoning_tokens:null,cache_hit_tokens:null,cache_miss_tokens:null},
      citations:result.citations??null,
      semantic_scores:null,reviewer_type:null,reviewer_version:null,
      cost_known:false,cost:null,price_snapshot:null};
    results.push(record);
    if(onResult)await onResult(record);
  }
  return results;
}

export function assembleUnifiedReport({plan,observations,retrieval=null,reply=null,feePolicy='not_overridden'}){
  assert.ok(['not_overridden','waived_temporarily_by_user'].includes(feePolicy),'fee_policy_invalid');
  const nonreply=assembleReport(plan,observations),unknowns=[];
  let replyMatches=false,retrievalMatches=false;
  if(reply){
    assert.equal(reply.schema_version,'reply-migration-report-v1','reply_report_schema_invalid');
    const old=reply.bindings?.arms?.old?.commit??reply.old_commit;
    const candidate=reply.bindings?.arms?.new?.commit??reply.new_commit;
    if(old!==plan.old_commit)unknowns.push('reply_old_pin_mismatch');
    if(candidate!==plan.new_commit)unknowns.push('reply_candidate_pin_mismatch');
    if(reply.bindings?.manifest_sha256!==plan.material_hash)unknowns.push('reply_material_hash_unknown_or_mismatch');
    if(reply.protocol_version!==plan.protocol_version)unknowns.push('reply_protocol_mismatch');
    assert.equal(reply.population?.planned,96,'reply_denominator_changed');
    replyMatches=unknowns.length===0;
  }else unknowns.push('reply_evidence_not_supplied');
  if(retrieval){
    assert.equal(retrieval.schema_version,'nonreply-current-retrieval-v1','retrieval_report_schema_invalid');
    retrievalMatches=retrieval.new_commit===plan.new_commit&&retrieval.baseline_commit===plan.old_commit
      &&retrieval.manifest_sha256===plan.material_hash&&retrieval.source_files_unchanged===true;
    if(!retrievalMatches)unknowns.push('retrieval_version_or_material_binding_mismatch');
  }else unknowns.push('current_retrieval_evidence_not_supplied');
  const replyRecorded=replyMatches?reply.population.received:0;
  assert.ok(Number.isInteger(replyRecorded)&&replyRecorded>=0&&replyRecorded<=96,'reply_count_invalid');
  if(nonreply.population.missing)unknowns.push('nonreply_runs_not_complete');
  unknowns.push('nonreply_fake_provider_is_not_model_quality','nonreply_independent_semantic_review_missing',
    'nonreply_configuration_and_fixture_adaptation_equivalence_not_established');
  const replyStatus=reply?.overall?.status??reply?.overall;
  const replyNonFeeFailure=reply?.semantic_quality?.status==='failed'||reply?.failure_rate?.status==='failed'
    ||Object.entries(reply?.metrics??{}).some(([key,value])=>!['cost','total_cost'].includes(key)&&value?.status==='failed')
    ||(reply?.failures??[]).some(f=>f.blocking!==false);
  return {schema_version:'migration-unified-report-v1',protocol_version:plan.protocol_version,
    old_commit:plan.old_commit,new_commit:plan.new_commit,dsh_commit:plan.dsh_commit,
    material_hash:plan.material_hash,plan_hash:sha(plan),
    population:{planned:1152,recorded:nonreply.population.recorded+replyRecorded,
      missing:nonreply.population.missing+96-replyRecorded},
    domains:{...nonreply.domains,reply:{planned:96,recorded:replyRecorded,missing:96-replyRecorded}},
    nonreply,reply:{status:reply?replyMatches?'bound':'binding_mismatch':'not_executed',
      evidence_sha256:reply?sha(reply):null,observed:reply},
    retrieval:{status:retrieval?retrievalMatches?'bound':'binding_mismatch':'not_executed',
      evidence_sha256:retrieval?sha(retrieval):null,observed:retrieval},
    fee_policy:{status:feePolicy,measured_pass:false,usage_preserved:true,original_reports_preserved:true},
    formal_120_qualification:plan.formal_120_qualification,
    blocking_unknowns:unknowns,real_model_calls:0,real_model_calls_scope:'performed_by_this_runner_only',
    linked_reply_physical_calls:reply?.records?.every(r=>Number.isInteger(r.physical_calls))
      ?reply.records.reduce((n,r)=>n+r.physical_calls,0):null,
    real_model_quality_verified:false,
    production_switch_approved:false,
    overall:nonreply.hard_failures.length||replyMatches&&(replyNonFeeFailure||replyStatus==='failed'&&feePolicy!=='waived_temporarily_by_user')
      ?'failed':'undetermined'};
}

export function assembleReport(plan,observations){
  const byId=new Map(),allowed=new Map(plan.runs.map(r=>[r.run_id,r]));
  for(const row of observations){
    assert.ok(allowed.has(row.run_id),'unplanned_observation');
    assert.ok(!byId.has(row.run_id),'duplicate_observation');
    const planned=allowed.get(row.run_id);
    for(const key of ['commit','case_sha256','arm','repeat','domain'])
      assert.equal(row[key],planned[key],`observation_binding_mismatch:${key}`);
    assert.equal(row.provider_kind,'loopback_fake','offline_provider_required');
    byId.set(row.run_id,row);
  }
  const records=plan.runs.map(run=>{
    const observed=byId.get(run.run_id);
    if(observed){
      const {output,business_output,...metadata}=observed;
      return {...metadata,output_sha256:output===undefined?null:sha(output),
        business_output_sha256:business_output===undefined?null:sha(business_output),
        output_storage:'outside_repository_private'};
    }
    return {
    run_id:run.run_id,case_id:run.case_id,domain:run.domain,arm:run.arm,repeat:run.repeat,order:run.order,
    sequence:run.sequence,synthetic_scope_id:run.synthetic_scope_id,case_sha256:run.case_sha256,commit:run.commit,
    terminal_status:'not_run',physical_calls:null,provider_kind:'not_run',semantic_scores:null,
    unknown_reason:'not_executed_in_this_run',cost_known:false,cost:null,
    };
  });
  const count=rows=>({planned:rows.length,recorded:rows.filter(r=>r.terminal_status!=='not_run').length,
    succeeded:rows.filter(r=>r.terminal_status==='succeeded').length,failed:rows.filter(r=>r.terminal_status==='failed').length,
    cancelled:rows.filter(r=>r.terminal_status==='cancelled').length,unknown:rows.filter(r=>r.terminal_status==='unknown').length,
    missing:rows.filter(r=>r.terminal_status==='not_run').length});
  const hardFailures=observations.flatMap(r=>(r.deterministic_checks??[]).filter(c=>c.status==='failed').map(c=>({run_id:r.run_id,...c})));
  const knownPhysical=observations.reduce((n,r)=>n+(Number.isInteger(r.physical_calls)?r.physical_calls:0),0);
  return {schema_version:'nonreply-paired-report-v1',protocol_version:plan.protocol_version,
    old_commit:plan.old_commit,new_commit:plan.new_commit,dsh_commit:plan.dsh_commit,dsh_version:plan.dsh_version,
    material_hash:plan.material_hash,materials_verified:plan.materials_verified,
    plan_hash:sha(plan),seed:plan.seed,concurrency:1,population:count(records),
    domains:Object.fromEntries(Object.keys(plan.domains).map(domain=>[domain,count(records.filter(r=>r.domain===domain))])),
    logical_runs:records.length,observed_fake_physical_calls:knownPhysical,
    physical_calls_unknown_records:observations.filter(r=>!Number.isInteger(r.physical_calls)).map(r=>r.run_id),
    real_model_calls:0,real_model_quality_verified:false,production_switch_approved:false,
    overall:hardFailures.length?'failed':'undetermined',
    hard_failures:hardFailures,failures:records.filter(r=>['failed','cancelled','unknown'].includes(r.terminal_status)).map(r=>({run_id:r.run_id,status:r.terminal_status,error_code:r.error_code,unknown_reason:r.unknown_reason})),
    semantic_quality:{status:'not_reviewed',reviewers_required:2,adjudicator_on_disagreement:true,
      reasons:['loopback_fake_is_not_model_quality','independent_blind_review_not_performed'],
      bootstrap:{resamples:10000,seed:102,cluster:'case_id',status:'not_computed_without_semantic_scores'}},
    latency:{status:'undetermined',reason:'fake_provider_time_is_not_real_model_latency'},
    cost:{status:'undetermined',cost_known:false,cost:null,reason:'fake_usage_is_not_supplier_usage'},
    formal_120_qualification:plan.formal_120_qualification,records};
}

async function main(){
  const [command,...argv]=process.argv.slice(2);
  const arg=name=>argv[argv.indexOf(name)+1];
  const newCommit=arg('--new-commit'),directory=arg('--output-directory');
  assert.ok(['plan','fake'].includes(command)&&newCommit&&directory,'usage: runner.mjs plan|fake --new-commit <pin> --output-directory <new-directory>');
  const resolved=await canonicalDestination(directory),owned=await realpath(fileURLToPath(new URL('./',import.meta.url)));
  assert.ok(resolved.startsWith(owned+'/'),'output_directory_outside_owned_scope');
  const pin=(await execute('git',['rev-parse','--verify',`${newCommit}^{commit}`],{cwd:ROOT})).stdout.trim();
  const plan=createPlan(await loadFrozenMaterials(),{newCommit:pin});
  await mkdir(resolved,{recursive:false});
  const publicPlan={...plan,schema_version:'nonreply-paired-plan-metadata-v1',full_plan_sha256:sha(plan),
    material_recipe:'从冻结manifest及固定Git树重新导出，不重复写入逐次正文或oracle。',
    runs:plan.runs.map(({material,...metadata})=>metadata)};
  await writeFile(join(resolved,'plan.json'),JSON.stringify(publicPlan,null,2)+'\n',{flag:'wx'});
  let results=[];
  let privateDirectory=null;
  let executionFailure=null,blindReceipt=null;
  if(command==='fake'){
    const {createOfflineAdapter}=await import('./offline-adapter.mjs');
    privateDirectory=await canonicalDestination(argv.includes('--private-output-directory')?arg('--private-output-directory'):
      join(homedir(),'.codex/private-diagnostics/dsh-nonreply-20261025',`run-${randomUUID()}`));
    const canonicalRoot=await realpath(ROOT);
    assert.ok(privateDirectory!==canonicalRoot&&!privateDirectory.startsWith(canonicalRoot+'/'),'private_output_must_be_outside_repository');
    await mkdir(privateDirectory,{recursive:true,mode:0o700});
    await chmod(privateDirectory,0o700);
    await writeFile(join(privateDirectory,'observations.jsonl'),'',{flag:'wx',mode:0o600});
    const selectedCases=argv.includes('--case-ids')?JSON.parse(arg('--case-ids')):argv.includes('--case-id')?[arg('--case-id')]:null;
    if(selectedCases){
      assert.ok(Array.isArray(selectedCases)&&selectedCases.length>0&&selectedCases.every(v=>typeof v==='string'),'case_selection_invalid');
      for(const name of selectedCases)assert.ok(plan.runs.some(r=>r.case_id===name),'unplanned_case_selection');
    }
    const selection=selectedCases?plan.runs.filter(r=>selectedCases.includes(r.case_id)).map(r=>r.run_id):undefined;
    let adapter;
    try{
      await execute('git',['diff','--quiet',pin,'--','backend-ts/src','backend-ts/profile','backend-ts/package.json','backend-ts/pnpm-lock.yaml'],{cwd:ROOT});
      adapter=await createOfflineAdapter({plan,directory:privateDirectory});
      results=await runPlan(plan,{execute:adapter.execute,selectedRunIds:selection,
      onResult:async result=>{const {appendFile}=await import('node:fs/promises');await appendFile(join(privateDirectory,'observations.jsonl'),JSON.stringify(result)+'\n',{mode:0o600});}});}
    catch(error){executionFailure={code:'execution_interrupted',sha256:sha(String(error.stack??error.message))};}
    finally{try{await adapter?.close();}catch(error){executionFailure={code:'cleanup_or_source_verification_failed',sha256:sha(String(error.stack??error.message))};}}
    // 中断也从持久journal装配，保留已观察记录和其余未执行分母。
    results=(await readFile(join(privateDirectory,'observations.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const {writeBlindPackets}=await import('./blind.mjs');
    blindReceipt=await writeBlindPackets({plan,observations:results,privateDirectory:join(privateDirectory,'blind')});
  }
  const readEvidence=async flag=>argv.includes(flag)?JSON.parse(await readFile(arg(flag),'utf8')):null;
  const scopeUpdate=await readFile(new URL('../acceptance-scope-update.md',import.meta.url),'utf8');
  const report=assembleUnifiedReport({plan,observations:results,
    retrieval:await readEvidence('--retrieval-report'),reply:await readEvidence('--reply-report'),
    feePolicy:scopeUpdate.includes('waived_temporarily_by_user')?'waived_temporarily_by_user':'not_overridden'});
  report.scope_update_sha256=sha(scopeUpdate);
  report.execution_failure=executionFailure;report.blind_packet_receipt=blindReceipt;
  if(privateDirectory)report.private_observations_sha256=sha(await readFile(join(privateDirectory,'observations.jsonl'),'utf8'));
  await writeFile(join(resolved,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({overall:report.overall,population:report.population,real_model_calls:0}));
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
  console.error(error.code??error.message);process.exitCode=1;
});
