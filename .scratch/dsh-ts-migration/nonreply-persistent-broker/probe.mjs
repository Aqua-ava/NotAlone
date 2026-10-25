/** 仅提供显式合成执行；真实端口只能根在内存中注入。 */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,chmod,writeFile,readFile,rm,readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,homedir,userInfo} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {prepareSnapshot,REPO,OWN} from './snapshot.mjs';
import {sha} from './attempt-journal.mjs';
const execute=promisify(execFile);assert.deepEqual(process.argv.slice(2),['--synthetic-only'],'explicit_synthetic_only_required');
const root=await mkdtemp(join(tmpdir(),'na-broker-evidence-'));await chmod(root,0o700);
const snapshotRoot=join(root,'source'),evidenceRoot=join(root,'raw');await mkdir(snapshotRoot,{mode:0o700});await mkdir(evidenceRoot,{mode:0o700});
let snapshot,sourceEvidence=null,workerCode=null,cleanup={},failure=null,summary=null,rawLog;
try{
  snapshot=await prepareSnapshot(snapshotRoot);
  const manifestBytes=await readFile(join(snapshotRoot,'snapshot.json'));
  await writeFile(join(root,'source-manifest.json'),manifestBytes,{mode:0o600});
  sourceEvidence={source:snapshot.source,sdk:snapshot.sdk,frozen_inputs:snapshot.originals,raw_manifest_sha256:sha(manifestBytes)};
  const candidate=join(snapshotRoot,'candidate'),worker=join(candidate,OWN,'profile-probe-worker.mjs');
  const environment={PATH:join(process.execPath,'..')+':/usr/bin:/bin:/usr/sbin:/sbin',HOME:homedir(),USER:userInfo().username,NOTALONE_DISABLE_DOTENV:'1',PYTHONDONTWRITEBYTECODE:'1'};
  try{const r=await execute(process.execPath,['--import',join(candidate,'.scratch/dsh-ts-migration/nonreply-formal-model-seam/network-guard.mjs'),worker,snapshotRoot,evidenceRoot],
    {cwd:join(candidate,'backend-ts'),env:environment,timeout:180000,maxBuffer:4*1024*1024});rawLog=r.stdout+r.stderr;workerCode=0;}
  catch(e){workerCode=Number.isInteger(e.code)?e.code:1;rawLog=String(e.stdout??'')+String(e.stderr??'')+String(e.stack??e);failure='official_profile_probe_failed';}
  await writeFile(join(root,'worker.log'),rawLog,{mode:0o600});
  try{summary=JSON.parse(await readFile(join(evidenceRoot,'profile-probe.json'),'utf8'));}catch{failure??='probe_summary_missing';}
  await snapshot.verify();
}catch(e){failure??='snapshot_or_probe_setup_failed';await writeFile(join(root,'parent-failure.log'),String(e.stack??e),{mode:0o600});}
finally{
  const refs=(await execute('ps',['-axo','pid=,command='])).stdout.split('\n').filter(line=>line.includes(snapshotRoot));
  cleanup.owned_snapshot_process_references=refs.length;
  if(!refs.length){await rm(snapshotRoot,{recursive:true,force:true});cleanup.owned_source_archive_removed=true;}
  else {cleanup.owned_source_archive_removed=false;failure??='owned_process_cleanup_incomplete';}
}
const publicReport={schema_version:'persistent-broker-profile-probe-v1',status:failure?'failed':'engineering_pass',failure,worker_exit_code:workerCode,
  source_evidence:sourceEvidence,summary,cleanup,real_supplier_calls:0,formal_quality_qualified:false,human_120_time_qualified:false,ticket25_approved:false,
  private_evidence_label:root.split('/').at(-1)};
const publicBytes=JSON.stringify(publicReport,null,2)+'\n';
assert.ok(!publicBytes.includes(REPO)&&!publicBytes.includes(homedir())&&!/\/(?:private\/)?var\//.test(publicBytes),'public_private_path');
const destination=fileURLToPath(new URL('./profile-probe-'+Date.now()+'.json',import.meta.url));await writeFile(destination,publicBytes,{mode:0o644,flag:'wx'});
async function rawFiles(directory,prefix=''){const out=[];for(const e of await readdir(join(directory,prefix),{withFileTypes:true})){
  const relative=join(prefix,e.name);if(e.isDirectory())out.push(...await rawFiles(directory,relative));else if(e.isFile()){await chmod(join(directory,relative),0o600);out.push({file:relative,raw_sha256:sha(await readFile(join(directory,relative)))});}
  }return out;}
const bindings={public_file:destination.split('/').at(-1),public_sha256:sha(publicBytes),raw:await rawFiles(root),private_directory_mode:(await lstat(root)).mode&0o777};
await writeFile(new URL('./'+destination.split('/').at(-1).replace('.json','-bindings.json'),import.meta.url),JSON.stringify(bindings,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:publicReport.status,failure,worker_exit_code:workerCode,public_file:bindings.public_file,
  scenarios:summary?.scenarios.map(s=>({scenario:s.scenario,http:s.http,used:s.broker.new_reservations,records:s.records.map(r=>({arm:r.arm,status:r.terminal_status,error:r.error_code,persisted:r.persisted_count})),pg_cleaned:s.pg_cleaned})),cleanup}));
if(failure)process.exitCode=1;
