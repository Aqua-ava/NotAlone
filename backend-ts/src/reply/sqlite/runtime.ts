import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,readdir,lstat,open} from 'node:fs/promises';
import path from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import {SessionId} from '@deepseek-ai/dsh-session';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import type {ActiveHolders} from '../../storage/sqlite/deletion/holders.ts';
import {ManagedFiles} from '../../storage/sqlite/deletion/managed-files.ts';
import type {ManagedAddress} from '../../storage/sqlite/deletion/contracts.ts';
import type {DiscussionAttempt,RuntimeCopy} from './contracts.ts';
import {createDshRuntime,type DshRuntimeDriver,type DshEventBoundary} from './dsh-runtime.ts';
interface HeldCopy {copy:RuntimeCopy;controller:AbortController;driver?:DshRuntimeDriver;workDone:Promise<void>;finish:()=>void;release:()=>Promise<void>;busy:boolean}
export interface RuntimeWork {copy:RuntimeCopy;driver:DshRuntimeDriver;sessionId:SessionId;restoring:boolean;signal:AbortSignal}
type Fault=(point:'beforeDirectory'|'afterDirectory'|'beforeIdentity'|'afterIdentity'|'afterBusinessCommit'|'beforeClose'|'afterClose'|'beforeReady'|'afterDiscardFile'|'beforeDiscardCommit')=>void|Promise<void>;
function fail(code:string):never{throw new StorageFailure(code);}
const same=(a:ManagedAddress,b:ManagedAddress)=>JSON.stringify(a)===JSON.stringify(b);
/** 每副本独占所有者；所有文件操作均在SQLite短事务外进行。 */
export class SqliteDiscussionRuntime {
 private readonly storage:SqliteStorage;private readonly ownerId:string;private readonly userData:string;private readonly ctx:Context;private readonly holders:ActiveHolders;private readonly files:ManagedFiles;private readonly held=new Map<string,HeldCopy>();private stopping=false;private readonly pending=new Set<Promise<unknown>>();private closing?:Promise<void>;private readonly fault?:Fault;
 constructor(options:{storage:SqliteStorage;ownerId:string;userData:string;ctx:Context;holders:ActiveHolders;fault?:Fault}){this.storage=options.storage;this.ownerId=options.ownerId;this.userData=options.userData;this.ctx=options.ctx;this.holders=options.holders;this.files=new ManagedFiles(options.userData);this.fault=options.fault;}
 private location(copy:RuntimeCopy){return path.join(this.userData,'managed/runtime-copies',copy.managedLocator);}
 private execute<T=any>(name:string,copy:RuntimeCopy,input:object={}):Promise<T>{return this.storage.execute(`runtime.${name}`,{ownerId:this.ownerId,contactId:copy.contactId,discussionId:copy.discussionId,copyId:copy.id,...input});}
 async initialize():Promise<void>{this.files.prepareArea('runtime');for(const copy of await this.storage.execute<RuntimeCopy[]>('runtime.inventory',{ownerId:this.ownerId})){if(copy.state==='blocked'&&copy.cleanupOperationId?.startsWith('skill-discard:'))await this.finishDiscard(copy);else this.bind(copy);}}
 private marker(copy:RuntimeCopy){return JSON.stringify({format:1,databaseId:this.storage.status.databaseId,copyId:copy.id,sessionId:copy.sdkInstanceId,contactId:copy.contactId,discussionId:copy.discussionId,writeGeneration:String(copy.writeGeneration)});}
 private async syncDirectory(location:string){const fd=await open(location,'r');try{await fd.sync();}finally{await fd.close();}}
 private async capture(copy:RuntimeCopy):Promise<void>{
  let actual:ManagedAddress;
  try{actual=this.files.capture('runtime',copy.managedLocator,'directory');}
  catch(error){
   if((error as NodeJS.ErrnoException).code==='ENOENT'&&copy.address===null){await this.execute('manifest',copy,{rootAbsent:true,files:[]});return;}
   throw error;
  }
  if(copy.address&&!same(copy.address,actual))fail('discussion_runtime_identity_conflict');
  if(!copy.address){
   if((await readdir(this.location(copy))).some(name=>name!=='.notalone-copy'))fail('discussion_runtime_identity_conflict');
   // 崩溃只凭同一持久创建意图和私有marker恢复清理，绝不直接恢复执行。
   const marker=await lstat(path.join(this.location(copy),'.notalone-copy'),{bigint:true});
   if(!marker.isFile()||marker.isSymbolicLink()||marker.nlink!==1n||marker.uid!==BigInt(process.getuid!())||(marker.mode&0o077n)!==0n||await readFile(path.join(this.location(copy),'.notalone-copy'),'utf8')!==this.marker(copy))fail('discussion_runtime_identity_conflict');
  }
  if(!copy.address||copy.state==='preparing')copy=await this.execute<RuntimeCopy>('attach',copy,{address:actual,cleanupOnly:true});
  const manifest:ManagedAddress[]=[];
  const walk=async(locator:string)=>{
   const root=this.files.capture('runtime',locator,'directory');manifest.push(root);
   for(const name of await readdir(path.join(this.userData,'managed/runtime-copies',locator))){
    const item=path.join(this.userData,'managed/runtime-copies',locator,name),s=await lstat(item,{bigint:true});
    if(s.isSymbolicLink()||!s.isDirectory()&&!s.isFile())fail('discussion_runtime_identity_conflict');
    if(s.isDirectory())await walk(`${locator}/${name}`);else manifest.push(this.files.capture('runtime',`${locator}/${name}`));
   }
  };
  await walk(copy.managedLocator);if(!same(this.files.capture('runtime',copy.managedLocator,'directory'),actual))fail('discussion_runtime_identity_conflict');
  await this.execute('manifest',copy,{rootAbsent:false,files:manifest});
 }
 private bind(copy:RuntimeCopy):HeldCopy{
  const prior=this.held.get(copy.id);if(prior)return prior;
  const done=Promise.withResolvers<void>();done.resolve();
  const held:HeldCopy={copy,controller:new AbortController(),workDone:done.promise,finish:done.resolve,busy:false,release:async()=>{}};
  held.release=this.holders.register({key:`runtime:${copy.id}`,ownerId:this.ownerId,contactId:copy.contactId,generation:copy.dataGeneration,close:async()=>{
   held.controller.abort();await held.workDone;await this.fault?.('beforeClose');await held.driver?.close();held.driver=undefined;
   await this.fault?.('afterClose');await this.capture(held.copy);this.held.delete(copy.id);
  }});
  this.held.set(copy.id,held);return held;
 }
 private track<T>(work:()=>Promise<T>):Promise<T>{
  if(this.stopping)return Promise.reject(new StorageFailure('discussion_runtime_closed'));
  const pending=work();this.pending.add(pending);pending.then(()=>this.pending.delete(pending),()=>this.pending.delete(pending));return pending;
 }
 inspect(contactId:string,discussionId:string,copyId:string,configurationDigest:string){return this.track(()=>this.inspectOwned(contactId,discussionId,copyId,configurationDigest));}
 run<T>(attempt:DiscussionAttempt,configurationDigest:string,work:(input:RuntimeWork)=>Promise<T>,signal?:AbortSignal,fresh=false):Promise<T>{return this.track(()=>this.runOwned(attempt,configurationDigest,work,signal,fresh));}
 /** 仅销毁本次尚未提交且已排空的运行副本；原Skill目录不在受管区。 */
 discard(attempt:DiscussionAttempt,copyId:string):Promise<void>{return this.track(async()=>{
  if(this.held.has(copyId))fail('discussion_runtime_busy');
  const copy=(await this.storage.execute<RuntimeCopy[]>('runtime.inventory',{ownerId:this.ownerId})).find(c=>c.id===copyId);
  if(!copy||copy.contactId!==attempt.contactId||copy.discussionId!==attempt.discussionId||copy.state!=='dirty'||copy.committedRequestId!==null||!copy.manifestComplete)fail('discussion_runtime_discard_forbidden');
  await this.capture(copy);
  await this.storage.execute('runtime.beginDiscard',{...attempt,copyId});
  await this.finishDiscard(copy);
 });}
 private async finishDiscard(copy:RuntimeCopy):Promise<void>{
  const files=await this.execute<{fileId:string;address:ManagedAddress}[]>('discardManifest',copy);
  for(const file of files.sort((a,b)=>b.address.locator.split('/').length-a.address.locator.split('/').length)){
   await this.execute('discardCurrent',copy);this.files.erase(file.address);await this.fault?.('afterDiscardFile');
   if(!this.files.verifyAbsent(file.address))fail('discussion_runtime_discard_failed');
   await this.execute('discardFile',copy,{fileId:file.fileId});
  }
  await this.fault?.('beforeDiscardCommit');await this.execute('discard',copy);
 }
 private async inspectOwned(contactId:string,discussionId:string,copyId:string,configurationDigest:string):Promise<{copy:RuntimeCopy;boundary:DshEventBoundary}>{
  if(this.stopping)fail('discussion_runtime_closed');
  const copy=await this.storage.execute<RuntimeCopy>('runtime.inspect',{ownerId:this.ownerId,contactId,discussionId,copyId});
  if(copy.state!=='ready'||copy.configurationDigest!==configurationDigest||!copy.address||!copy.eventBoundary)fail('discussion_runtime_recovery_blocked');
  if(!same(this.files.capture('runtime',copy.managedLocator,'directory'),copy.address))fail('discussion_runtime_identity_conflict');
  if(this.stopping)fail('discussion_runtime_closed');
  if(this.stopping)fail('discussion_runtime_closed');
  const held=this.bind(copy);if(held.busy)fail('discussion_runtime_busy');held.busy=true;
  const done=Promise.withResolvers<void>();held.workDone=done.promise;held.finish=done.resolve;
  try{
   const driver=await createDshRuntime(this.ctx,{root:this.location(copy)});held.driver=driver;
   const history=await driver.readHistory(SessionId(copy.sdkInstanceId));
   if(JSON.stringify(history.boundary)!==copy.eventBoundary)fail('discussion_runtime_recovery_blocked');
   await this.execute('inspect',copy);return {copy,boundary:history.boundary};
  }finally{done.resolve();await held.release();}
 }
 private async runOwned<T>(attempt:DiscussionAttempt,configurationDigest:string,work:(input:RuntimeWork)=>Promise<T>,signal?:AbortSignal,fresh=false):Promise<T>{
  if(this.stopping)fail('discussion_runtime_closed');signal?.throwIfAborted();
  const discussion=await this.storage.execute<any>('discussion.view',attempt);if(this.stopping)fail('discussion_runtime_closed');
  let copy:RuntimeCopy|undefined;
  if(!fresh&&discussion.discussion.currentRuntimeId){
   try{
    const candidate=await this.storage.execute<RuntimeCopy>('runtime.inspect',{...attempt,copyId:discussion.discussion.currentRuntimeId});
    if(candidate.state==='ready'&&candidate.configurationDigest===configurationDigest){await this.inspect(attempt.contactId,attempt.discussionId,candidate.id,configurationDigest);copy=candidate;}
   }catch(error){
    // 当前明确请求可从仍合法业务记录另建副本；旧定位和不合格文件继续保留在删除闭包。
    if(!(error instanceof StorageFailure)||!['discussion_runtime_invalidated','discussion_runtime_recovery_blocked'].includes(error.code))throw error;
   }
  }
  let restoring=!!copy;
  if(!copy){const id=randomUUID();copy=await this.storage.execute<RuntimeCopy>('runtime.prepare',{...attempt,copyId:id,sdkInstanceId:randomUUID(),locator:id,configurationDigest});}
  if(this.stopping)fail('discussion_runtime_closed');
  const held=this.bind(copy);if(held.busy)fail('discussion_runtime_busy');held.busy=true;const done=Promise.withResolvers<void>();held.workDone=done.promise;held.finish=done.resolve;
  const combined=signal?AbortSignal.any([signal,held.controller.signal]):held.controller.signal;
  let result!:T,boundary:DshEventBoundary|undefined,succeeded=false;
  try{
   if(restoring)await this.execute('dirty',copy,attempt);
   else{
    await this.fault?.('beforeDirectory');combined.throwIfAborted();
    await mkdir(this.location(copy),{mode:0o700});
    const createdAddress=this.files.capture('runtime',copy.managedLocator,'directory');held.copy={...copy,address:createdAddress};
    await this.fault?.('afterDirectory');
    if(!same(this.files.capture('runtime',copy.managedLocator,'directory'),createdAddress))fail('discussion_runtime_identity_conflict');
    const marker=path.join(this.location(copy),'.notalone-copy');await writeFile(marker,this.marker(copy),{flag:'wx',mode:0o600});const fd=await open(marker,'r');try{await fd.sync();}finally{await fd.close();}
    await this.syncDirectory(this.location(copy));await this.syncDirectory(path.dirname(this.location(copy)));await this.fault?.('beforeIdentity');
    copy=await this.execute<RuntimeCopy>('attach',copy,{...attempt,address:this.files.capture('runtime',copy.managedLocator,'directory')});held.copy=copy;await this.fault?.('afterIdentity');
   }
   combined.throwIfAborted();await this.execute('inspect',copy);
   held.driver=await createDshRuntime(this.ctx,{root:this.location(copy)});
   result=await work({copy,driver:held.driver,sessionId:SessionId(copy.sdkInstanceId),restoring,signal:combined});
   combined.throwIfAborted();await this.fault?.('afterBusinessCommit');
   // 官方readHistory要求Agent先由实际业务释放；driver.close再次覆盖所有遗漏所有者。
   await held.driver.close();held.driver=undefined;
   const checker=await createDshRuntime(this.ctx,{root:this.location(copy)});held.driver=checker;
   boundary=(await checker.readHistory(SessionId(copy.sdkInstanceId))).boundary;await checker.close();held.driver=undefined;succeeded=true;
  }finally{done.resolve();await held.release();}
  if(succeeded){await this.fault?.('beforeReady');await this.execute('ready',copy,{...attempt,eventBoundary:JSON.stringify(boundary),configurationDigest});}
  return result;
 }
 close():Promise<void>{
  this.stopping=true;for(const held of this.held.values())held.controller.abort();
  return this.closing??=(async()=>{await Promise.allSettled([...this.pending]);await Promise.all([...this.held.values()].map(held=>held.release()));})().catch(error=>{this.closing=undefined;throw error;});
 }
}
