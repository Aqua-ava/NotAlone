import type {SavedContactBinding} from '../../contacts/sqlite/contracts.ts';
import type {SqliteHistoryService} from './service.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';

interface QuoteDirectory {directory():Promise<{read_enabled:boolean;bindings:readonly Pick<SavedContactBinding,'contact_id'|'status'>[]}>}
/** 历史引用有独立持久补齐状态；只在现授权内串行处理，不重置正文游标或发起模型任务。 */
export class SqliteQuoteSyncCoordinator {
 readonly #contacts:QuoteDirectory;readonly #history:Pick<SqliteHistoryService,'synchronizeQuotes'>&Partial<Pick<SqliteHistoryService,'waitForReadIdle'>>;
 readonly #pending=new Set<string>();readonly #stopped=new Set<string>();#all=false;#paused=false;#closed=false;#work?:Promise<void>;
 #active?:{contactId:string;controller:AbortController;done:Promise<void>};
 constructor(contacts:QuoteDirectory,history:Pick<SqliteHistoryService,'synchronizeQuotes'>&Partial<Pick<SqliteHistoryService,'waitForReadIdle'>>){this.#contacts=contacts;this.#history=history;}
 wake(contactId?:string):void{
  if(this.#closed)return;
  if(contactId){if(this.#paused||this.#stopped.has(contactId))return;this.#pending.add(contactId);}
  else{this.#paused=false;this.#stopped.clear();this.#all=true;}
  if(this.#work)return;
  this.#work=this.#drain().finally(()=>{this.#work=undefined;if(!this.#closed&&(this.#all||this.#pending.size))this.wake([...this.#pending][0]);});
  void this.#work.catch(()=>{});
 }
 async #drain():Promise<void>{
  while(!this.#closed&&(this.#all||this.#pending.size)){
   const all=this.#all,requested=new Set(this.#pending);this.#all=false;this.#pending.clear();
   const directory=await this.#contacts.directory();if(this.#closed||this.#paused||!directory.read_enabled)continue;
   for(const contactId of new Set(directory.bindings.filter(b=>b.status==='active'&&(all||requested.has(b.contact_id))).map(b=>b.contact_id))){
    if(this.#closed||this.#paused)break;if(this.#stopped.has(contactId))continue;
    const controller=new AbortController();let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});this.#active={contactId,controller,done};
    try{const result=await this.#history.synchronizeQuotes(contactId,controller.signal);if(result.more&&result.processed>0&&!controller.signal.aborted)this.#pending.add(contactId);}
    catch(error){
     // 页内唤醒可能早于普通读取释放；等真实完成通知后再试，不丢唤醒或定时轮询。
     if(error instanceof StorageFailure&&error.code==='history_already_running'&&this.#history.waitForReadIdle){
      await new Promise<void>(resolve=>{
       const done=()=>{controller.signal.removeEventListener('abort',done);resolve();};
       controller.signal.addEventListener('abort',done,{once:true});
       void this.#history.waitForReadIdle!(contactId).then(done,done);if(controller.signal.aborted)done();
      });
      if(!controller.signal.aborted&&!this.#closed&&!this.#paused&&!this.#stopped.has(contactId))this.#pending.add(contactId);
     }
    }
    finally{finish();if(this.#active?.controller===controller)this.#active=undefined;}
   }
  }
 }
 async stop(contactId?:string):Promise<void>{
  if(contactId){this.#stopped.add(contactId);this.#pending.delete(contactId);}else{this.#paused=true;this.#pending.clear();this.#all=false;}
  const active=this.#active;if(active&&(!contactId||active.contactId===contactId)){active.controller.abort();await active.done;}
  if(!contactId)await this.#work?.catch(()=>{});
 }
 async waitForIdle():Promise<void>{while(this.#work)await this.#work;}
 async close():Promise<void>{this.#closed=true;this.#pending.clear();this.#all=false;this.#active?.controller.abort();await this.#work?.catch(()=>{});}
}
