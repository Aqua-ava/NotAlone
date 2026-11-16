import type {SavedContactBinding} from '../../contacts/sqlite/contracts.ts';
import type {SqliteMediaService} from './service.ts';
import {ImagePreparationFailure} from './image-refresh.ts';
import {StorageFailure,type StorageReader} from '../../storage/sqlite/contracts.ts';

interface ImageSyncDirectory {
 directory():Promise<{read_enabled:boolean;bindings:readonly Pick<SavedContactBinding,'contact_id'|'status'>[]}>;
}
interface ImageTarget {messageId:string;displayNo:string;requestKey:string}

/** 遍历有效授权联系人补查存量与新图片；目录查询只依赖宿主提供的隔离读者，退避由持久回执决定。 */
export class SqliteImageSyncCoordinator {
 readonly #reads:Pick<StorageReader,'execute'>;readonly #contacts:ImageSyncDirectory;readonly #media:SqliteMediaService;
 readonly #pending=new Set<string>();readonly #viewed=new Map<string,Set<string>>();readonly #viewedTried=new Set<string>();readonly #stoppedContacts=new Set<string>();#all=false;#paused=false;#closed=false;#work?:Promise<void>;
 #active?:{contactId:string;controller:AbortController;done:Promise<void>};
 #refreshTimer?:ReturnType<typeof setTimeout>;#refreshAt?:number;
 #checked=0;#failed=0;#lastFailure:string|null=null;
 constructor(reads:Pick<StorageReader,'execute'>,contacts:ImageSyncDirectory,media:SqliteMediaService){this.#reads=reads;this.#contacts=contacts;this.#media=media;}
 status(){return {processing:!!this.#work,checked:this.#checked,failed:this.#failed,last_failure_code:this.#lastFailure};}
 #failure(error:unknown):void{this.#failed++;this.#lastFailure=error instanceof StorageFailure&&/^[-a-z0-9_]{1,80}$/.test(error.code)?error.code:'media_execution_failed';}
 wake(contactId?:string):void {
  if(this.#closed)return;
  if(contactId){if(this.#paused||this.#stoppedContacts.has(contactId))return;this.#pending.add(contactId);}
  else{this.#paused=false;this.#stoppedContacts.clear();this.#all=true;}
  this.#launch();
 }
 /** 用户打开聊天、看到尚未保存的图片：每条消息每次运行只再试一次，不再按时间排队。 */
 retryViewed(contactId:string,messageIds:readonly string[]):void {
  if(this.#closed||this.#paused||this.#stoppedContacts.has(contactId))return;
  if(this.#viewedTried.size>20_000)this.#viewedTried.clear();
  const fresh=messageIds.filter(id=>!this.#viewedTried.has(`${contactId}:${id}`)).slice(0,100);
  if(!fresh.length)return;
  const wanted=this.#viewed.get(contactId)??new Set<string>();
  for(const id of fresh){this.#viewedTried.add(`${contactId}:${id}`);wanted.add(id);}
  this.#viewed.set(contactId,wanted);this.#launch();
 }
 #launch():void {
  if(this.#work||this.#closed)return;
  this.#work=this.#drain().finally(()=>{this.#work=undefined;if(!this.#closed&&(this.#all||this.#pending.size))this.#launch();});
  // 读取资格失效由原同步状态展示；不得把内部异常或来源内容写进普通日志。
  void this.#work.catch(error=>this.#failure(error));
 }
 #scheduleRefresh(at:number):void {
  if(this.#closed||this.#paused||this.#refreshAt!==undefined&&this.#refreshAt<=at)return;
  if(this.#refreshTimer)clearTimeout(this.#refreshTimer);
  this.#refreshAt=Math.max(Date.now()+1000,at);
  this.#refreshTimer=setTimeout(()=>{this.#refreshTimer=undefined;this.#refreshAt=undefined;if(this.#closed||this.#paused)return;this.#all=true;this.#launch();},this.#refreshAt-Date.now());
  this.#refreshTimer.unref?.();
 }
 async #extract(contactId:string,target:ImageTarget,controller:AbortController):Promise<'next'|'stop'>{
  try{await this.#media.extract(contactId,target.messageId,{requestKey:target.requestKey,goal:'extract'},controller.signal);this.#checked++;}
  catch(error){
   // 仅缩略图是预期结果（不保存），不计入同步失败。
   if(error instanceof StorageFailure&&error.code==='media_thumbnail_only'){this.#checked++;return 'next';}
   this.#failure(error);if(error instanceof ImagePreparationFailure||error instanceof StorageFailure&&error.code.startsWith('history_'))return 'stop';
  }
  return 'next';
 }
 async #drain():Promise<void>{
  while(!this.#closed&&(this.#all||this.#pending.size||this.#viewed.size)){
   const all=this.#all,requested=new Set(this.#pending),viewed=new Map(this.#viewed);this.#all=false;this.#pending.clear();this.#viewed.clear();
   const directory=await this.#contacts.directory();if(this.#closed||this.#paused||!directory.read_enabled)continue;
   const active=new Set(directory.bindings.filter(b=>b.status==='active').map(b=>b.contact_id));
   const contacts=[...new Set([...active].filter(id=>all||requested.has(id)||viewed.has(id)))];
   for(const contactId of contacts){
    if(this.#closed||this.#paused)break;if(this.#stoppedContacts.has(contactId))continue;
    const controller=new AbortController();let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});this.#active={contactId,controller,done};
    try{
     if(all||requested.has(contactId)){
      let after='0';
      images:while(!this.#closed&&!controller.signal.aborted){
       const targets=await this.#reads.execute<ImageTarget[]>('media.imageSyncTargets',{ownerId:this.#media.ownerId,contactId,after,now:Date.now()});
       if(!targets.length)break;
       for(const target of targets){
        if(this.#closed||controller.signal.aborted)break;
        after=target.displayNo;
        if(await this.#extract(contactId,target,controller)==='stop')break images;
       }
      }
     }
     const ids=viewed.get(contactId);
     if(ids?.size&&!this.#closed&&!controller.signal.aborted){
      const targets=await this.#reads.execute<ImageTarget[]>('media.imageViewTargets',{ownerId:this.#media.ownerId,contactId,messageIds:[...ids],now:Date.now()});
      for(const target of targets){
       if(this.#closed||controller.signal.aborted)break;
       if(await this.#extract(contactId,target,controller)==='stop')break;
      }
     }
     if(!this.#closed&&!controller.signal.aborted){
      const next=await this.#reads.execute<number|null>('media.imageRefreshNext',{ownerId:this.#media.ownerId,contactId});
      if(next!==null)this.#scheduleRefresh(next);
     }
    }finally{finish();if(this.#active?.controller===controller)this.#active=undefined;}
   }
  }
 }
 async stop(contactId?:string):Promise<void>{
  if(contactId){this.#stoppedContacts.add(contactId);this.#pending.delete(contactId);this.#viewed.delete(contactId);}else{this.#paused=true;this.#pending.clear();this.#viewed.clear();this.#all=false;if(this.#refreshTimer)clearTimeout(this.#refreshTimer);this.#refreshTimer=undefined;this.#refreshAt=undefined;}
  const active=this.#active;
  if(active&&(!contactId||active.contactId===contactId)){active.controller.abort();await active.done;}
  if(!contactId)await this.#work?.catch(()=>{});
 }
 async waitForIdle():Promise<void>{while(this.#work)await this.#work;}
 async close():Promise<void>{this.#closed=true;this.#pending.clear();this.#viewed.clear();this.#all=false;if(this.#refreshTimer)clearTimeout(this.#refreshTimer);this.#refreshTimer=undefined;this.#active?.controller.abort();await this.#work?.catch(()=>{});}
}
