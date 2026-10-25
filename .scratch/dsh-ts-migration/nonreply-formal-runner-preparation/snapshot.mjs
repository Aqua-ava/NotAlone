/** 仓库外独占 Git archive；不改变检出、索引或依赖。 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,chmod,writeFile,readFile,mkdir,cp,symlink,rm,stat} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir,homedir,userInfo} from 'node:os';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile);
export const REPO=fileURLToPath(new URL('../../../',import.meta.url));
export const PIN='4f89bb976dd4086a02b7ae983fee2760d6e4ff64';
export const OWN='.scratch/dsh-ts-migration/nonreply-formal-runner-preparation';
export async function createSnapshot(){
  assert.equal((await execute('git',['rev-parse',`${PIN}^{commit}`],{cwd:REPO})).stdout.trim(),PIN);
  const directory=await mkdtemp(join(tmpdir(),'notalone-nonreply-formal-snapshot-'));await chmod(directory,0o700);
  try{
    const tar=join(directory,'source.tar');
    await execute('git',['archive',PIN,'--format=tar','--output='+tar,'--','backend-ts','backend/database/migrations',
      'backend/src/notalone','.scratch/dsh-ts-migration/baseline'],{cwd:REPO});
    await execute('tar',['-xf',tar,'-C',directory]);await rm(tar);
    const gitDir=(await execute('git',['rev-parse','--absolute-git-dir'],{cwd:REPO})).stdout.trim();
    await writeFile(join(directory,'.git'),`gitdir: ${gitDir}\n`,{flag:'wx',mode:0o600});
    for(const part of [OWN,'.scratch/dsh-ts-migration/resumed-nonreply-evaluation']){
      await mkdir(dirname(join(directory,part)),{recursive:true});
      await cp(join(REPO,part),join(directory,part),{recursive:true,filter:source=>!source.endsWith('.log')&&!source.includes('/results/')});
    }
    await symlink(join(REPO,'backend-ts/node_modules'),join(directory,'backend-ts/node_modules'),'dir');
    await symlink(join(REPO,'backend-ts/node_modules'),join(directory,'node_modules'),'dir');
    const environment={PATH:process.env.PATH,HOME:homedir(),USER:userInfo().username,GIT_OPTIONAL_LOCKS:'0',NOTALONE_DISABLE_DOTENV:'1',
      PYTHONDONTWRITEBYTECODE:'1',NOTALONE_HOST_RUNTIME:'typescript',NOTALONE_REPLY_RUNTIME:'typescript',
      NOTALONE_EXTRACTION_RUNTIME:'typescript',NOTALONE_EXTRACTION_B_RUNTIME:'typescript',
      NOTALONE_TASK_WORKER_RUNTIME:'typescript',NOTALONE_LAYERED_MEMORY_RUNTIME:'typescript',NOTALONE_SKILL_LEARNING_RUNTIME:'typescript'};
    let closed=false;
    return {directory,environment,async close(){
      if(closed)return;closed=true;
      assert.equal((await stat(directory)).mode&0o777,0o700);
      assert.ok(directory.startsWith(join(tmpdir(),'notalone-nonreply-formal-snapshot-')));
      const processes=(await execute('ps',['-axo','pid=,command='])).stdout.split('\n').filter(line=>line.includes(directory));
      assert.equal(processes.length,0,'snapshot_still_in_use');
      const beforeKiB=Number((await execute('du',['-sk',directory])).stdout.split(/\s+/)[0]);
      await rm(directory,{recursive:true,force:true});
      return {owned_source_snapshot_kib_before:beforeKiB,owned_source_snapshot_kib_after:0};
    }};
  }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}
