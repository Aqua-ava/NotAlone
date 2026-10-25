/** 默认只读计划；真实模式无条件拒绝。 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile,mkdir,readFile,chmod,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createSnapshot,OWN,REPO,PIN} from './snapshot.mjs';
import {loadFrozenMaterials,createPlan,assembleUnifiedReport,sha} from '../resumed-nonreply-evaluation/runner.mjs';
import {publicObservation} from './public-metadata.mjs';
const execute=promisify(execFile),[mode='dry-run',...args]=process.argv.slice(2);
assert.ok(['dry-run','fake'].includes(mode),'real_transport_disabled');
const label=args.includes('--label')?args[args.indexOf('--label')+1]:'prepared-plan';
assert.ok(/^[-a-zA-Z0-9_]+$/.test(label),'output_label_invalid');
assert.ok(!args.some(v=>/^--.*(?:real|key|credential)/i.test(v)),'real_transport_disabled');
const output=join(REPO,OWN,label);
await mkdir(output,{recursive:false,mode:0o700});
const plan=createPlan(await loadFrozenMaterials(),{newCommit:PIN});
await writeFile(join(output,'plan.json'),JSON.stringify({...plan,runs:plan.runs.map(({material,...r})=>r)},null,2)+'\n',{flag:'wx'});
let report=assembleUnifiedReport({plan,observations:[],feePolicy:'waived_temporarily_by_user'});
if(mode==='fake'){
  assert.ok(args.includes('--confirm-synthetic'),'synthetic_confirmation_required');
  const privateDirectory=await mkdtemp(join(tmpdir(),'notalone-nonreply-formal-evidence-'));await chmod(privateDirectory,0o700);
  const snapshot=await createSnapshot();let response,cleanup;
  try{
    const cases=args.includes('--case-ids')?args[args.indexOf('--case-ids')+1]:undefined;
    response=await execute(process.execPath,[join(snapshot.directory,OWN,'probe-worker.mjs'),privateDirectory,...(cases?[cases]:[])],
      {cwd:join(snapshot.directory,'backend-ts'),env:snapshot.environment,timeout:300000,maxBuffer:3*1024*1024});
    await writeFile(join(privateDirectory,'worker.log'),response.stdout+response.stderr,{mode:0o600});
    report=JSON.parse(await readFile(join(privateDirectory,'report.json'),'utf8'));
  }catch(error){
    const raw=String(error.stdout??'')+String(error.stderr??'')+'\n'+String(error.stack??error);
    await writeFile(join(privateDirectory,'worker-failure.log'),raw,{mode:0o600});
    await writeFile(join(output,'failure.log'),raw.replaceAll(REPO,'$REPO_ROOT').replaceAll(snapshot.directory,'$OWNED_SNAPSHOT')
      .replaceAll(homedir(),'$USER_HOME').replace(/\/private\/var\/folders\/[^\s"']+/g,'$OWNED_TEMP_PATH'),{flag:'wx'});
    const journal=await readFile(join(privateDirectory,'observations.jsonl'),'utf8').catch(()=>null);
    if(journal!==null){
      const partial=journal.split('\n').filter(Boolean).map(line=>JSON.parse(line));
      report=assembleUnifiedReport({plan,observations:partial.map(publicObservation),feePolicy:'waived_temporarily_by_user'});
      report.partial_journal_sha256=sha(journal);report.interrupted_records_preserved=partial.length;
    }
    report.execution_failure={code:'worker_failed',sha256:sha(raw)};process.exitCode=1;
  }finally{cleanup=await snapshot.close();}
  report.private_evidence_directory_label=privateDirectory.split('/').at(-1);
  report.cleanup={owned_source_snapshot_removed:true,unknown_files_deleted:false,...cleanup};
  if(response){
    const final=response.stdout.split('\n').find(line=>line.startsWith('PROBE_RESULT '));
    assert.ok(final,'probe_result_missing');
    await writeFile(join(output,'probe-summary.json'),final.slice('PROBE_RESULT '.length)+'\n',{flag:'wx'});
  }
}
await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({mode,overall:report.overall,population:report.population,real_model_calls:0,
  failure:report.execution_failure??null,private_evidence_directory_label:report.private_evidence_directory_label??null}));
