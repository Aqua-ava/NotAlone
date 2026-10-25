/** 固定archive与独立driver源码绑定；不加载工作区生产源码。 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,chmod,readdir,readFile,writeFile,rm,cp,symlink,stat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
export const REPO=fileURLToPath(new URL('../../../',import.meta.url));
export const OWN='.scratch/dsh-ts-migration/nonreply-skill-formal-driver';
export const PIN='e60074b5946b8d1c990fcb75ba13bd58f789b2fb';
export const LEGACY='3c168296e9e8edaa43b8b323ff693e790e709069';
export const BROKER_FREEZE={
  'broker.mjs':'a2658a430c95cbf52fb859544df85838c3e70ce57e1467cde04bd29c19eeaf2d',
  'attempt-journal.mjs':'b5704875c62b40a719e187bf81c9ea181cdfa40f2f101c7024881e1cbd23f5e6',
  'transport.mjs':'a8cacefcb4819063e90d912cd5609cf8e0e92aae0eb6edbb5c0eb1f47648581b',
  'synthetic-budget.mjs':'15180ad2ccfdf7d104e4b337ebb75cb3f65e005f1dfd147d2ba522578208b1af',
};
export const sha=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const execute=promisify(execFile);
async function files(root,prefix=''){
  const out=[];
  for(const e of (await readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const name=prefix+e.name;
    if(e.isDirectory())out.push(...await files(join(root,e.name),name+'/'));
    else if(e.isFile())out.push(name);
    else throw Error('snapshot_non_regular_source');
  }
  return out;
}
export async function createSnapshot(directory){
  const root=await mkdtemp(join(tmpdir(),'na-skill-source-'));await chmod(root,0o700);
  const candidate=join(root,'candidate');await mkdir(candidate,{mode:0o700});
  async function archive(commit,paths){
    const tar=join(root,'source.tar');
    await execute('git',['archive',commit,'--format=tar','--output='+tar,'--',...paths],{cwd:REPO});
    await execute('tar',['-xf',tar,'-C',candidate]);await rm(tar);
  }
  try{
    await archive(PIN,['backend-ts/src','backend-ts/profile','backend-ts/package.json','backend-ts/pnpm-lock.yaml','backend/database/migrations',
      '.scratch/dsh-ts-migration/baseline','.scratch/dsh-ts-migration/resumed-nonreply-evaluation',
      '.scratch/dsh-ts-migration/nonreply-formal-model-seam','.scratch/dsh-ts-migration/nonreply-formal-runner-preparation',
      '.scratch/dsh-ts-migration/ticket25-final-run/bridge.mjs','.scratch/dsh-ts-migration/ticket25-final-run/bridge.py',
      '.scratch/dsh-ts-migration/ticket25-final-run/execution-snapshot.mjs']);
    await archive(LEGACY,['backend/src/notalone']);
    const dest=join(candidate,OWN);await mkdir(dirname(dest),{recursive:true});
    await cp(join(REPO,OWN),dest,{recursive:true,filter:p=>p===join(REPO,OWN)||/\.(mjs|ts|py)$/.test(p)});
    const brokerName='.scratch/dsh-ts-migration/nonreply-persistent-broker';
    await mkdir(join(candidate,brokerName),{recursive:true,mode:0o700});
    for(const [name,expected] of Object.entries(BROKER_FREEZE)){
      const bytes=await readFile(join(REPO,brokerName,name));assert.equal(sha(bytes),expected,'peer_runtime_freeze_changed');
      await writeFile(join(candidate,brokerName,name),bytes,{mode:0o600});
    }
    const manifest={};
    for(const base of ['backend-ts/src','backend-ts/profile','backend/database/migrations','backend/src',OWN,
      '.scratch/dsh-ts-migration/nonreply-formal-model-seam','.scratch/dsh-ts-migration/nonreply-formal-runner-preparation',
      '.scratch/dsh-ts-migration/resumed-nonreply-evaluation','.scratch/dsh-ts-migration/ticket25-final-run',brokerName]){
      for(const name of await files(join(candidate,base)))if(/\.(mjs|ts|py|sql|ya?ml)$/.test(name))manifest[base+'/'+name]=sha(await readFile(join(candidate,base,name)));
    }
    for(const name of ['backend-ts/package.json','backend-ts/pnpm-lock.yaml','.scratch/dsh-ts-migration/baseline/material-manifest.json',
      '.scratch/dsh-ts-migration/baseline/organization-learning-cases.json'])manifest[name]=sha(await readFile(join(candidate,name)));
    const gitdir=(await execute('git',['rev-parse','--absolute-git-dir'],{cwd:REPO})).stdout.trim();
    await writeFile(join(candidate,'.git'),'gitdir: '+gitdir+'\n',{mode:0o600});
    const source={candidate_commit:PIN,old_commit:LEGACY,source_sha256:sha(manifest)};
    const bytes=JSON.stringify({source,files:manifest},null,2);
    await writeFile(join(root,'source-manifest.json'),bytes,{mode:0o600});
    await writeFile(join(directory,'source-manifest.json'),bytes,{mode:0o600});
    await symlink(join(REPO,'backend-ts/node_modules'),join(candidate,'backend-ts/node_modules'),'dir');
    await symlink(join(REPO,'backend-ts/node_modules'),join(candidate,'node_modules'),'dir');
    return {root,candidate,source,manifest,
      async close(){
        const refs=(await execute('ps',['-axo','pid=,command='])).stdout.split('\n').filter(line=>line.includes(root));
        assert.equal(refs.length,0,'owned_snapshot_process_alive');assert.equal((await stat(root)).mode&0o777,0o700);
        const size=Number((await execute('du',['-sk',root])).stdout.split(/\s+/)[0]);await rm(root,{recursive:true});
        return {source_snapshot_removed:true,before_kib:size,after_kib:0,process_references:0};
      }};
  }catch(error){await rm(root,{recursive:true,force:true});throw error;}
}
