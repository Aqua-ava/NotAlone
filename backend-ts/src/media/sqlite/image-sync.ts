import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import type {SavedContactBinding} from '../../contacts/sqlite/contracts.ts';
import type {SqliteMediaService} from './service.ts';

interface ImageSyncDirectory {
 directory():Promise<{read_enabled:boolean;bindings:readonly Pick<SavedContactBinding,'contact_id'|'status'>[]}>;
}
interface ImageTarget {messageId:string;displayNo:string;requestKey:string}

/** 消息提交后唤醒；同一账号串行取原图，成功和缺失结果均持久去重，不用定时扫描微信。 */
export class SqliteImageSyncCoordinator {
 readonly #storage:SqliteStorage;readonly #contacts:ImageSyncDirectory;readonly #media:SqliteMediaService;
 readonly #pending=new Set<string>();readonly #stoppedContacts=new Set<string>();#all=false;#paused=false;#closed=false;#work?:Promise<void>;
 #active?:{contactId:string;controller:AbortController;done:Promise<void>};
 constructor(storage:SqliteStorage,contacts:ImageSyncDirectory,media:SqliteMediaService){this.#storage=storage;this.#contacts=contacts;this.#media=media;}
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
  void this.#work.catch(()=>{});
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
     while(!this.#closed&&!controller.signal.aborted){
      const targets=await this.#storage.execute<ImageTarget[]>('media.imageSyncTargets',{ownerId:this.#media.ownerId,contactId,after});
      if(!targets.length)break;
      for(const target of targets){
       if(this.#closed||controller.signal.aborted)break;
       after=target.displayNo;
       try{await this.#media.extract(contactId,target.messageId,{requestKey:target.requestKey,goal:'original_upgrade'},controller.signal);}
       catch{/* 原图未取得也保存本次尝试，继续其余消息；所有实际读取仍由服务复验资格。 */}
      }
     }
    }finally{finish();if(this.#active?.controller===controller)this.#active=undefined;}
   }
  }
 }
 async stop(contactId?:string):Promise<void>{
  if(contactId){this.#stoppedContacts.add(contactId);this.#pending.delete(contactId);}else{this.#paused=true;this.#pending.clear();this.#all=false;}
  const active=this.#active;
  if(active&&(!contactId||active.contactId===contactId)){active.controller.abort();await active.done;}
  if(!contactId)await this.#work?.catch(()=>{});
 }
 async waitForIdle():Promise<void>{while(this.#work)await this.#work;}
 async close():Promise<void>{this.#closed=true;this.#pending.clear();this.#all=false;this.#active?.controller.abort();await this.#work?.catch(()=>{});}
}
