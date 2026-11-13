import type {SavedContactBinding} from '../../contacts/sqlite/contracts.ts';
import type {SqliteMediaService} from './service.ts';
import {imageRefreshIntervalMs,imageRefreshWindow,ImagePreparationFailure} from './image-refresh.ts';
import {StorageFailure,type StorageReader} from '../../storage/sqlite/contracts.ts';

interface ImageSyncDirectory {
 directory():Promise<{read_enabled:boolean;bindings:readonly Pick<SavedContactBinding,'contact_id'|'status'>[]}>;
}
interface ImageTarget {messageId:string;displayNo:string;requestKey:string}

/** 遍历有效授权联系人补查存量与新图片；目录查询只依赖宿主提供的隔离读者，退避由持久回执决定。 */
export class SqliteImageSyncCoordinator {
 readonly #reads:Pick<StorageReader,'execute'>;readonly #contacts:ImageSyncDirectory;readonly #media:SqliteMediaService;
 readonly #startedAt=Date.now();readonly #pending=new Set<string>();readonly #stoppedContacts=new Set<string>();#all=false;#paused=false;#closed=false;#work?:Promise<void>;
 #active?:{contactId:string;controller:AbortController;done:Promise<void>};
 #refreshTimer?:ReturnType<typeof setTimeout>;
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
 #launch():void {
  if(this.#work||this.#closed)return;
  this.#work=this.#drain().finally(()=>{this.#work=undefined;if(!this.#closed&&(this.#all||this.#pending.size))this.#launch();});
  // 读取资格失效由原同步状态展示；不得把内部异常或来源内容写进普通日志。
  void this.#work.catch(error=>this.#failure(error));
 }
 #scheduleRefresh():void {
  if(this.#refreshTimer||this.#closed||this.#paused)return;
  const now=Date.now(),delay=(imageRefreshWindow(now)+1)*imageRefreshIntervalMs-now;
  this.#refreshTimer=setTimeout(()=>{this.#refreshTimer=undefined;if(this.#closed||this.#paused)return;this.#all=true;this.#launch();},delay);
  this.#refreshTimer.unref?.();
 }
 async #drain():Promise<void>{
  while(!this.#closed&&(this.#all||this.#pending.size)){
   const all=this.#all,requested=new Set(this.#pending);this.#all=false;this.#pending.clear();
   const directory=await this.#contacts.directory();if(this.#closed||this.#paused||!directory.read_enabled)continue;
   const contacts=[...new Set(directory.bindings.filter(b=>b.status==='active'&&(all||requested.has(b.contact_id))).map(b=>b.contact_id))];
   for(const contactId of contacts){
    if(this.#closed||this.#paused)break;if(this.#stoppedContacts.has(contactId))continue;
    const controller=new AbortController();let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});this.#active={contactId,controller,done};
    try{
     let after='0';
     images:while(!this.#closed&&!controller.signal.aborted){
      const targets=await this.#reads.execute<ImageTarget[]>('media.imageSyncTargets',{ownerId:this.#media.ownerId,contactId,after,now:Date.now(),runtimeStartedAt:this.#startedAt});
      if(!targets.length)break;
      for(const target of targets){
       if(this.#closed||controller.signal.aborted)break;
       after=target.displayNo;
       try{await this.#media.extract(contactId,target.messageId,{requestKey:target.requestKey,goal:'extract'},controller.signal);this.#checked++;}
       catch(error){
        // 仅缩略图是预期结果（不保存，按持久退避有限次重试），不计入同步失败。
        if(error instanceof StorageFailure&&error.code==='media_thumbnail_only'){this.#checked++;continue;}
        this.#failure(error);if(error instanceof ImagePreparationFailure||error instanceof StorageFailure&&error.code.startsWith('history_'))break images;}
      }
     }
     if(!this.#closed&&!controller.signal.aborted&&await this.#reads.execute<boolean>('media.imageRefreshPending',{ownerId:this.#media.ownerId,contactId,runtimeStartedAt:this.#startedAt}))this.#scheduleRefresh();
    }finally{finish();if(this.#active?.controller===controller)this.#active=undefined;}
   }
  }
 }
 async stop(contactId?:string):Promise<void>{
  if(contactId){this.#stoppedContacts.add(contactId);this.#pending.delete(contactId);}else{this.#paused=true;this.#pending.clear();this.#all=false;if(this.#refreshTimer)clearTimeout(this.#refreshTimer);this.#refreshTimer=undefined;}
  const active=this.#active;
  if(active&&(!contactId||active.contactId===contactId)){active.controller.abort();await active.done;}
  if(!contactId)await this.#work?.catch(()=>{});
 }
 async waitForIdle():Promise<void>{while(this.#work)await this.#work;}
 async close():Promise<void>{this.#closed=true;this.#pending.clear();this.#all=false;if(this.#refreshTimer)clearTimeout(this.#refreshTimer);this.#refreshTimer=undefined;this.#active?.controller.abort();await this.#work?.catch(()=>{});}
}
