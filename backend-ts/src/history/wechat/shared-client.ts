import {AsyncLocalStorage} from 'node:async_hooks';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {NarrowWechatClient,type NarrowWechatClientOptions} from './native-client.ts';

export interface SharedWechatLease {client:NarrowWechatClient;release():Promise<void>}
type Owner=object|string;
/** 整次业务读取独占一个原生进程；换联系人前先解除旧租约，再清空原生会话状态。 */
export class SharedWechatClient {
 readonly #loadOptions:()=>Promise<NarrowWechatClientOptions>;
 readonly #context=new AsyncLocalStorage<{client:NarrowWechatClient;active:boolean}>();
 #client?:NarrowWechatClient;
 #tail:Promise<void>=Promise.resolve();
 #owner?:Owner;
 #releaseOwner?:()=>Promise<void>;
 #epoch=0;
 #closed=false;
 #stopping?:Promise<void>;
 constructor(loadOptions:()=>Promise<NarrowWechatClientOptions>){this.#loadOptions=loadOptions;}
 get current():NarrowWechatClient|undefined{const context=this.#context.getStore();return context?.active?context.client:undefined;}
 async acquire(owner:Owner,releasePreviousOwner?:()=>Promise<void>,signal?:AbortSignal):Promise<SharedWechatLease>{
  if(this.#closed||this.#stopping)throw new StorageFailure('history_native_closed');
  if(signal?.aborted)throw new StorageFailure('history_native_cancelled');
  const epoch=this.#epoch,previous=this.#tail;
  let unlock!:()=>void;const gate=new Promise<void>(resolve=>{unlock=resolve;});
  this.#tail=previous.then(()=>gate);
  let rejectAbort!:(error:unknown)=>void;
  const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
  const abort=()=>rejectAbort(new StorageFailure('history_native_cancelled'));
  signal?.addEventListener('abort',abort,{once:true});
  let ownsTurn=false;
  try{
   await Promise.race([previous,aborted]);
   ownsTurn=true;
   if(signal?.aborted)throw new StorageFailure('history_native_cancelled');
   if(this.#closed||epoch!==this.#epoch)throw new StorageFailure('history_native_closed');
   if(this.#owner!==owner||this.#client?.stoppedReason){
    const release=this.#releaseOwner;this.#releaseOwner=undefined;this.#owner=undefined;
    await release?.();
    if(this.#client?.stoppedReason){await this.#client.close();this.#client=undefined;}
    else if(this.#client)try{await this.#client.releaseSelection(signal);}catch(error){await this.#client.close();this.#client=undefined;throw error;}
   }
   if(!this.#client){
    const options=await this.#loadOptions();
    if(this.#closed||epoch!==this.#epoch||signal?.aborted)throw new StorageFailure('history_native_cancelled');
    this.#client=new NarrowWechatClient(options);
   }
   this.#owner=owner;this.#releaseOwner=releasePreviousOwner;
   let released=false;
   return {client:this.#client,release:async()=>{if(!released){released=true;unlock();}}};
  }catch(error){if(ownsTurn&&this.#client){await this.#client.close();this.#client=undefined;}void previous.then(unlock);throw error;}
  finally{signal?.removeEventListener('abort',abort);}
 }
 async run<T>(owner:Owner,work:(client:NarrowWechatClient)=>Promise<T>,releasePreviousOwner?:()=>Promise<void>,signal?:AbortSignal):Promise<T>{
  const lease=await this.acquire(owner,releasePreviousOwner,signal);
  const context={client:lease.client,active:true};
  try{return await this.#context.run(context,()=>work(lease.client));}finally{context.active=false;await lease.release();}
 }
 stop():Promise<void>{
  if(this.#stopping)return this.#stopping;
  this.#epoch++;
  return this.#stopping=(async()=>{
   await this.#client?.close();
   await this.#tail;
   const release=this.#releaseOwner;this.#releaseOwner=undefined;this.#owner=undefined;
   await release?.();this.#client=undefined;
  })().finally(()=>{this.#stopping=undefined;});
 }
 async close():Promise<void>{this.#closed=true;await this.stop();}
}
