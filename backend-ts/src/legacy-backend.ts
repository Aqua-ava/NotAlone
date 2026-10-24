import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { captureProcessIdentity } from './process-identity.ts';
import { setTimeout as delay } from 'node:timers/promises';
import {parseJson,stringifyJson} from './host-json.ts';

/** 迁移期唯一旧业务执行方；03不转移联系人、回复、同步、任务和删除的写入权。 */
export const ownership = Object.freeze({setup:'typescript',credentials:'typescript',ledger:'typescript',schemaUpdates:'python-migration-command',contacts:'python',replies:'python',memory:'python',skills:'python',imports:'python',deletion:'python',wechat:'split',wechatScope:'typescript',wechatBodySync:'python',tasks:'python'});
export class LegacyControlError extends Error {
  readonly status: number;readonly code: string;
  constructor(status:number,code:string){super('LEGACY_CONTROL_FAILED');this.status=status;this.code=code;}
}
export class LegacyBackend {
  private connection?: {address:string;token:string;pid:number};
  private exited: Promise<void>;
  private stopping=false;
  private child:ChildProcess;
  private fail:()=>void;
  private constructor(child:ChildProcess, fail:()=>void) {
    this.child=child;this.fail=fail;
    this.exited=new Promise(resolve=>{
      child.once('error',()=>{resolve();if(!this.stopping)this.fail();});
      child.once('exit',()=>{resolve();if(!this.stopping)this.fail();});
    });
  }
  get pid():number{return this.child.pid!;}
  static async start(config: {pythonExecutable?:string;projectDirectory:string;home:string;businessHome:string;envFilePath:string;lockNonce:string}, environment:NodeJS.ProcessEnv, fail:()=>void):Promise<LegacyBackend>{
    if(!config.pythonExecutable || !path.isAbsolute(config.pythonExecutable))throw new Error('LEGACY_UNCONFIGURED');
    const info=path.join(config.home,'legacy.info');
    const child=spawn(config.pythonExecutable,['-m','notalone.server.command','--host','127.0.0.1','--parent-pid',String(process.pid)],{
      cwd:config.projectDirectory,env:{...environment,PATH:process.env.PATH,USER:process.env.USER,HOME:config.businessHome,
        PYTHONPATH:path.join(config.projectDirectory,'backend/src'),PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',
        NOTALONE_BACKEND_INFO:info,NOTALONE_ENV_FILE:config.envFilePath,NOTALONE_TS_HOST:'1'},stdio:['pipe','ignore','ignore'],
    });
    const legacy=new LegacyBackend(child,fail);
    try{
      await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
      child.once('exit',()=>{void rm(path.join(config.home,'legacy.pid'),{force:true}).catch(()=>{});});
      await writeFile(path.join(config.home,'legacy.pid'),JSON.stringify({pid:child.pid,parentPid:process.pid,nonce:config.lockNonce,identity:await captureProcessIdentity(child.pid!,process.pid,config.pythonExecutable)}),{mode:0o600,flag:'wx'});
      for(let i=0;i<120 && child.exitCode===null && child.signalCode===null;i++){
        try{
          const fields=Object.fromEntries((await readFile(info,'utf8')).trim().split('\n').map(line=>{const n=line.indexOf('=');return[line.slice(0,n),line.slice(n+1)];}));
          if(!/^127\.0\.0\.1:[1-9]\d{0,4}$/.test(fields.address) || !/^[A-Za-z0-9_-]{1,256}$/.test(fields.token) || Number(fields.pid)!==child.pid)throw new Error('LEGACY_HANDSHAKE_INVALID');
          legacy.connection={address:fields.address,token:fields.token,pid:Number(fields.pid)};
          const response=await legacy.control('/api/runtime/status','GET');
          if(response.state!=='running')throw new Error('LEGACY_NOT_READY');
          return legacy;
        }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        await delay(100);
      }
      throw new Error('LEGACY_START_FAILED');
    }catch(error){await legacy.stop();throw error;}
  }
  async control(endpoint:string,method:string,body?:Record<string,unknown>,timeoutMs=5500,signal?:AbortSignal):Promise<{
    state?:string;active_requests?:number;status?:string;task_id?:string;[key:string]:unknown;
  }>{
    const c=this.connection;if(!c)throw new Error('LEGACY_NOT_READY');
    const response=await fetch(`http://${c.address}${endpoint}`,{method,headers:{Authorization:`Bearer ${c.token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),redirect:'error'});
    const text=await response.text();
    if(!response.ok){
      let remote:string|undefined;
      try{
        const parsed=parseJson(text);
        if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&'error' in parsed
          &&typeof parsed.error==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(parsed.error))remote=parsed.error;
      }catch{}
      const code=endpoint==='/api/runtime/wechat-scope/revoke'
        ? ({400:'cli_binding_revoke_invalid',404:'cli_binding_not_found',409:'cli_binding_revoke_busy'} as Record<number,string>)[response.status] ?? 'cli_binding_revoke_failed'
        : remote??'legacy_control_failed';
      throw new LegacyControlError(response.status,code);
    }
    return parseJson(text) as {state?:string;active_requests?:number;status?:string;task_id?:string;[key:string]:unknown};
  }
  proxy(req:IncomingMessage,res:ServerResponse,completion?:{settled:()=>void;uncertain:()=>void},mapJson?:(value:unknown)=>Promise<unknown>,replayBody?:Buffer):void {
    const c=this.connection;
    if(!c || this.stopping){res.writeHead(503);res.end('{"error":"legacy_unavailable"}');completion?.settled();return;}
    let finished=false;
    let timer:NodeJS.Timeout|undefined;
    const finish=(known:boolean)=>{if(finished)return;finished=true;clearTimeout(timer);if(known)completion?.settled();else completion?.uncertain();};
    const upstream=request(`http://${c.address}${req.url}`,{method:req.method,headers:{...req.headers,host:c.address,authorization:`Bearer ${c.token}`}},response=>{
      response.once('aborted',()=>finish(false));response.once('error',()=>finish(false));
      if(mapJson && response.statusCode===200){
        const chunks:Buffer[]=[];let bytes=0;
        response.on('data',(chunk:Buffer)=>{
          bytes+=chunk.length;
          if(bytes>4_194_304){upstream.destroy(new Error('sync_status_too_large'));return;}
          chunks.push(chunk);
        });
        response.once('end',()=>{
          clearTimeout(timer);
          void (async()=>{
            try{
              const value=parseJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
              const body=stringifyJson(await mapJson(value));
              if(!res.destroyed){
                const headers={...response.headers,'cache-control':'no-store','content-length':String(Buffer.byteLength(body))};
                delete headers['transfer-encoding'];
                res.writeHead(200,headers);res.end(body);
              }
            }catch{
              if(!res.destroyed){res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});res.end('{"error":"sync_status_unavailable"}');}
            }finally{finish(true);}
          })();
        });
      }else{
        response.once('end',()=>finish(true));
        if(!res.destroyed){res.writeHead(response.statusCode??502,{...response.headers,'cache-control':'no-store'});response.pipe(res);}
      }
      // 下游离开后仍排空完整上游响应；只有业务端确认结束才释放身份变更门。
      if(completion){res.once('close',()=>response.resume());response.resume();}
    });
    // 连接中断不重放请求，停止/取消仍沿原业务HTTP合同执行。
    upstream.on('error',()=>{finish(false);if(!res.destroyed){if(!res.headersSent)res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"legacy_unavailable"}');}});
    if(completion){
      timer=setTimeout(()=>{finish(false);upstream.destroy();},30000);timer.unref();
      req.once('aborted',()=>{finish(false);upstream.destroy();});
    }else res.once('close',()=>upstream.destroy());
    if(replayBody)upstream.end(replayBody);
    else req.pipe(upstream);
  }
  async stop():Promise<void>{
    if(this.stopping)return this.exited;
    this.stopping=true;
    if(!this.child.pid || this.child.exitCode!==null || this.child.signalCode!==null)return;
    try{await this.control('/api/runtime/shutdown','POST');}catch{}
    if(this.child.exitCode===null && this.child.signalCode===null)this.child.kill('SIGTERM');
    let timer:NodeJS.Timeout|undefined;
    try{await Promise.race([this.exited,new Promise<void>(resolve=>{timer=setTimeout(()=>{this.child.kill('SIGKILL');resolve();},6000);})]);}
    finally{clearTimeout(timer);}
    await this.exited;
  }
}
export function legacyRoute(url:string):boolean{
  return /^\/api\/(contacts(?:\/|\?|$)|reply(?:\/|$)|memory(?:\/|$)|memories(?:\/|\?|$)|expression-preferences(?:\/|\?|$)|layered-memory(?:\/|$)|owner(?:\/|$)|owners(?:\/|$)|skills(?:\/|\?|$)|sync(?:\/|$)|imports(?:\/|$)|tasks(?:\/|$)|ledger(?:\/|$)|events(?:\/|$)|setup\/wechat(?:\/|$)|settings(?:\/|$)|runtime\/[^/]+)/.test(url);
}
