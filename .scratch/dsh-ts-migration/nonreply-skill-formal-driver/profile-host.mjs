/** 仅具名官方profile启动；隔离home无用户配置或凭据。 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir,userInfo} from 'node:os';
import {sha} from './snapshot.mjs';
export async function startProfile({fixture,run,broker,token,rawDirectory,skillsRoot}){
  assert.match(broker,/^http:\/\/127\.0\.0\.1:\d+$/,'loopback_broker_required');
  const home=await mkdtemp(join(tmpdir(),'na-skill-profile-'));await chmod(home,0o700);
  const profile=join(home,'profiles','skill-formal');await mkdir(profile,{recursive:true,mode:0o700});
  const template=await readFile(new URL('../../../backend-ts/profile/cordis.patch.yml',import.meta.url),'utf8');
  const patch=template.replace('PLUGIN_PATH',new URL('./skill-profile-plugin.ts',import.meta.url).pathname)
    .replace('PROVIDER_URL',broker+'/anthropic').replace('maxTokens: 256','maxTokens: 393216')
    .replace('    - id: tools\n',"    - id: skills\n      name: '@deepseek-ai/dsh-skill'\n    - id: tools\n");
  await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}),{mode:0o600});
  await writeFile(join(profile,'cordis.patch.yml'),patch,{mode:0o600});
  const flags=Object.fromEntries(['HOST','REPLY','EXTRACTION','EXTRACTION_B','TASK_WORKER','LAYERED_MEMORY','SKILL_LEARNING'].map(k=>['NOTALONE_'+k+'_RUNTIME','typescript']));
  const child=spawn(process.execPath,['--import',new URL('../nonreply-formal-model-seam/network-guard.mjs',import.meta.url).pathname,
    resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','skill-formal'],{cwd:home,env:{PATH:process.env.PATH,HOME:home,USER:userInfo().username,DSH_HOME:home,
      DSH_TELEMETRY_DISABLED:'1',NOTALONE_DISABLE_DOTENV:'1',DEEPSEEK_API_KEY:'synthetic-only',...flags,
      NA_SKILL_DATABASE:fixture.database,NA_SKILL_OWNER:run.scope.owner_id,NA_SKILL_CONTACT:run.scope.contact_id,
      NA_SKILL_TOKEN:token,NA_SKILL_BROKER:broker,NA_SKILL_FILES:skillsRoot},stdio:['ignore','pipe','pipe']});
  let output='',closed=false;const exited=once(child,'exit');child.stderr.on('data',b=>{output+=b;});
  const ready=new Promise((done,reject)=>{
    const timer=setTimeout(()=>reject(Error('official_profile_ready_timeout')),20000);
    child.stdout.on('data',b=>{output+=b;const match=output.match(/^SKILL_READY (.+)$/m);if(match){clearTimeout(timer);done(JSON.parse(match[1]));}});
    child.once('exit',()=>{clearTimeout(timer);reject(Error('official_profile_start_failed'));});
  });
  async function close(){if(closed)return;closed=true;if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited;
    await writeFile(join(rawDirectory,'profile.log'),output,{mode:0o600});await rm(home,{recursive:true});}
  try{return {info:await ready,profileSha:sha(patch),templateSha:sha(template),close};}catch(error){await close();throw error;}
}
