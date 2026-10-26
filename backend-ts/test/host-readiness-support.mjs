import {watch} from 'node:fs';
import {basename,dirname} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createRequire} from 'node:module';

// 沿用桌面测试的esbuild接缝；生产reader含TS参数属性，Node直接strip无法加载。
const require=createRequire(new URL('../../desktop/package.json',import.meta.url));
const {build}=require('esbuild');
const compiled=await build({entryPoints:[new URL('../../desktop/src/main/backend/connection.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
const {readConnection}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

/** 测试只等待自有宿主；沿用桌面完整握手校验，区分早退和存活但未就绪。 */
export async function waitForHostReady(host,infoPath,{timeoutMs=15000,stderrPath}={}){
 const start=performance.now(),deadline=start+timeoutMs;
 return new Promise((resolve,reject)=>{
  let watcher,settled=false,reading=false,changed=false;
  const finish=(error,connection)=>{if(settled)return;settled=true;watcher?.close();if(error)reject(error);else resolve(connection);};
  const fail=(code,cause)=>{const error=Object.assign(new Error(`官方宿主必须发布完整认证握手：${code}`,{cause}),{code,running:host.isRunning(),elapsed_ms:performance.now()-start,...stderrPath?{stderrPath}:{}});finish(error);};
  const inspect=async()=>{
   if(settled)return;if(reading){changed=true;return;}reading=true;
   try{
    do{
     changed=false;if(!host.isRunning()){fail('host_startup_exited');return;}
     const connection=await readConnection(infoPath);if(!connection)continue;
     if(connection.pid!==host.pid){fail('host_handshake_pid_mismatch');return;}
     const remaining=Math.ceil(deadline-performance.now());if(remaining<=0){fail('host_startup_timeout');return;}
     const response=await fetch(`http://${connection.address}/api/runtime/status`,{headers:{Authorization:`Bearer ${connection.token}`},signal:AbortSignal.timeout(remaining)});
     if(!response.ok||(await response.json()).state!=='running'){fail('host_runtime_not_running');return;}
     finish(null,connection);
    }while(changed&&!settled);
   }catch(error){fail(error?.code??(performance.now()>=deadline?'host_startup_timeout':'host_handshake_unavailable'),error);}
   finally{reading=false;}
  };
  try{watcher=watch(dirname(infoPath),{persistent:false},(_event,name)=>{if(!name||String(name)===basename(infoPath))void inspect();});watcher.once('error',error=>fail('host_handshake_watch_failed',error));}
  catch(error){fail('host_handshake_watch_failed',error);return;}
  void host.waitForExit(timeoutMs).then(exited=>{if(!settled)fail(exited||!host.isRunning()?'host_startup_exited':'host_startup_timeout');},error=>fail('host_startup_exited',error));
  void inspect();
 });
}
