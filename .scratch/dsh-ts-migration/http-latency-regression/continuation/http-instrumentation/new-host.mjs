/** 复用产品 launchDsh；preload 只增加本轮采样观察和出站拒绝。 */
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const project=process.env.NOTALONE_PERF_PROJECT;
const spawn=cp.spawn;
let backendExited=false;
cp.spawn=function(command,args,options){
 if(args?.some(arg=>arg.endsWith('/@deepseek-ai/dsh/lib/bin.js'))){
  const started=process.hrtime.bigint();
  writeFileSync(path.join(process.env.NOTALONE_PERF_RUN,'spawn.json'),JSON.stringify({started_ns:Number(started)}));
  args=['--import',path.join(import.meta.dirname,'perf-preload.mjs'),...args];
  options={...options,stdio:['pipe','inherit','inherit']};
  const child=spawn(command,args,options);
  child.once('exit',(code,signal)=>{
   backendExited=true;
   writeFileSync(path.join(process.env.NOTALONE_PERF_RUN,'backend-exit.json'),JSON.stringify({code,signal}));
   process.stdin.pause();
  });
  return child;
 }
 return spawn(command,args,options);
};
syncBuiltinESMExports();
const {launchDsh}=await import(pathToFileURL(path.join(project,'backend-ts/src/launch.ts')));
const host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:project,
 envFilePath:process.env.NOTALONE_ENV_FILE,infoPath:process.env.NOTALONE_BACKEND_INFO,
 businessHome:process.env.HOME,
 environment:Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('NOTALONE_')||key==='TZ'||key==='LANG'))},()=>true);
let stopping;
const stop=()=>stopping??=(async()=>{const success=await host.terminate();process.exitCode=success?0:1;process.stdin.pause();})();
if(!backendExited)process.stdin.resume();process.stdin.on('end',stop);process.on('SIGTERM',stop);
