/** 本轮合成启动适配器，完整复用产品官方 launchDsh。 */
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
  writeFileSync(path.join(process.env.NOTALONE_PERF_RUN,'spawn.json'),JSON.stringify({started_ns:Number(process.hrtime.bigint())}));
  const preload=process.env.NOTALONE_BOUNDARY_OBSERVER==='1'?path.join(import.meta.dirname,'observer-preload.mjs'):process.env.NOTALONE_BASELINE_PRELOAD;
  args=['--import',preload,...args];options={...options,stdio:['pipe','inherit','inherit']};
  const child=spawn(command,args,options);
  child.once('exit',(code,signal)=>{backendExited=true;writeFileSync(path.join(process.env.NOTALONE_PERF_RUN,'backend-exit.json'),JSON.stringify({code,signal}));process.stdin.pause();});
  return child;
 }
 return spawn(command,args,options);
};
syncBuiltinESMExports();
const {launchDsh}=await import(pathToFileURL(path.join(project,'backend-ts/src/launch.ts')));
const host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:project,
 envFilePath:process.env.NOTALONE_ENV_FILE,infoPath:process.env.NOTALONE_BACKEND_INFO,businessHome:process.env.HOME,
 environment:Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('NOTALONE_')||['TZ','LANG','TMPDIR'].includes(key)))},()=>true);
let stopping;
const stop=()=>stopping??=(async()=>{const success=await host.terminate();process.exitCode=success?0:1;process.stdin.pause();})();
if(!backendExited)process.stdin.resume();process.stdin.on('end',stop);process.on('SIGTERM',stop);
