/** 只启动官方锁定 profile；子进程不继承真实配置、凭据或原问题账本。 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {hash,OWN} from './snapshot.mjs';
export async function startLayeredProfile({snapshot,home,database,owner,token,broker,asOf,clockMode,directory}){
  assert.match(broker,/^http:\/\/127\.0\.0\.1:\d+$/);await mkdir(home,{mode:0o700});
  const profiles=join(home,'profiles','layered');await mkdir(profiles,{recursive:true,mode:0o700});
  const template=await readFile(join(snapshot.candidate,'backend-ts/profile/cordis.patch.yml'),'utf8');
  const patch=template.replace('PLUGIN_PATH',join(snapshot.candidate,OWN,'profile-plugin.ts')).replace('PROVIDER_URL',broker+'/anthropic').replace('maxTokens: 256','maxTokens: 393216')
    .replace('    - id: tools\n',"    - id: skills\n      name: '@deepseek-ai/dsh-skill'\n    - id: tools\n");
  await writeFile(join(profiles,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}),{mode:0o600});await writeFile(join(profiles,'cordis.patch.yml'),patch,{mode:0o600});
  const child=spawn(process.execPath,['--import',join(snapshot.candidate,OWN,'network-guard.mjs'),join(snapshot.candidate,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','layered'],
    {cwd:home,env:{PATH:process.env.PATH,HOME:home,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',NOTALONE_DISABLE_DOTENV:'1',DEEPSEEK_API_KEY:'synthetic-only',NA_LAYERED_DATABASE:database,NA_LAYERED_OWNER:owner,NA_LAYERED_TOKEN:token,NA_LAYERED_BROKER:broker,NA_LAYERED_AS_OF:asOf,NA_LAYERED_CLOCK_MODE:clockMode},stdio:['ignore','pipe','pipe']});
  let output='',closed=false;const exited=once(child,'exit');child.stderr.on('data',b=>output+=b);
  const ready=new Promise((done,reject)=>{const timer=setTimeout(()=>reject(Error('layered_profile_ready_timeout')),20000);
    child.stdout.on('data',b=>{output+=b;const m=output.match(/^LAYERED_READY (.+)$/m);if(m){clearTimeout(timer);done(JSON.parse(m[1]));}});child.once('exit',()=>{clearTimeout(timer);reject(Error('layered_profile_start_failed'));});});
  const close=async()=>{if(closed)return;closed=true;if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited;await writeFile(join(directory,'profile-raw.log'),output,{mode:0o600});await rm(home,{recursive:true});};
  try{return {info:await ready,profileSha:hash(patch),templateSha:hash(template),close};}catch(error){await close();throw error;}
}
