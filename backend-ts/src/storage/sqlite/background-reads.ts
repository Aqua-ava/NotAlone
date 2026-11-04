import {randomUUID} from 'node:crypto';
import type {SqliteStorage} from './client.ts';
import {StorageFailure,type StorageAction,type StorageReader} from './contracts.ts';
import type {ActiveHolders} from './deletion/holders.ts';

// 仅由宿主装配的后台目录与列表读取使用；页面、Tool 和任意调用方不能传入 SQL、动作名、连接或 reader。
export const backgroundReadActions=[
 'media.imageSyncTargets','media.imageRefreshPending','memory.read','memory.history',
] as const;
export const backgroundReadBoundaryAction:StorageAction={name:'background.readBoundary',mode:'read',retryBusy:false,execute(tx,input){
 const value=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:undefined;
 if(typeof value?.ownerId!=='string'||!value.ownerId)throw new StorageFailure('background_read_scope_invalid');
 if(value.contactId!==undefined&&(typeof value.contactId!=='string'||!value.contactId))throw new StorageFailure('background_read_scope_invalid');
 const row=typeof value.contactId==='string'
  ?tx.get('SELECT data_generation AS generation FROM contact WHERE owner_id=? AND id=?',[value.ownerId,value.contactId])
  :tx.get('SELECT read_epoch AS generation FROM owner WHERE owner_id=?',[value.ownerId]);
 if(!row||typeof row.generation!=='bigint')throw new StorageFailure('background_read_scope_unavailable');
 return {generation:row.generation};
}};
const allowed=new Set<string>(backgroundReadActions);
const terminal=new Set(['readonly_closed','stale_lease','storage_identity_changed','unsafe_storage_path','storage_missing','schema_drift','migration_drift','worker_failed']);
type Options={storage:Pick<SqliteStorage,'openReader'>;ownerId:string;holders:ActiveHolders};
interface ReaderSlot {reader:StorageReader;controller:AbortController;closing?:Promise<void>}
const cancelled=()=>new StorageFailure('background_read_cancelled');

/** 独立 Worker 的后台只读通道；沿用主存储运行租约，不排队等待主写者。 */
class BackgroundReadChannel implements StorageReader {
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
  const opening=this.options.storage.openReader([...backgroundReadActions,'background.readBoundary']).then(async reader=>{
   const slot={reader,controller:new AbortController()};
   if(this.closed||version!==this.version){await this.retire(slot);throw cancelled();}
   this.slot=slot;return slot;
  }).finally(()=>{if(this.opening===opening)this.opening=undefined;});
  this.opening=opening;return opening;
 }
 private assertCurrent(slot:ReaderSlot):void{if(this.closed||slot!==this.slot)throw cancelled();}
 private read<T>(slot:ReaderSlot,name:string,input:unknown):Promise<T>{
  const signal=slot.controller.signal;if(signal.aborted)return Promise.reject(cancelled());
  return new Promise((resolve,reject)=>{
   const abort=()=>{signal.removeEventListener('abort',abort);reject(cancelled());};
   signal.addEventListener('abort',abort,{once:true});
   try{slot.reader.execute<T>(name,input).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});}
   catch(error){signal.removeEventListener('abort',abort);reject(error);}
  });
 }
 private retire(slot:ReaderSlot):Promise<void>{
  if(this.slot===slot){this.slot=undefined;this.version++;}
  slot.controller.abort();
  if(!slot.closing){
   // 退休后仍保留关闭责任；明确失败允许宿主退出重试，确认关闭才移除。
   this.retiring.add(slot);
   slot.closing=Promise.resolve().then(()=>slot.reader.close()).then(()=>{this.retiring.delete(slot);},error=>{slot.closing=undefined;throw error;});
  }
  return slot.closing;
 }
 execute<T=unknown>(name:string,input:unknown):Promise<T>{
  if(this.closed)return Promise.reject(new StorageFailure('readonly_closed'));
  if(!allowed.has(name))return Promise.reject(new StorageFailure('readonly_action_forbidden'));
  if(!input||typeof input!=='object'||Array.isArray(input)||(input as {ownerId?:unknown}).ownerId!==this.options.ownerId)return Promise.reject(new StorageFailure('background_read_scope_invalid'));
  const work=this.executeOwned<T>(name,input as Record<string,unknown>);this.pending.add(work);work.then(()=>this.pending.delete(work),()=>this.pending.delete(work));return work;
 }
 private async executeOwned<T>(name:string,input:Record<string,unknown>):Promise<T>{
  const rawScope=input.scope&&typeof input.scope==='object'&&!Array.isArray(input.scope)?input.scope as Record<string,unknown>:undefined;
  const contactId=typeof input.contactId==='string'?input.contactId:typeof rawScope?.contactId==='string'?rawScope.contactId:undefined;
  for(let attempt=0;;attempt++){
   const slot=await this.current();
   let release:(()=>Promise<void>)|undefined;
   let finished=false,invalidated=false;
   try{
    // 边界与业务读取共用一次恢复周期；删除完成的 VACUUM 也可能先让边界动作本身失效。
    const boundary=await this.read<{generation:bigint}>(slot,'background.readBoundary',{ownerId:this.options.ownerId,...(contactId?{contactId}:{})});this.assertCurrent(slot);
    release=this.options.holders.register({
     key:'background-read:'+randomUUID(),ownerId:this.options.ownerId,generation:boundary.generation,
     ...(contactId?{contactId,coversAllSources:true}:{coversAllContacts:true}),
     close:async()=>{if(!finished)invalidated=true;if(invalidated)await this.retire(slot);},
    });
    const value=await this.read<T>(slot,name,input);this.assertCurrent(slot);if(invalidated)throw cancelled();return value;
   }catch(error){
    const code=(error as {code?:string})?.code??'';
    // 主写者完成删除后的 VACUUM 会推进 schema 版本；退役旧读者后重建一次，真实漂移仍如实上报。
    // 同一退役窗口内被撤销的在途读取也重试一次；删除 fence 或显式关闭不重试。
    const recoverable=attempt===0&&!this.closed&&!invalidated&&(code==='schema_drift'||code==='background_read_cancelled'&&slot!==this.slot);
    // 租约或存储身份失效后旧连接不再可发布结果；关闭失败仍如实上报。
    if(terminal.has(code))await this.retire(slot);
    if(recoverable)continue;
    throw error;
   }finally{
    finished=true;
    if(release)await release();
   }
  }
 }

 close():Promise<void>{
  this.closed=true;this.version++;
  return this.closing??=(async()=>{
   const slot=this.slot,opening=this.opening,attempts=new Set<Promise<unknown>>();
   if(slot)attempts.add(this.retire(slot));
   for(const retired of this.retiring)attempts.add(this.retire(retired));
   if(opening)attempts.add(opening.then(current=>this.retire(current),()=>{}));
   const results=await Promise.allSettled(attempts);
   // 先撤销迟到结果并等待在途读取结算，再确认连接关闭；失败保留重试。
   await Promise.allSettled([...this.pending]);
   const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
   await Promise.all([...this.retiring].map(retired=>this.retire(retired)));
  })().catch(error=>{this.closing=undefined;throw error;});
 }
}

/** 宿主生命周期内的后台只读通道，只允许图片同步目录和记忆列表读取。 */
export async function createBackgroundReads(options:Options):Promise<StorageReader>{
 const channel=new BackgroundReadChannel(options);await channel.ready();return channel;
}
