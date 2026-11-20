import {installSqliteReplyCandidateCommands} from './sqlite-reply-candidates';
import {createHash} from 'node:crypto';
import type {BackendHost} from '../backend/host';
import type {ContactSession} from '../contacts/session';
import type {PageCommands} from '../page-commands';
import {isUuid} from '../uuid';
import {readSqliteDiscussionSubmit,type SqliteDiscussionSubmit,type SqliteDiscussionReceipt,type SqliteDiscussionInvalidation} from '../../shared/sqlite-discussion-bridge';
type Backend=Pick<BackendHost,'requestJson'|'getConnectionGeneration'|'onStateChanged'>;
type Contacts=Pick<ContactSession,'getState'|'onStateChanged'>;
interface Scope {contactId:string|null;scopeRevision:number;generation:number|undefined;ready:boolean}
interface RequestRecord {revision:number;fingerprint:string;acknowledged:boolean;pending?:Promise<SqliteDiscussionReceipt>}
function stale():never{throw new Error('联系人或讨论范围已失效，请重新确认。');}
function receipt(value:unknown,request:SqliteDiscussionSubmit):SqliteDiscussionReceipt {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('讨论结果尚未确认，请保留原内容重试。');
 const r=value as Record<string,unknown>;
 if(Object.keys(r).length!==4||!['session_id','segmented','replayed','request_key'].every(k=>Object.hasOwn(r,k))||!isUuid(r.session_id)
  ||r.request_key!==request.requestKey||typeof r.segmented!=='boolean'||typeof r.replayed!=='boolean'
  ||!r.segmented&&!r.replayed&&r.session_id!==request.sessionId)throw new Error('讨论结果尚未确认，请保留原内容重试。');
 return {sessionId:r.session_id.toLowerCase(),segmented:r.segmented,replayed:r.replayed,requestKey:request.requestKey};
}
/** 每次提交固定当前连接与联系人范围；取消本地等待不宣称模型请求从未发生。 */
export class SqliteDiscussionController {
 private readonly backend:Backend;private readonly contacts:Contacts;private scope:Scope;private revision=0;private closed=false;
 private readonly requests=new Map<string,RequestRecord>();private readonly revokedKeys=new Set<string>();private readonly active=new Set<AbortController>();
 private readonly listeners=new Set<(event:SqliteDiscussionInvalidation)=>void>();private readonly unsubscribe:(()=>void)[];
 constructor(backend:Backend,contacts:Contacts){this.backend=backend;this.contacts=contacts;this.scope=this.capture();this.unsubscribe=[contacts.onStateChanged(()=>this.synchronize()),backend.onStateChanged(()=>this.synchronize())];}
 private capture():Scope {const s=this.contacts.getState();return {contactId:s.selectedContactId,scopeRevision:s.scopeRevision,generation:this.backend.getConnectionGeneration(),ready:s.directoryPhase==='ready'&&!!s.selectedContactId&&s.contacts.some(c=>c.contactId===s.selectedContactId)};}
 onInvalidated(listener:(event:SqliteDiscussionInvalidation)=>void):()=>void {this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 /** 资料撤下调用 synchronize(true)，即使联系人和连接标识未变化也撤销旧正文与在途操作。 */
 synchronize(force=false):void {
  const next=this.capture();if(!force&&JSON.stringify(next)===JSON.stringify(this.scope))return;
  this.scope=next;++this.revision;for(const c of this.active)c.abort();this.active.clear();
  for(const key of this.requests.keys())this.revokedKeys.add(key);this.requests.clear();
  while(this.revokedKeys.size>256)this.revokedKeys.delete(this.revokedKeys.values().next().value!);
  const event={revision:this.revision,contactId:next.contactId,scopeRevision:next.scopeRevision};for(const listener of this.listeners)listener(event);
 }
 invalidate():void {this.synchronize(true);}
 private current(request:SqliteDiscussionSubmit,revision:number,generation:number):void {
  this.synchronize();if(this.closed||revision!==this.revision||generation!==this.scope.generation||!this.scope.ready||request.contactId!==this.scope.contactId||request.scopeRevision!==this.scope.scopeRevision)stale();
 }
 submit(value:SqliteDiscussionSubmit):Promise<SqliteDiscussionReceipt> {
  try{
   const request=readSqliteDiscussionSubmit(value);this.synchronize();const generation=this.scope.generation,revision=this.revision;
   if(generation===undefined||this.revokedKeys.has(request.requestKey))stale();this.current(request,revision,generation);
   const fingerprint=createHash('sha256').update(JSON.stringify(request)).digest('hex'),prior=this.requests.get(request.requestKey);
   if(prior&&(prior.fingerprint!==fingerprint||prior.revision!==revision))throw new Error('本次讨论内容已变化，请使用新的明确请求。');
   if(prior?.pending)return prior.pending;if(this.active.size)throw new Error('本次讨论正在处理，请等待结果。');
   // 已有接纳回执由后端持久幂等记录保护；未知请求保留hash，不靠遗忘换正文。
   if(!prior&&this.requests.size>=256){for(const [key,record] of this.requests)if(record.acknowledged&&!record.pending){this.requests.delete(key);break;}
    if(this.requests.size>=256)throw new Error('尚有较多未确认的讨论，请先核对已保存讨论。');}
   const record:RequestRecord=prior??{revision,fingerprint,acknowledged:false},controller=new AbortController();this.requests.set(request.requestKey,record);this.active.add(controller);
   const pending=(async()=>{
    try{
     const response=await this.backend.requestJson({method:'POST',path:`/api/contacts/${request.contactId}/assistant-sessions/${request.sessionId}/entries`,body:{request_key:request.requestKey,text:request.text,confirmed_contact:true},signal:controller.signal,timeoutMs:120_000,maxResponseBytes:4096});
     this.current(request,revision,generation);if(controller.signal.aborted||response.generation!==generation)stale();const result=receipt(response.data,request);record.acknowledged=true;return result;
    }catch{this.current(request,revision,generation);if(controller.signal.aborted)stale();throw new Error('讨论结果尚未确认，请保留原内容重试。');}
    finally{this.active.delete(controller);}
   })();record.pending=pending;const clear=()=>{if(record.pending===pending)record.pending=undefined;};pending.then(clear,clear);return pending;
  }catch(error){return Promise.reject(error);}
 }
 close():void {if(this.closed)return;this.closed=true;for(const off of this.unsubscribe)off();this.synchronize(true);this.listeners.clear();this.requests.clear();this.revokedKeys.clear();}
}
export function installSqliteDiscussionBridge(commands:PageCommands,backend:Backend,contacts:Contacts,isContactConfirmed:()=>boolean=()=>true):SqliteDiscussionController {
 const controller=new SqliteDiscussionController(backend,contacts);installSqliteReplyCandidateCommands(commands,backend,contacts,controller,isContactConfirmed);controller.onInvalidated(event=>commands.publish('sqlite-discussion:invalidated',event,'helper'));
 commands.handle('sqlite-discussion:submit',(...args)=>{if(args.length!==1)throw new Error('本次讨论操作无效。');return controller.submit(readSqliteDiscussionSubmit(args[0]));},'helper');return controller;
}
