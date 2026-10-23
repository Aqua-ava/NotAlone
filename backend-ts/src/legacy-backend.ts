import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { captureProcessIdentity } from './process-identity.ts';
import { setTimeout as delay } from 'node:timers/promises';

/** 迁移期唯一旧业务执行方；03不转移联系人、回复、同步、任务和删除的写入权。 */
export const ownership = Object.freeze({setup:'typescript',credentials:'typescript',schemaUpdates:'python-migration-command',contacts:'python',replies:'python',memory:'python',skills:'python',imports:'python',deletion:'python',wechat:'python',tasks:'python'});
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
  async control(endpoint:string,method:string,body?:Record<string,string>):Promise<{state?:string;active_requests?:number}>{
    const c=this.connection;if(!c)throw new Error('LEGACY_NOT_READY');
    const response=await fetch(`http://${c.address}${endpoint}`,{method,headers:{Authorization:`Bearer ${c.token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5500),redirect:'error'});
    if(!response.ok)throw new Error('LEGACY_CONTROL_FAILED');
    return await response.json() as {state?:string;active_requests?:number};
  }
  proxy(req:IncomingMessage,res:ServerResponse):void {
    const c=this.connection;
    if(!c || this.stopping){res.writeHead(503);res.end('{"error":"legacy_unavailable"}');return;}
    const upstream=request(`http://${c.address}${req.url}`,{method:req.method,headers:{...req.headers,host:c.address,authorization:`Bearer ${c.token}`}},response=>{
      res.writeHead(response.statusCode??502,{...response.headers,'cache-control':'no-store'});response.pipe(res);
    });
    // 连接中断不重放请求，停止/取消仍沿原业务HTTP合同执行。
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"legacy_unavailable"}');});
    res.once('close',()=>upstream.destroy());req.pipe(upstream);
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
