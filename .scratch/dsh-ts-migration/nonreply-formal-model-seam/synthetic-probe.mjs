/** 唯一执行 CLI 是固定最小合成探针；没有真实传输选项。 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,chmod,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {createFixedSnapshot,REPO,OWN} from './snapshot.mjs';
import {captureDependencies} from '../ticket25-final-run/dependencies.mjs';
import {hash} from './formal-executor.mjs';
const execute=promisify(execFile),args=process.argv.slice(2);
assert.deepEqual(args,['--synthetic-only'],'only_explicit_fixed_synthetic_probe_available');
const label=JSON.parse(await readFile(new URL('./private-evidence-label.json',import.meta.url),'utf8')).directory_label;
const base=join(tmpdir(),label);assert.equal((await stat(base)).mode&0o777,0o700);
const {mkdtemp}=await import('node:fs/promises');const directory=await mkdtemp(join(base,'probe-'));await chmod(directory,0o700);
const candidateCommit='4f89bb976dd4086a02b7ae983fee2760d6e4ff64';
const snapshot=await createFixedSnapshot({candidateCommit});let summary,cleanup,dependenciesBefore,dependenciesAfter;
try{
  await writeFile(join(directory,'source-manifest.json'),await readFile(join(snapshot.directory,'source-manifest.json')),{mode:0o600});
  dependenciesBefore=await captureDependencies(snapshot.candidate,join(homedir(),'miniconda3/envs/NotAlone/bin/python'));
  const worker=join(snapshot.candidate,OWN,'probe-worker.mjs');
  let response;
  try{response=await execute(process.execPath,['--import',join(snapshot.candidate,OWN,'network-guard.mjs'),worker,directory],
    {cwd:join(snapshot.candidate,'backend-ts'),env:snapshot.environment,timeout:180000,maxBuffer:4*1024*1024});}
  catch(error){await writeFile(join(directory,'worker-failure.log'),String(error.stdout??'')+String(error.stderr??'')+String(error.stack??error),{mode:0o600});throw Error('synthetic_worker_failed_private_log_preserved');}
  await writeFile(join(directory,'worker.log'),response.stdout+response.stderr,{mode:0o600});
  summary=JSON.parse(await readFile(join(directory,'summary.json'),'utf8'));
  dependenciesAfter=await captureDependencies(snapshot.candidate,join(homedir(),'miniconda3/envs/NotAlone/bin/python'));
  assert.equal(hash(dependenciesBefore),hash(dependenciesAfter),'installed_dependencies_changed');
  await snapshot.assertCurrent();
}finally{cleanup=await snapshot.close();await writeFile(join(directory,'snapshot-cleanup.json'),JSON.stringify(cleanup),{mode:0o600});}
const publicSummary={...summary,dependencies_before:dependenciesBefore,dependencies_after_sha256:hash(dependenciesAfter),
  dependencies_equal:true,cleanup,private_directory_label:label};
const raw=JSON.stringify(publicSummary,null,2);assert.ok(!raw.includes(REPO)&&!raw.includes(homedir())&&!raw.includes('/private/var/'),'public_private_path');
const publicLabel=directory.split('/').at(-1);await writeFile(new URL('./'+publicLabel+'-summary.json',import.meta.url),raw+'\n',{flag:'wx'});
console.log(JSON.stringify({real_model_calls:0,fake_http:summary.fake_physical_http,
  records:summary.records.map(r=>({arm:r.arm,status:r.status,error:r.error,attempts:r.attempts.length,persisted:r.persistent_count})),budget:summary.shared_budget,cleanup}));
assert.equal(summary.fake_physical_http,4,'paired_nonempty_ev_4_http_required');
assert.ok(summary.records.every(r=>r.status==='succeeded'&&r.attempts.length===2&&r.durable_accounting_matches),'paired_ev_business_failed');
