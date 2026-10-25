/** 只开放固定合成CLI；正式业务端口由根在内存注入。 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,chmod,writeFile,readFile,readdir,lstat,realpath} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {tmpdir,homedir,userInfo} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createSnapshot,sha,PIN,LEGACY,OWN,REPO} from './snapshot.mjs';
const execute=promisify(execFile);
const packages=['dsh','cordis','dsh-llm','dsh-llm-deepseek','dsh-llm-deepseek-api-key','dsh-skill'];
async function dependencyPins(){
  const out={node:process.version,packages:{}};
  const require=createRequire(await realpath(new URL('../../../backend-ts/node_modules/@deepseek-ai/dsh/package.json',import.meta.url)));
  for(const name of packages){
    const entry=name==='dsh'?new URL('../../../backend-ts/node_modules/@deepseek-ai/dsh/lib/bin.js',import.meta.url).pathname:require.resolve('@deepseek-ai/'+name);
    let root=dirname(entry),bytes,pkg;
    for(;;){try{bytes=await readFile(join(root,'package.json'));pkg=JSON.parse(bytes);if(pkg.name==='@deepseek-ai/'+name)break;}catch{}
      if(root===dirname(root))throw Error('installed_sdk_package_not_found');root=dirname(root);}
    out.packages[name]={version:pkg.version,package_sha256:sha(bytes),entry_sha256:sha(await readFile(entry))};
  }
  return out;
}
async function inventory(directory,prefix=''){
  const rows=[];for(const e of await readdir(directory,{withFileTypes:true})){
    const name=prefix+e.name,path=join(directory,e.name),metadata=await lstat(path);
    if(e.isDirectory())rows.push(...await inventory(path,name+'/'));
    else rows.push({name,mode:metadata.mode&0o777,sha256:sha(await readFile(path))});
  }return rows.sort((a,b)=>a.name.localeCompare(b.name));
}
export async function runSyntheticProbe({scenarios=['correction','failure','cancel','unknown'],publish=true}={}){
  assert.ok(scenarios.length&&scenarios.every(s=>['correction','failure','cancel','unknown'].includes(s)),'fixed_synthetic_scenarios_only');
  const directory=await mkdtemp(join(tmpdir(),'na-skill-formal-private-'));await chmod(directory,0o700);
  let snapshot,cleanup,result;const before=await dependencyPins();
  try{
    snapshot=await createSnapshot(directory);
    const worker=join(snapshot.candidate,OWN,'probe-worker.mjs');let output;
    try{output=await execute(process.execPath,['--import',join(snapshot.candidate,'.scratch/dsh-ts-migration/nonreply-formal-model-seam/network-guard.mjs'),worker,directory,snapshot.root,JSON.stringify(scenarios)],
      {cwd:snapshot.candidate,env:{PATH:process.env.PATH,HOME:homedir(),USER:userInfo().username,NOTALONE_DISABLE_DOTENV:'1',PYTHONDONTWRITEBYTECODE:'1'},timeout:240000,maxBuffer:1024*1024});}
    catch(error){await writeFile(join(directory,'worker-failure.log'),String(error.stdout??'')+String(error.stderr??'')+String(error.stack??error),{mode:0o600});throw Error('synthetic_skill_worker_failed_private_log_preserved:'+directory.split('/').at(-1));}
    await writeFile(join(directory,'worker.log'),output.stdout+output.stderr,{mode:0o600});result=JSON.parse(await readFile(join(directory,'summary.json'),'utf8'));
    const after=await dependencyPins();assert.deepEqual(after,before,'installed_sdk_drift');result.dependencies=before;result.dependencies_unchanged=true;
    const changes=(await execute('git',['diff','--name-only','9b20e99c771d87986579f4343c68bb743afe2bc4',PIN,'--','backend-ts/src','backend-ts/profile','backend/database/migrations'],{cwd:REPO})).stdout.trim().split('\n').filter(Boolean);
    result.preintegration_source_difference={baseline:'9b20e99c771d87986579f4343c68bb743afe2bc4',candidate:PIN,paths:changes,skill_chain_unchanged:changes.every(p=>p==='backend-ts/src/reply-comparison.ts')};
  }finally{
    if(snapshot)cleanup=await snapshot.close();
    await writeFile(join(directory,'snapshot-cleanup.json'),JSON.stringify(cleanup??null),{mode:0o600});
  }
  result.cleanup={...result.cleanup,snapshot:cleanup};result.raw_evidence_directory_label=directory.split('/').at(-1);
  const raw=JSON.stringify(result,null,2);assert.ok(!raw.includes(REPO)&&!raw.includes(homedir())&&!raw.includes('/private/var/'),'public_private_path');
  assert.ok(!/"(?:owner_id|contact_id|session_id|task_id|step_id|worker_id|permit_id|attempt_id)"\s*:/.test(raw),'public_private_identity');
  const label=directory.split('/').at(-1).replace('na-skill-formal-private-','probe-');
  const publicBytes=raw+'\n';await writeFile(join(directory,'public-summary.json'),publicBytes,{mode:0o600});
  const entries=await inventory(directory);assert.ok(entries.every(r=>r.mode===0o600),'private_raw_file_permissions');
  if(publish){
    const target=new URL('./'+label+'-summary.json',import.meta.url);await writeFile(target,publicBytes,{flag:'wx'});
    await writeFile(new URL('./'+label+'-bindings.json',import.meta.url),JSON.stringify({schema_version:'skill-evidence-binding-v1',raw_directory_label:result.raw_evidence_directory_label,
      raw_files:entries,public_summary:target.pathname.split('/').at(-1),public_sha256:sha(publicBytes),source_pin:PIN,old_pin:LEGACY},null,2)+'\n',{flag:'wx'});
  }
  return result;
}
export function assertEngineeringEvidence(result){
  const expected=result.scenarios.length*2;
  assert.equal(result.records.length,expected);assert.equal(result.actual_http,expected);assert.equal(result.budget.used,expected);
  assert.ok(result.budget.remaining>expected);assert.equal(result.broker.physical_attempts,expected);assert.equal(result.broker.journal_reserved,expected);
  for(const row of result.records){
    assert.equal(row.actual_http,1);assert.equal(row.pg_ledger_count,1);assert.equal(row.existing_v1_unchanged,true);assert.equal(row.published_count,0);assert.ok(row.source_rechecks>=4);
    if(row.scenario==='correction'){
      assert.equal(row.terminal_status,'succeeded');assert.deepEqual(row.draft_states,['pending']);assert.deepEqual(row.draft_revisions,[1]);
      assert.equal(row.correction_source_bound,true);assert.equal(row.target_version_bound,true);assert.equal(row.five_phase_evidence.complete,true);
    }else{
      assert.equal(row.terminal_status,row.scenario==='cancel'?'cancelled':row.scenario==='unknown'?'unknown':'failed');assert.equal(row.draft_count,0);
      if(row.scenario==='cancel')assert.equal(row.cancel_persisted,true);
    }
  }
  assert.equal(result.cleanup.complete,true);assert.equal(result.cleanup.snapshot.source_snapshot_removed,true);return true;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--synthetic-only'],'only_explicit_synthetic_cli_available');
  const result=await runSyntheticProbe();assertEngineeringEvidence(result);console.log(JSON.stringify({actual_http:result.actual_http,budget:result.budget,records:result.records.map(r=>({arm:r.arm,scenario:r.scenario,status:r.terminal_status,drafts:r.draft_count,error:r.error_code})),cleanup:result.cleanup,formal_quality_runs:0}));
}
