import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import {StorageFailure,type StorageReader} from '../../storage/sqlite/contracts.ts';
import type {ActiveHolders} from '../../storage/sqlite/deletion/holders.ts';
import {randomUUID} from 'node:crypto';

// 仅供助手回看；生成受理、编辑、选择、来源冻结和最终资格仍交给唯一写者。
export const assistantReadActions=[
 'discussion.list','discussion.view','discussion.trace',
 'reply.view','reply.status','reply.version','reply.skillInputs','reply.inputs','history.readRecent',
 'deletion.list','deletion.status',
] as const;
const allowed=new Set<string>(assistantReadActions),metadata=new Set(['deletion.list','deletion.status']);
const candidateActions=new Set<string>(['reply.view','reply.version','reply.skillInputs','reply.inputs','history.readRecent']);
const terminal=new Set(['readonly_closed','stale_lease','storage_identity_changed','unsafe_storage_path','storage_missing','schema_drift','migration_drift','worker_failed','assistant_read_invalidated','assistant_read_scope_unavailable','discussion_deletion_pending','deletion_holder_fenced']);
type Options={storage:Pick<SqliteStorage,'openReader'>;ownerId:string;holders:ActiveHolders};
type Lane='discussion'|'candidate';
interface ReaderSlot {lane:Lane;reader:StorageReader;controller:AbortController;closing?:Promise<void>}
interface ReaderLane {slot?:ReaderSlot;opening?:Promise<ReaderSlot>;version:number}
interface ReadBoundary {generation:bigint;revision:string}
const invalidated=()=>new StorageFailure('assistant_read_invalidated');

class AssistantReadChannel implements StorageReader {
 private readonly options:Options;
 // 固定两类读者，候选重核验不能阻塞轻讨论与请求状态；不按联系人或请求增加线程。
 private readonly lanes:Record<Lane,ReaderLane>={discussion:{version:0},candidate:{version:0}};
 private closed=false;
 private closing?:Promise<void>;
 private readonly pending=new Set<Promise<unknown>>();
 private readonly retiring=new Set<ReaderSlot>();
 private readonly retiringOpenings=new Set<Promise<ReaderSlot>>();
 private invalidating?:Promise<void>;
 constructor(options:Options){this.options=options;}
 async ready():Promise<void>{await this.current('discussion');}
 private current(lane:Lane):Promise<ReaderSlot>{
  if(this.closed)return Promise.reject(new StorageFailure('readonly_closed'));
  if(this.invalidating)return this.invalidating.then(()=>this.current(lane));
  if(this.retiring.size||this.retiringOpenings.size)return this.retireAll().then(()=>this.current(lane));
  const state=this.lanes[lane];
  if(state.slot)return Promise.resolve(state.slot);
  if(state.opening)return state.opening;
  const version=state.version,actions=assistantReadActions.filter(name=>candidateActions.has(name)===(lane==='candidate'));
  const opening=this.options.storage.openReader([...actions,'discussion.readBoundary']).then(async reader=>{
   const slot:ReaderSlot={lane,reader,controller:new AbortController()};
   if(this.closed||version!==state.version){await this.retire(slot);throw invalidated();}
   state.slot=slot;return slot;
  }).finally(()=>{if(state.opening===opening)state.opening=undefined;});
  state.opening=opening;return opening;
 }
 private assertCurrent(slot:ReaderSlot):void{if(this.closed||slot!==this.lanes[slot.lane].slot)throw invalidated();}
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
  const state=this.lanes[slot.lane];if(state.slot===slot){state.slot=undefined;state.version++;}
  slot.controller.abort();
  if(!slot.closing){
   // 退休后仍保留关闭责任；明确失败允许删除或宿主退出重试，确认关闭才移除。
   this.retiring.add(slot);
   slot.closing=Promise.resolve().then(()=>slot.reader.close()).then(()=>{this.retiring.delete(slot);},error=>{slot.closing=undefined;throw error;});
  }
  return slot.closing;
 }
 private retireAll():Promise<void>{
  if(this.invalidating)return this.invalidating;
  const slots=new Set(this.retiring),openings=new Set(this.retiringOpenings);
  // 先同时撤下两类连接及尚未完成的打开请求，迟到打开不能重新挂回旧范围。
  for(const state of Object.values(this.lanes)){
   state.version++;
   if(state.slot){slots.add(state.slot);state.slot=undefined;}
   if(state.opening){openings.add(state.opening);this.retiringOpenings.add(state.opening);state.opening=undefined;}
  }
  const work=(async()=>{
   const attempts=[...slots].map(slot=>this.retire(slot));
   for(const opening of openings)attempts.push(opening.then(slot=>this.retire(slot),error=>{
    if((error as {code?:string})?.code!=='assistant_read_invalidated')throw error;
   }).finally(()=>{this.retiringOpenings.delete(opening);}));
   const results=await Promise.allSettled(attempts),failed=results.find(result=>result.status==='rejected');
   if(failed?.status==='rejected')throw failed.reason;
  })();
  const invalidating=work.finally(()=>{if(this.invalidating===invalidating)this.invalidating=undefined;});
  this.invalidating=invalidating;return invalidating;
 }
 execute<T=unknown>(name:string,input:unknown):Promise<T>{
  if(this.closed)return Promise.reject(new StorageFailure('readonly_closed'));
  if(!allowed.has(name))return Promise.reject(new StorageFailure('readonly_action_forbidden'));
  if(!input||typeof input!=='object'||Array.isArray(input)||(input as {ownerId?:unknown}).ownerId!==this.options.ownerId)return Promise.reject(new StorageFailure('assistant_read_scope_invalid'));
  const work=this.executeOwned<T>(name,input as Record<string,unknown>);this.pending.add(work);work.then(()=>this.pending.delete(work),()=>this.pending.delete(work));return work;
 }
 private async executeOwned<T>(name:string,input:Record<string,unknown>):Promise<T>{
  const slot=await this.current(candidateActions.has(name)?'candidate':'discussion');
  try{
   if(metadata.has(name)){const value=await this.read<T>(slot,name,input);this.assertCurrent(slot);return value;}
   if(typeof input.contactId!=='string'||!input.contactId)throw new StorageFailure('assistant_read_scope_invalid');
   const scope={ownerId:this.options.ownerId,contactId:input.contactId,...(input.discussionId===undefined?{}:{discussionId:input.discussionId})};
   const before=await this.read<ReadBoundary>(slot,'discussion.readBoundary',scope);this.assertCurrent(slot);
   let finished=false,cancelled=false;
   const release=this.options.holders.register({key:'assistant-read:'+randomUUID(),scopeKeys:typeof input.discussionId==='string'?['discussion:'+input.discussionId]:[],ownerId:this.options.ownerId,contactId:input.contactId,generation:before.generation,coversAllSources:true,
    close:async()=>{if(!finished)cancelled=true;if(cancelled)await this.retireAll();}});
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
  }catch(error){const code=(error as {code?:string})?.code??'';if(terminal.has(code))await this.retireAll();throw code==='assistant_read_scope_unavailable'?new StorageFailure('discussion_unavailable'):error;}
 }
 close():Promise<void>{
  this.closed=true;
  return this.closing??=(async()=>{
   let failure:unknown;try{await this.retireAll();}catch(error){failure=error;}
   await Promise.allSettled([...this.pending]);
   if(failure)throw failure;
   if(this.retiring.size||this.retiringOpenings.size)await this.retireAll();
  })().catch(error=>{this.closing=undefined;throw error;});
 }
}

/** 独立于前台身份定位的同库只读通道，沿用唯一存储所有者的运行租约。 */
export async function createAssistantReadChannel(options:Options):Promise<StorageReader>{
 const channel=new AssistantReadChannel(options);await channel.ready();return channel;
}
