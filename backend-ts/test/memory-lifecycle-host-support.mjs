import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const backendDirectory=fileURLToPath(new URL('../',import.meta.url));
import {setTimeout as delay} from 'node:timers/promises';
import {createStorageFixture} from './host-storage-fixture.mjs';

/** 正式 profile、认证 HTTP 与唯一真实 Worker；仅用本轮合成库，不配置外部供应商。 */
export async function lifecycleHost(t,seed,options={}){
 const fixture=await createStorageFixture(),owner=randomUUID();let child,exited,output='';
 t.after(async()=>{
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([exited,delay(12000,undefined,{ref:false})]);}
  await fixture.close();
 });
 await fixture.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await seed?.(fixture,owner);
 await writeFile(fixture.envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${fixture.client.database}\nNOTALONE_OWNER_ID=${owner}\nNOTALONE_REPLY_RUNTIME=typescript\nNOTALONE_EXTRACTION_RUNTIME=typescript\nNOTALONE_DEEPSEEK_API_KEY=synthetic-only\nNOTALONE_SKILLS_DIR=${join(fixture.directory,'skills')}\n`,{mode:0o600});
 const home=join(fixture.directory,'profile-home'),profile=join(home,'profiles/notalone'),info=join(fixture.directory,'backend.info');
 await mkdir(profile,{recursive:true});
 await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
 await writeFile(join(profile,'cordis.patch.yml'),(await readFile(join(backendDirectory,'profile/host.patch.yml'),'utf8')).replace('PLUGIN_PATH',JSON.stringify(join(backendDirectory,'src/host-plugin.ts'))));
 await writeFile(join(home,'host.json'),JSON.stringify({nodeExecutable:process.execPath,projectDirectory:resolve(backendDirectory,'..'),envFilePath:fixture.envFilePath,infoPath:info,businessHome:fixture.directory,home,parentPid:process.pid,lockNonce:randomUUID()}));
 let connection;
 const startHost=async()=>{
 await rm(info,{force:true});
 child=spawn(process.execPath,['--import',join(backendDirectory,'test/main-host-reply-chain-preload.mjs'),join(backendDirectory,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{cwd:home,env:{PATH:process.env.PATH,USER:process.env.USER,LOGNAME:process.env.LOGNAME,HOME:home,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',NOTALONE_HOST_CONFIG:join(home,'host.json'),...(options.providerUrl?{NOTALONE_SYNTHETIC_PROVIDER_URL:options.providerUrl}:{})},stdio:['pipe','pipe','pipe']});
 exited=once(child,'exit');child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 connection=undefined;const deadline=Date.now()+20000;
 while(!connection&&Date.now()<deadline){
  try{connection=Object.fromEntries((await readFile(info,'utf8')).trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));}
  catch{if(child.exitCode!==null)throw Error(`合成正式宿主提前退出：${output.slice(-2000)}`);await delay(50);}
 }
 if(!connection)throw Error(`合成正式宿主未就绪：${output.slice(-2000)}`);
 };
 const stopHost=async()=>{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([exited,delay(12000,undefined,{ref:false})]);if(child.exitCode===null&&child.signalCode===null)throw Error('合成宿主未排空');}};
 await startHost();
 const request=async(path,{authenticated=true,method='GET',body}={})=>{
  const response=await fetch(`http://${connection.address}${path}`,{method,headers:{...(authenticated?{Authorization:`Bearer ${connection.token}`} : {}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
  return {status:response.status,data:await response.json()};
 };
 return {...fixture,owner,request,stopHost,output:()=>output,
  restartHost:async()=>{await stopHost();await startHost();}};
}
