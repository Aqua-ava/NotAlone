/** 私有 git archive；不碰 index/ref，逐次派发复验源码与薄装配。 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,readdir,rm,cp,symlink,chmod} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile);
export const REPO=fileURLToPath(new URL('../../../',import.meta.url));
export const OWN='.scratch/dsh-ts-migration/nonreply-layered-formal-drivers';
export const OLD='3c168296e9e8edaa43b8b323ff693e790e709069';
export const CANDIDATE='e60074b5946b8d1c990fcb75ba13bd58f789b2fb';
export const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
async function files(root){const output=[];for(const e of await readdir(root,{withFileTypes:true})){if(e.isSymbolicLink()||e.name==='node_modules')continue;const path=join(root,e.name);if(e.isDirectory())output.push(...await files(path));else output.push(path);}return output.sort();}
export async function createLayeredSnapshot({directory,candidateCommit=CANDIDATE}){
  assert.match(candidateCommit,/^[a-f0-9]{40}$/);await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
  const candidate=join(directory,'candidate'),legacy=join(directory,'legacy');
  for(const [target,pin,roots]of [[candidate,candidateCommit,['backend-ts','backend/database/migrations','backend/src/notalone/application/model_permit_client.py']],[legacy,OLD,['backend/src/notalone']]]){
    await mkdir(target,{mode:0o700});const archive=join(directory,'source.tar');
    await execute('git',['archive',pin,'--format=tar','--output='+archive,'--',...roots],{cwd:REPO});
    await execute('tar',['-xf',archive,'-C',target]);await rm(archive);
  }
  const clientBridge=join(candidate,'backend/src/notalone/application/model_permit_client.py');
  await mkdir(join(candidate,'legacy-model-host-bridge'),{mode:0o700});
  await cp(clientBridge,join(candidate,'legacy-model-host-bridge/model_permit_client.py'));
  await rm(join(candidate,'backend/src'),{recursive:true});
  await cp(join(legacy,'backend/src'),join(candidate,'backend/src'),{recursive:true});
  await symlink(join(REPO,'backend-ts/node_modules'),join(candidate,'node_modules'),'dir');
  await symlink(join(REPO,'backend-ts/node_modules'),join(candidate,'backend-ts/node_modules'),'dir');
  const driverRoot=join(candidate,OWN);await mkdir(driverRoot,{recursive:true,mode:0o700});
  for(const path of await files(join(REPO,OWN)))if(/\.(mjs|ts|py)$/.test(path)||['package.json','tsconfig.json'].includes(path.split('/').at(-1)))await cp(path,join(driverRoot,path.split('/').at(-1)));
  const manifest={};
  for(const root of [candidate,legacy])for(const file of await files(root))if(/\.(ts|mjs|py|json|yaml|yml|sql)$/.test(file))manifest[file.slice(directory.length+1)]=hash(await readFile(file));
  const rootDependencies={};
  for(const path of ['nonreply-persistent-broker/broker.mjs','nonreply-persistent-broker/attempt-journal.mjs','nonreply-persistent-broker/transport.mjs','nonreply-persistent-broker/synthetic-budget.mjs',
    'nonreply-formal-model-seam/formal-executor.mjs','nonreply-formal-model-seam/plan.mjs','nonreply-formal-model-seam/problem-budget-port.mjs','resumed-nonreply-evaluation/runner.mjs']){
    const file='.scratch/dsh-ts-migration/'+path;rootDependencies[file]=hash(await readFile(join(REPO,file)));
  }
  const source={candidate_commit:candidateCommit,old_commit:OLD,source_sha256:hash({archive_files:manifest,root_dependencies:rootDependencies})};
  await writeFile(join(directory,'source-manifest.json'),JSON.stringify({source,files:manifest,root_dependencies:rootDependencies},null,2),{mode:0o600});
  return {directory,candidate,legacy,driverRoot,source,manifest,
    async assertCurrent(){for(const [file,sha]of Object.entries(manifest)){
      assert.equal(hash(await readFile(join(directory,file))),sha,'layered_snapshot_changed');
      if(file.startsWith('candidate/'+OWN+'/'))assert.equal(hash(await readFile(join(REPO,file.slice('candidate/'.length)))),sha,'executing_driver_changed');
    }for(const [path,sha]of Object.entries(rootDependencies))assert.equal(hash(await readFile(join(REPO,path))),sha,'frozen_root_runtime_changed');return source;},
    async close(){const refs=(await execute('ps',['-axo','pid=,command='])).stdout.split('\n').filter(s=>s.includes(directory));assert.equal(refs.length,0,'layered_snapshot_process_alive');
      const before=Number((await execute('du',['-sk',directory])).stdout.trim().split(/\s+/)[0]);await rm(directory,{recursive:true});return {owned_source_snapshot_removed:true,owned_process_references:0,before_kib:before,after_kib:0};},
  };
}
