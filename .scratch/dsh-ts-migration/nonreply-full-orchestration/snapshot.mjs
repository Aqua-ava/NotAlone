/** 固定 Git 树和四组冻结驱动的只读副本；不更改 index/ref。 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readdir,readFile,writeFile,cp,rm,symlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {BASELINE} from '../resumed-nonreply-evaluation/runner.mjs';
import {sha} from '../nonreply-persistent-broker/attempt-journal.mjs';
import {REPO,privateDirectory} from './orchestrator.mjs';

const execute=promisify(execFile);
const runtimeDirectories=['nonreply-formal-model-seam','nonreply-persistent-broker','nonreply-layered-formal-drivers',
  'nonreply-skill-formal-driver','nonreply-formal-runner-preparation','resumed-nonreply-evaluation','ticket25-final-run','nonreply-full-orchestration'];
async function files(root,prefix=''){
  const output=[];for(const e of (await readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    if(e.name==='node_modules'||e.isSymbolicLink())continue;
    if(e.isDirectory())output.push(...await files(join(root,e.name),prefix+e.name+'/'));else if(e.isFile())output.push(prefix+e.name);
  }return output;
}
export async function createUnifiedSnapshot({directory,candidateCommit}){
  directory=await privateDirectory(directory);assert.match(candidateCommit??'',/^[a-f0-9]{40}$/,'full_candidate_commit_required');
  assert.equal((await execute('git',['rev-parse',candidateCommit+'^{commit}'],{cwd:REPO})).stdout.trim(),candidateCommit);
  const candidate=join(directory,'candidate'),legacy=join(directory,'legacy');
  for(const [target,pin,roots]of [[candidate,candidateCommit,['backend-ts','backend/database/migrations','.scratch/dsh-ts-migration/baseline','backend/src/notalone/application/model_permit_client.py']],
    [legacy,BASELINE,['backend/src/notalone']]]){
    await mkdir(target,{mode:0o700});const archive=join(directory,'source.tar');
    await execute('git',['archive',pin,'--format=tar','--output='+archive,'--',...roots],{cwd:REPO});
    await execute('tar',['-xf',archive,'-C',target]);await rm(archive);
  }
  await mkdir(join(candidate,'legacy-model-host-bridge'),{mode:0o700});
  await cp(join(candidate,'backend/src/notalone/application/model_permit_client.py'),join(candidate,'legacy-model-host-bridge/model_permit_client.py'));
  await rm(join(candidate,'backend/src'),{recursive:true});await cp(join(legacy,'backend/src'),join(candidate,'backend/src'),{recursive:true});
  const runtimeSources={};
  for(const name of runtimeDirectories){
    const base='.scratch/dsh-ts-migration/'+name;
    for(const relative of await files(join(REPO,base))){
      if(!/\.(mjs|ts|py)$/.test(relative)&&!['package.json','tsconfig.json','primary.json','legacy-system.json'].includes(relative))continue;
      const path=base+'/'+relative,target=join(candidate,path);await mkdir(dirname(target),{recursive:true,mode:0o700});
      const bytes=await readFile(join(REPO,path));await writeFile(target,bytes,{mode:0o600});runtimeSources[path]=sha(bytes);
    }
  }
  const manifest={};
  for(const [prefix,root]of [['candidate',candidate],['legacy',legacy]])for(const relative of await files(root))
    if(/\.(ts|mjs|py|sql|ya?ml|json|yaml)$/.test(relative))manifest[prefix+'/'+relative]=sha(await readFile(join(root,relative)));
  const gitdir=(await execute('git',['rev-parse','--absolute-git-dir'],{cwd:REPO})).stdout.trim();
  await writeFile(join(candidate,'.git'),'gitdir: '+gitdir+'\n',{mode:0o600});
  await symlink(join(REPO,'backend-ts/node_modules'),join(candidate,'backend-ts/node_modules'),'dir');
  await symlink(join(REPO,'backend-ts/node_modules'),join(candidate,'node_modules'),'dir');
  const source={candidate_commit:candidateCommit,old_commit:BASELINE,source_sha256:sha({manifest,runtimeSources})};
  await writeFile(join(directory,'source-manifest.json'),JSON.stringify({source,files:manifest,runtime_sources:runtimeSources},null,2),{mode:0o600});
  let closed=false;
  return {directory,candidate,legacy,source,manifest,
    async assertCurrent(){assert.ok(!closed,'source_snapshot_closed');for(const [file,digest]of Object.entries(manifest))assert.equal(sha(await readFile(join(directory,file))),digest,'source_snapshot_file_changed');
      for(const [file,digest]of Object.entries(runtimeSources))assert.equal(sha(await readFile(join(REPO,file))),digest,'executing_driver_changed');return source;},
    async close(){if(closed)return;const refs=(await execute('ps',['-axo','pid=,command='])).stdout.split('\n').filter(line=>line.includes(directory));assert.equal(refs.length,0,'owned_snapshot_process_alive');
      const before=Number((await execute('du',['-sk',directory])).stdout.trim().split(/\s+/)[0]);await rm(candidate,{recursive:true});await rm(legacy,{recursive:true});closed=true;
      return {owned_archive_removed:true,before_kib:before,remaining_manifest_only:true,owned_process_references:0};},
  };
}
