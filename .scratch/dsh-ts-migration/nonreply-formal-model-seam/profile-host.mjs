/** 官方 profile 启动与退出；只接受本机 broker，不实现私有业务 handler。 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {hash} from './formal-executor.mjs';
export async function startProfile({database,owner,token,broker,log}){
  assert.match(broker,/^http:\/\/127\.0\.0\.1:\d+$/,'loopback_broker_required');
  const home=await mkdtemp(join(tmpdir(),'notalone-seam-profile-'));await chmod(home,0o700);
  const profileDirectory=join(home,'profiles','nonreply-seam');await mkdir(profileDirectory,{recursive:true,mode:0o700});
  const template=await readFile(new URL('../../../backend-ts/profile/cordis.patch.yml',import.meta.url),'utf8');
  const patch=template.replace('PLUGIN_PATH',new URL('./model-profile-plugin.ts',import.meta.url).pathname)
    .replace('PROVIDER_URL',broker+'/anthropic')
    .replace('    - id: tools\n',"    - id: skills\n      name: '@deepseek-ai/dsh-skill'\n    - id: tools\n");
  await writeFile(join(profileDirectory,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}),{mode:0o600});
  await writeFile(join(profileDirectory,'cordis.patch.yml'),patch,{mode:0o600});
  const flags=Object.fromEntries(['HOST','REPLY','EXTRACTION','EXTRACTION_B','TASK_WORKER','LAYERED_MEMORY','SKILL_LEARNING'].map(k=>['NOTALONE_'+k+'_RUNTIME','typescript']));
  const child=spawn(process.execPath,['--import',new URL('./network-guard.mjs',import.meta.url).pathname,
    resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','nonreply-seam'],{cwd:home,env:{PATH:process.env.PATH,
      HOME:home,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',NOTALONE_DISABLE_DOTENV:'1',DEEPSEEK_API_KEY:'synthetic-only',...flags,
      NA_SEAM_DATABASE:database,NA_SEAM_OWNER:owner,NA_SEAM_TOKEN:token,NA_SEAM_BROKER:broker},stdio:['ignore','pipe','pipe']});
  let output='';const exited=once(child,'exit');
  child.stderr.on('data',b=>{output+=b;});
  const ready=new Promise((done,reject)=>{
    const timer=setTimeout(()=>reject(Error('official_profile_ready_timeout')),20000);
    child.stdout.on('data',b=>{output+=b;const match=output.match(/^SEAM_READY (.+)$/m);if(match){clearTimeout(timer);done(JSON.parse(match[1]));}});
    child.once('exit',()=>{clearTimeout(timer);reject(Error('official_profile_start_failed'));});
  });
  let closed=false;
  async function close(){if(closed)return;closed=true;
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited;
    await writeFile(log,output,{mode:0o600});await rm(home,{recursive:true});}
  try{
    const info=await ready;
    return {info,home,profileSha:hash(patch),templateSha:hash(template),async close(){await close();},get output(){return output;}};
  }catch(error){await close();throw error;}
}
