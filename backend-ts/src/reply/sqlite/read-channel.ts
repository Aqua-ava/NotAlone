import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import {StorageFailure,type StorageReader} from '../../storage/sqlite/contracts.ts';
import type {ActiveHolders} from '../../storage/sqlite/deletion/holders.ts';
import {randomUUID} from 'node:crypto';

// 仅供助手回看；生成受理、编辑、选择、来源冻结和最终资格仍交给唯一写者。
export const assistantReadActions=[
 'discussion.list','discussion.view','discussion.trace',
 'reply.view','reply.status','reply.version','reply.skillInputs','history.readRecent',
 'deletion.list','deletion.status',
] as const;
const allowed=new Set<string>(assistantReadActions),metadata=new Set(['deletion.list','deletion.status']);
const terminal=new Set(['readonly_closed','stale_lease','storage_identity_changed','unsafe_storage_path','storage_missing','schema_drift','migration_drift','worker_failed','assistant_read_invalidated','assistant_read_scope_unavailable','discussion_deletion_pending','deletion_holder_fenced']);
type Options={storage:Pick<SqliteStorage,'openReader'>;ownerId:string;holders:ActiveHolders};
interface ReaderSlot {reader:StorageReader;controller:AbortController;closing?:Promise<void>}
interface ReadBoundary {generation:bigint;revision:string}
const invalidated=()=>new StorageFailure('assistant_read_invalidated');

class AssistantReadChannel implements StorageReader {
 private readonly options:Options;
 private slot?:ReaderSlot;
 private opening?:Promise<ReaderSlot>;
 private closed=false;
 private version=0;
 private closing?:Promise<void>;
 private readonly pending=new Set<Promise<unknown>>();
 private readonly retiring=new Set<ReaderSlot>();
 constructor(options:Options){this.options=options;}
 async ready():Promise<void>{await this.current();}
 private current():Promise<ReaderSlot>{
  if(this.closed)return Promise.reject(new StorageFailure('readonly_closed'));
  if(this.slot)return Promise.resolve(this.slot);
  if(this.opening)return this.opening;
  const version=this.version;
  const opening=this.options.storage.openReader([...assistantReadActions,'discussion.readBoundary']).then(async reader=>{
   const slot={reader,controller:new AbortController()};
   if(this.closed||version!==this.version){await this.retire(slot);throw invalidated();}
   this.slot=slot;return slot;
  }).finally(()=>{if(this.opening===opening)this.opening=undefined;});
  this.opening=opening;return opening;
 }
 private assertCurrent(slot:ReaderSlot):void{if(this.closed||slot!==this.slot)throw invalidated();}
 private read<T>(slot:ReaderSlot,name:string,input:unknown):Promise<T>{
  const signal=slot.controller.signal;if(signal.aborted)return Promise.reject(invalidated());
  return new Promise((resolve,reject)=>{
   const abort=()=>{signal.removeEventListener('abort',abort);reject(invalidated());};
   signal.addEventListener('abort',abort,{once:true});
   try{slot.reader.execute<T>(name,input).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});}
   catch(error){signal.removeEventListener('abort',abort);reject(error);}
  });
 }
 private retire(slot:ReaderSlot):Promise<void>{
  if(this.slot===slot){this.slot=undefined;this.version++;}
  slot.controller.abort();
  if(!slot.closing){
   // 退休后仍保留关闭责任；明确失败允许删除或宿主退出重试，确认关闭才移除。
   this.retiring.add(slot);
   slot.closing=Promise.resolve().then(()=>slot.reader.close()).then(()=>{this.retiring.delete(slot);},error=>{slot.closing=undefined;throw error;});
  }
  return slot.closing;
 }
 execute<T=unknown>(name:string,input:unknown):Promise<T>{
  if(this.closed)return Promise.reject(new StorageFailure('readonly_closed'));
  if(!allowed.has(name))return Promise.reject(new StorageFailure('readonly_action_forbidden'));
  if(!input||typeof input!=='object'||Array.isArray(input)||(input as {ownerId?:unknown}).ownerId!==this.options.ownerId)return Promise.reject(new StorageFailure('assistant_read_scope_invalid'));
  const work=this.executeOwned<T>(name,input as Record<string,unknown>);this.pending.add(work);work.then(()=>this.pending.delete(work),()=>this.pending.delete(work));return work;
 }
 private async executeOwned<T>(name:string,input:Record<string,unknown>):Promise<T>{
  const slot=await this.current();
  try{
   if(metadata.has(name)){const value=await this.read<T>(slot,name,input);this.assertCurrent(slot);return value;}
   if(typeof input.contactId!=='string'||!input.contactId)throw new StorageFailure('assistant_read_scope_invalid');
   const scope={ownerId:this.options.ownerId,contactId:input.contactId,...(input.discussionId===undefined?{}:{discussionId:input.discussionId})};
   const before=await this.read<ReadBoundary>(slot,'discussion.readBoundary',scope);this.assertCurrent(slot);
   let finished=false,cancelled=false;
   const release=this.options.holders.register({key:'assistant-read:'+randomUUID(),scopeKeys:typeof input.discussionId==='string'?['discussion:'+input.discussionId]:[],ownerId:this.options.ownerId,contactId:input.contactId,generation:before.generation,coversAllSources:true,
    close:async()=>{if(!finished)cancelled=true;if(cancelled)await this.retire(slot);}});
   try{
    const value=await this.read<T>(slot,name,input);this.assertCurrent(slot);
    const after=await this.read<ReadBoundary>(slot,'discussion.readBoundary',scope);this.assertCurrent(slot);
    if(cancelled||before.generation!==after.generation||before.revision!==after.revision)throw invalidated();
    return value;
   }catch(error){
    if(terminal.has((error as {code?:string})?.code??''))cancelled=true;
    else try{
     // 业务动作也可能先看到失效；再核范围，不能把普通会话不存在当成所有者失效。
     const after=await this.read<ReadBoundary>(slot,'discussion.readBoundary',scope);this.assertCurrent(slot);
     if(before.generation!==after.generation||before.revision!==after.revision)cancelled=true;
    }catch(boundaryError){if(terminal.has((boundaryError as {code?:string})?.code??''))cancelled=true;}
    throw error;
   }
   finally{finished=true;await release();}
  }catch(error){const code=(error as {code?:string})?.code??'';if(terminal.has(code))await this.retire(slot);throw code==='assistant_read_scope_unavailable'?new StorageFailure('discussion_unavailable'):error;}
 }
 close():Promise<void>{
  this.closed=true;this.version++;
  return this.closing??=(async()=>{
   const slot=this.slot,opening=this.opening,attempts=new Set<Promise<unknown>>();
   if(slot)attempts.add(this.retire(slot));
   for(const retired of this.retiring)attempts.add(this.retire(retired));
   if(opening)attempts.add(opening.then(current=>this.retire(current),()=>{}));
   const results=await Promise.allSettled(attempts);
   await Promise.allSettled([...this.pending]);
   const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
   await Promise.all([...this.retiring].map(retired=>this.retire(retired)));
  })().catch(error=>{this.closing=undefined;throw error;});
 }
}

/** 独立于前台身份定位的同库只读通道，沿用唯一存储所有者的运行租约。 */
export async function createAssistantReadChannel(options:Options):Promise<StorageReader>{
 const channel=new AssistantReadChannel(options);await channel.ready();return channel;
}
