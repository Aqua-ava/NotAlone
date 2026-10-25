/** 只从完整 commit 导出；源码及执行脚本每次发送前核验。 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,chmod,readFile,writeFile,mkdir,rm,cp,symlink,stat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir,homedir,userInfo} from 'node:os';
import {fileURLToPath} from 'node:url';
import {hash} from './formal-executor.mjs';
import {enumerateFiles} from '../ticket25-final-run/source-snapshot.mjs';
import {BASELINE} from '../resumed-nonreply-evaluation/runner.mjs';
const execute=promisify(execFile);
export const REPO=fileURLToPath(new URL('../../../',import.meta.url)),OWN='.scratch/dsh-ts-migration/nonreply-formal-model-seam';
export async function createFixedSnapshot({candidateCommit}){
  assert.match(candidateCommit??'',/^[a-f0-9]{40}$/,'full_candidate_commit_required');
  assert.equal((await execute('git',['rev-parse',candidateCommit+'^{commit}'],{cwd:REPO})).stdout.trim(),candidateCommit);
  const directory=await mkdtemp(join(tmpdir(),'notalone-nonreply-seam-snapshot-'));await chmod(directory,0o700);
  const candidate=join(directory,'candidate'),legacy=join(directory,'legacy');
  try{
    await mkdir(candidate,{mode:0o700});await mkdir(legacy,{mode:0o700});
    for(const [commit,target,roots]of [[candidateCommit,candidate,['backend-ts','backend/database/migrations','.scratch/dsh-ts-migration/baseline']],
      [BASELINE,legacy,['backend/src/notalone']]]){
      const archive=join(directory,'source.tar');
      await execute('git',['archive',commit,'--format=tar','--output='+archive,'--',...roots],{cwd:REPO});
      await execute('tar',['-xf',archive,'-C',target]);await rm(archive);
    }
    // 只复制薄执行脚本；既有冻结证据及报告不修改、不作为当前质量结果。
    const scripts=[OWN,'.scratch/dsh-ts-migration/resumed-nonreply-evaluation','.scratch/dsh-ts-migration/nonreply-formal-runner-preparation','.scratch/dsh-ts-migration/ticket25-final-run'];
    for(const name of scripts){await mkdir(dirname(join(candidate,name)),{recursive:true});
      await cp(join(REPO,name),join(candidate,name),{recursive:true,filter:path=>!path.endsWith('.log')&&!path.includes('/results/')});}
    await cp(join(legacy,'backend/src'),join(candidate,'backend/src'),{recursive:true});
    const gitDirectory=(await execute('git',['rev-parse','--absolute-git-dir'],{cwd:REPO})).stdout.trim();
    await writeFile(join(candidate,'.git'),`gitdir: ${gitDirectory}\n`,{mode:0o600});
    const files={};
    for(const base of ['backend-ts/src','backend-ts/profile','backend/database/migrations','backend/src',...scripts]){
      for(const name of await enumerateFiles(join(candidate,base))){
        if(/\.(?:ts|mjs|py|yml|json|sql|yaml)$/.test(name))files[base+'/'+name]=hash(await readFile(join(candidate,base,name)));
      }
    }
    for(const name of ['backend-ts/package.json','backend-ts/pnpm-lock.yaml'])files[name]=hash(await readFile(join(candidate,name)));
    await symlink(join(REPO,'backend-ts/node_modules'),join(candidate,'backend-ts/node_modules'),'dir');
    await symlink(join(REPO,'backend-ts/node_modules'),join(candidate,'node_modules'),'dir');
    const source={candidate_commit:candidateCommit,old_commit:BASELINE,source_sha256:hash(files)};
    await writeFile(join(directory,'source-manifest.json'),JSON.stringify({source,files},null,2),{mode:0o600});
    let closed=false;
    return {directory,candidate,legacy,files,source,
      environment:{PATH:process.env.PATH,HOME:homedir(),USER:userInfo().username,NOTALONE_DISABLE_DOTENV:'1',PYTHONDONTWRITEBYTECODE:'1',
        NA_SEAM_SNAPSHOT:directory,NA_SEAM_BUDGET_MODULE_ROOT:join(legacy,'backend/src')},
      async assertCurrent(){for(const [name,sha]of Object.entries(files))assert.equal(hash(await readFile(join(candidate,name))),sha,'snapshot_file_changed:'+name);return source;},
      async close(){if(closed)return;const refs=(await execute('ps',['-axo','pid=,command='])).stdout.split('\n').filter(l=>l.includes(directory));
        assert.equal(refs.length,0,'owned_snapshot_process_alive');assert.equal((await stat(directory)).mode&0o777,0o700);
        const before=Number((await execute('du',['-sk',directory])).stdout.split(/\s+/)[0]);await rm(directory,{recursive:true});closed=true;
        return {owned_source_snapshot_removed:true,before_kib:before,after_kib:0,owned_process_references:0};}};
  }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}
