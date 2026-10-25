/** 固定Git源码与冻结薄接缝；复制清单不含业务资料、env或旧账本。 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,copyFile,symlink,rm,readdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha} from './attempt-journal.mjs';
const execute=promisify(execFile);
export const PIN='e60074b5946b8d1c990fcb75ba13bd58f789b2fb',PRIOR='9b20e99c771d87986579f4343c68bb743afe2bc4',OLD='3c168296e9e8edaa43b8b323ff693e790e709069';
export const REPO=fileURLToPath(new URL('../../../',import.meta.url)),OWN='.scratch/dsh-ts-migration/nonreply-persistent-broker';
const seams=['formal-executor.mjs','problem-budget-port.mjs','extraction-business.mjs','profile-host.mjs','model-profile-plugin.ts','network-guard.mjs','test-fixture.mjs'];
async function files(root,prefix=''){const out=[];for(const e of await readdir(join(root,prefix),{withFileTypes:true})){
  if(e.name==='node_modules'||e.name==='.git')continue;
  const name=join(prefix,e.name);if(e.isDirectory())out.push(...await files(root,name));else if(e.isFile())out.push(name);else throw Error('snapshot_nonregular_source');
  }return out.sort();}
export async function prepareSnapshot(directory){
  const candidate=join(directory,'candidate'),legacy=join(directory,'legacy');await mkdir(candidate,{mode:0o700});await mkdir(legacy,{mode:0o700});
  assert.equal((await execute('git',['rev-parse',PIN+'^{commit}'],{cwd:REPO})).stdout.trim(),PIN);
  const delta=(await execute('git',['diff',PRIOR,PIN,'--','backend-ts/src'],{cwd:REPO})).stdout;
  // 已逐行复核：唯一生产差异为reply-comparison显式费用豁免，无发送链路变更。
  assert.equal(sha(delta),'33c689b375b3b8559edfdb77a2d22461cebebaf2bb46deac19331092103b3bcb','final_pin_production_delta_requires_review');
  for(const [commit,target,paths]of [[PIN,candidate,['backend-ts','backend/src','backend/database/migrations','.scratch/dsh-ts-migration/baseline','.scratch/dsh-ts-migration/ticket25-final-run/bridge.mjs','.scratch/dsh-ts-migration/ticket25-final-run/bridge.py','.scratch/dsh-ts-migration/ticket25-final-run/execution-snapshot.mjs']],
    [OLD,legacy,['backend/src/notalone']]]){
    const archive=join(directory,'source.tar');await execute('git',['archive',commit,'--output='+archive,'--',...paths],{cwd:REPO});await execute('tar',['-xf',archive,'-C',target]);await rm(archive);
  }
  const originals={};
  async function copy(relative){const bytes=await readFile(join(REPO,relative));originals[relative]=sha(bytes);const to=join(candidate,relative);await mkdir(dirname(to),{recursive:true,mode:0o700});await writeFile(to,bytes,{mode:0o600});}
  for(const name of seams)await copy('.scratch/dsh-ts-migration/nonreply-formal-model-seam/'+name);
  for(const name of ['runner.mjs','material-export.py'])await copy('.scratch/dsh-ts-migration/resumed-nonreply-evaluation/'+name);
  await copy('.scratch/dsh-ts-migration/nonreply-formal-runner-preparation/old-arm.py');
  for(const name of await readdir(fileURLToPath(new URL('./',import.meta.url))))if(/\.(?:mjs|ts)$/.test(name))await copy(OWN+'/'+name);
  const git=(await execute('git',['rev-parse','--absolute-git-dir'],{cwd:REPO})).stdout.trim();await writeFile(join(candidate,'.git'),'gitdir: '+git+'\n',{mode:0o600});
  const manifest={};for(const name of await files(candidate))manifest['candidate/'+name]=sha(await readFile(join(candidate,name)));
  for(const name of await files(legacy))manifest['legacy/'+name]=sha(await readFile(join(legacy,name)));
  await symlink(join(REPO,'backend-ts/node_modules'),join(candidate,'backend-ts/node_modules'),'dir');await symlink(join(REPO,'backend-ts/node_modules'),join(candidate,'node_modules'),'dir');
  const sdk={},sdkFiles={};for(const p of ['@deepseek-ai/dsh','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-llm-deepseek']){
    const base=join(REPO,'backend-ts/node_modules',p),pkg=JSON.parse(await readFile(join(base,'package.json'),'utf8'));
    const entry='lib/'+(p==='@deepseek-ai/dsh'?'bin.js':'index.js');sdk[p]={version:pkg.version,entry_sha256:sha(await readFile(join(base,entry)))};
    for(const path of ['package.json',entry])sdkFiles[p+'/'+path]=sha(await readFile(join(base,path)));
  }
  const python=join((await import('node:os')).homedir(),'miniconda3/envs/NotAlone/bin/python');
  const legacySdk=JSON.parse((await execute(python,['-c',"import importlib.metadata,importlib.util,json,hashlib;print(json.dumps({n:{'version':importlib.metadata.version(n),'entry_sha256':hashlib.sha256(open(importlib.util.find_spec(m).origin,'rb').read()).hexdigest()} for n,m in [('openai','openai'),('langchain-deepseek','langchain_deepseek')]}))"],{env:{NOTALONE_DISABLE_DOTENV:'1',PYTHONDONTWRITEBYTECODE:'1'}})).stdout);
  const source={candidate_commit:PIN,old_commit:OLD,source_sha256:sha({files:manifest,sdk_files:sdkFiles,legacy_sdk:legacySdk})};
  await writeFile(join(directory,'snapshot.json'),JSON.stringify({source,files:manifest,frozen_inputs:originals,sdk,sdk_files:sdkFiles,legacy_sdk:legacySdk},null,2),{mode:0o600});
  return {source,sdk,originals,async verify(){for(const [name,digest]of Object.entries(manifest))assert.equal(sha(await readFile(join(directory,name))),digest,'snapshot_source_drift');
    for(const [name,digest]of Object.entries(originals))assert.equal(sha(await readFile(join(REPO,name))),digest,'frozen_or_own_source_changed');
    for(const [name,digest]of Object.entries(sdkFiles))assert.equal(sha(await readFile(join(REPO,'backend-ts/node_modules',name))),digest,'installed_sdk_changed');return source;}};
}
