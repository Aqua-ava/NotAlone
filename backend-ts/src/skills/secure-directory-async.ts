import {Worker} from 'node:worker_threads';
import {lstatSync} from 'node:fs';
import {SecureSkillReadError,type SecureSkillDirectory} from './secure-directory.ts';
import {canonicalRoot} from './skill-package.ts';

type Snapshot=ReturnType<SecureSkillDirectory['snapshot']>;
type Pending={resolve:(value:any)=>void;reject:(error:unknown)=>void;cancelled:Int32Array;timer:NodeJS.Timeout;detach:()=>void};
/** 每个授权根使用独立只读线程；取消只丢弃读取，不产生迟到数据库操作。 */
export class AsyncSecureSkillDirectory{
 private readonly root:string;private readonly readerBinary?:string;private readonly rootIdentity:readonly[string,string];
 private worker?:Worker;private nextId=0;private retiring?:Promise<void>;private closing?:Promise<void>;
 private readonly pending=new Map<number,Pending>();
 constructor(root:string,readerBinary?:string){
  this.root=canonicalRoot(root);this.readerBinary=readerBinary;
  // 构造时只冻结根身份；完整逐段链接与字节校验仍由原生读取路径完成。
  try{const info=lstatSync(this.root,{bigint:true});if(!info.isDirectory()||info.isSymbolicLink())throw new SecureSkillReadError('skill_package_invalid');this.rootIdentity=[info.dev.toString(),info.ino.toString()];}
  catch(error){if(error instanceof SecureSkillReadError)throw error;throw new SecureSkillReadError('skill_directory_unavailable');}
 }
 names(signal?:AbortSignal):Promise<string[]>{return this.invoke('names',undefined,undefined,signal);}
 directoryIdentity(name:string,signal?:AbortSignal):Promise<string>{return this.invoke('identity',name,undefined,signal);}
 async snapshot(name:string,expectedIdentity:string,signal?:AbortSignal):Promise<Snapshot>{
  const snapshot=await this.invoke<Snapshot>('snapshot',name,expectedIdentity,signal);
  // structured clone 将 Buffer 传成 Uint8Array；仅恢复字节容器，不重新解析或扩大资源范围。
  return {...snapshot,document:Buffer.from(snapshot.document),pkg:{...snapshot.pkg,
   resources:snapshot.pkg.resources.map(resource=>({...resource,content:Buffer.from(resource.content)}))}};
 }
 close():Promise<void>{
  if(this.closing)return this.closing;
  return this.closing=this.worker?this.retire(this.worker):Promise.resolve();
 }
 private start():Worker{
  if(this.worker)return this.worker;
  const worker=new Worker(new URL('./secure-directory-worker.ts',import.meta.url),{
   workerData:{root:this.root,readerBinary:this.readerBinary,rootIdentity:this.rootIdentity},execArgv:['--experimental-strip-types'],env:{PATH:'/usr/bin:/bin'},
  });
  this.worker=worker;
  worker.on('message',message=>{
   if(this.worker!==worker||this.retiring)return;
   if(message.fatal){void this.retire(worker,message.code);return;}
   const pending=this.pending.get(message.id);if(!pending)return;
   if(message.started){clearTimeout(pending.timer);pending.timer=setTimeout(()=>{void this.retire(worker);},6000);return;}
   this.pending.delete(message.id);clearTimeout(pending.timer);pending.detach();
   if(!Atomics.load(pending.cancelled,0)){
    if(message.code)pending.reject(new SecureSkillReadError(message.code));else pending.resolve(message.value);
   }
   if(!this.pending.size)worker.unref();
  });
  worker.on('error',()=>{void this.retire(worker);});worker.on('exit',()=>{void this.retire(worker);});
  return worker;
 }
 private async invoke<T>(operation:'names'|'identity'|'snapshot',name?:string,expectedIdentity?:string,signal?:AbortSignal):Promise<T>{
  if(this.closing)throw new SecureSkillReadError('skill_reader_unavailable');
  signal?.throwIfAborted();
  // 故障实例确认终止后才可复用邮箱，并以构造时冻结的根身份重建线程。
  if(this.retiring)await this.retiring;
  if(this.closing)throw new SecureSkillReadError('skill_reader_unavailable');
  signal?.throwIfAborted();
  if(this.pending.size>=32)return Promise.reject(new SecureSkillReadError('skill_reader_busy'));
  const worker=this.start(),id=++this.nextId,cancelled=new Int32Array(new SharedArrayBuffer(4));
  worker.ref();
  return new Promise((resolve,reject)=>{
   const abort=()=>{
    const pending=this.pending.get(id);if(!pending)return;
    // 已投递项仍占用额度和超时，收到线程完成确认后才释放真实邮箱位置。
    Atomics.store(cancelled,0,1);pending.detach();reject(signal!.reason);
   };
   const pending:Pending={resolve,reject,cancelled,timer:setTimeout(()=>{
    // 排队超时只取消此项；线程确认跳过前仍占真实邮箱额度。
    Atomics.store(cancelled,0,1);pending.detach();reject(new SecureSkillReadError('skill_reader_unavailable'));
   },10000),
    detach:()=>signal?.removeEventListener('abort',abort)};
   this.pending.set(id,pending);signal?.addEventListener('abort',abort,{once:true});
   try{worker.postMessage({id,operation,name,expectedIdentity,cancelled:cancelled.buffer});}
   catch{void this.retire(worker);}
  });
 }
 private retire(worker:Worker,code='skill_reader_unavailable'):Promise<void>{
  if(this.worker!==worker)return Promise.resolve();
  if(this.retiring)return this.retiring;
  for(const pending of this.pending.values()){
   Atomics.store(pending.cancelled,0,1);clearTimeout(pending.timer);pending.detach();pending.reject(new SecureSkillReadError(code));
  }
  return this.retiring=worker.terminate().then(()=>{
   this.pending.clear();this.worker=undefined;this.retiring=undefined;
  });
 }
}
