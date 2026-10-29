import type {BackendHost} from '../backend/host';
import {BackendRequestFailure} from '../backend/json-client';
import type {PageCommands} from '../page-commands';
import {noArguments} from '../page-commands';
import {isUuid} from '../uuid';
import type {MemoryCandidateView,MemoryDecisionRequest,MemoryManagementRead,MemoryManagementDecision,MemoryManagementSnapshot,
 MemoryManagementOutcome,MemoryManagementView,MemoryScope,MemorySource,MemoryVersionView,MemoryView} from '../../shared/sqlite-memory-management';

class ManagementInvalid extends Error {constructor(){super('记忆资料或范围已变化，请重新读取。');}}
const invalid=()=>new ManagementInvalid();
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();return value as Record<string,unknown>;}
function exact(value:Record<string,unknown>,keys:string[]){if(Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw invalid();}
function uuid(value:unknown):string{if(!isUuid(value))throw invalid();return value.toLowerCase();}
function text(value:unknown,limit=128000):string{if(typeof value!=='string'||value.length>limit)throw invalid();return value;}
function decimal(value:unknown):string{if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,17})$/.test(value))throw invalid();return value;}
function array(value:unknown):unknown[]{if(!Array.isArray(value)||value.length>10000)throw invalid();return value;}
function member<T extends string>(value:unknown,values:readonly T[]):T{if(!values.includes(value as T))throw invalid();return value as T;}
function scope(raw:unknown):MemoryScope{const s=object(raw);exact(s,['scopeKind','contactId']);const scopeKind=member(s.scopeKind,['self','contact']);if(scopeKind==='self'&&s.contactId!==null)throw invalid();return {scopeKind,contactId:scopeKind==='self'?null:uuid(s.contactId)};}
const sameScope=(a:MemoryScope,b:MemoryScope)=>a.scopeKind===b.scopeKind&&a.contactId===b.contactId;
function sources(raw:unknown):MemorySource[]{return array(raw).map(value=>{const s=object(value);return {contactId:uuid(s.contactId),messageId:uuid(s.messageId),recordId:uuid(s.recordId),acceptedRevision:decimal(s.acceptedRevision),quote:text(s.quote)};});}
function contributingContacts(raw:unknown):string[]{const ids=array(raw).map(uuid);if(new Set(ids).size!==ids.length)throw invalid();return ids;}
function version(raw:unknown):MemoryVersionView{const v=object(raw);return {versionNo:decimal(v.versionNo),body:v.body===null?null:text(v.body,48000),formationKind:member(v.formationKind,['adoption','correction','change','restore','manual']),adoptionMode:member(v.adoptionMode,['user','auto','manual']),previousVersionNo:v.previousVersionNo===null?null:decimal(v.previousVersionNo),restoredFromVersionNo:v.restoredFromVersionNo===null?null:decimal(v.restoredFromVersionNo),contentState:member(v.contentState,['present','redacted']),provenanceState:member(v.provenanceState,['eligible','pending_revalidation','invalidated']),decisionId:uuid(v.decisionId),sources:sources(v.sources),contributingContactIds:contributingContacts(v.contributingContactIds)};}
function readView(raw:unknown,s:MemoryScope,displayContactId:string):MemoryManagementView{
 const value=object(raw),owned=(items:MemorySource[])=>items.length>0&&items.every(x=>x.contactId===displayContactId);
 const ownsContribution=(ids:string[])=>ids.length===1&&ids[0]===displayContactId;
 const candidates:MemoryCandidateView[]=array(value.candidates).map(raw=>{const c=object(raw),cs=scope({scopeKind:c.scopeKind,contactId:c.contactId});if(!sameScope(cs,s))throw invalid();return {...cs,id:uuid(c.id),body:text(c.body,48000),state:member(c.state,['pending','adopted','rejected']),stateRevision:decimal(c.stateRevision),eventId:uuid(c.eventId),sources:sources(c.sources),contributingContactIds:contributingContacts(c.contributingContactIds)};}).filter(c=>owned(c.sources)&&ownsContribution(c.contributingContactIds));
 const memories:MemoryView[]=array(value.memories).map(raw=>{const m=object(raw),ms=scope({scopeKind:m.scopeKind,contactId:m.contactId});if(!sameScope(ms,s)||typeof m.manualProtection!=='boolean')throw invalid();const versions=array(m.versions).map(version),current=m.current===null?null:version(m.current);if(current&&!versions.some(v=>JSON.stringify(v)===JSON.stringify(current)))throw invalid();return {...ms,id:uuid(m.id),headRevision:decimal(m.headRevision),state:member(m.state,['active','withdrawn','invalidated']),manualProtection:m.manualProtection,current,versions,decisions:array(m.decisions).map(raw=>{const d=object(raw);return {id:uuid(d.id),action:member(d.action,['accept','edit_accept','reject','auto_accept','auto_update','correct','change','restore','withdraw','protect','unprotect','manual']),actorKind:member(d.actorKind,['user','system']),createdAt:decimal(d.createdAt),expectedHeadRevision:d.expectedHeadRevision===null?null:decimal(d.expectedHeadRevision),expectedVersionNo:d.expectedVersionNo===null?null:decimal(d.expectedVersionNo),outcome:member(d.outcome,['applied','redacted'])};})};}).filter(m=>s.scopeKind==='contact'?m.versions.every(v=>v.sources.every(source=>source.contactId===displayContactId)&&v.contributingContactIds.every(id=>id===displayContactId)):m.versions.some(v=>v.body!==null&&owned(v.sources)&&ownsContribution(v.contributingContactIds))&&m.versions.every(v=>v.body===null||owned(v.sources)&&ownsContribution(v.contributingContactIds)));
 return {candidates,memories};
}
type Contacts={getState():{selectedContactId:string|null;scopeRevision:number}};
/** 不缓存正文；每次决定重新核验页面可管理范围，迟到响应不能重新发布旧快照。 */
export class SqliteMemoryManagementController {
 private revision=0;
 private readonly requests=new Set<AbortController>();
 constructor(private readonly backend:Pick<BackendHost,'getConnectionGeneration'|'requestJson'>,private readonly publishInvalidated:()=>void,private readonly contacts:Contacts){}
 synchronize(){this.revision++;for(const request of this.requests)request.abort();this.requests.clear();this.publishInvalidated();}
 release(){this.synchronize();}
 private validate(input:unknown,decision=false):MemoryManagementRead{
  const q=object(input);exact(q,decision?['scope','displayContactId','scopeRevision','connectionGeneration','request']:['scope','displayContactId','scopeRevision']);
  const s=scope(q.scope),displayContactId=uuid(q.displayContactId),current=this.contacts.getState();
  if(!Number.isSafeInteger(q.scopeRevision)||current.scopeRevision!==q.scopeRevision||current.selectedContactId!==displayContactId||s.scopeKind==='contact'&&s.contactId!==displayContactId)throw invalid();
  if(decision&&q.connectionGeneration!==this.backend.getConnectionGeneration())throw invalid();
  return {scope:s,displayContactId,scopeRevision:q.scopeRevision as number};
 }
 private async request(path:string,method:'GET'|'POST',body?:unknown){
  const revision=this.revision,generation=this.backend.getConnectionGeneration();if(generation===undefined)throw invalid();const operation=new AbortController();this.requests.add(operation);
  try{const response=await this.backend.requestJson({path,method,...(body===undefined?{}:{body}),signal:operation.signal,timeoutMs:10000,maxResponseBytes:8388608});
   if(operation.signal.aborted||revision!==this.revision||generation!==response.generation||generation!==this.backend.getConnectionGeneration())throw invalid();return response;
  }finally{this.requests.delete(operation);}
 }
 async read(input:MemoryManagementRead):Promise<MemoryManagementSnapshot>{
  const accepted=this.validate(input),revision=this.revision;try{const response=await this.request(`/api/memory-management?scope_kind=${accepted.scope.scopeKind}${accepted.scope.contactId?`&contact_id=${accepted.scope.contactId}`:''}`,'GET');this.validate(input);return {connectionGeneration:response.generation,scope:accepted.scope,view:readView(response.data,accepted.scope,accepted.displayContactId)};}
  catch{if(revision===this.revision)this.synchronize();throw invalid();}
 }
 async decide(input:MemoryManagementDecision):Promise<MemoryManagementOutcome>{
  try{
   const accepted=this.validate(input,true),request=object(input.request),action=member(request.action,['accept','edit_accept','reject','correct','change','restore','withdraw','protect','unprotect']);
   const expected=['requestKey','action',...(['accept','edit_accept','reject'].includes(action)?['candidateIds','candidateRevisions']:['memoryId','expectedVersionNo','expectedHeadRevision']),...(['edit_accept','correct','change'].includes(action)?['body']:[]),...(action==='restore'?['restoredFromVersionNo']:[])];exact(request,expected);
   const clean:MemoryDecisionRequest={requestKey:uuid(request.requestKey),action};
   if(['accept','edit_accept','reject'].includes(action)){clean.candidateIds=array(request.candidateIds).map(uuid);clean.candidateRevisions=array(request.candidateRevisions).map(decimal);if(clean.candidateIds.length!==1||clean.candidateRevisions.length!==1)throw invalid();}
   else{clean.memoryId=uuid(request.memoryId);clean.expectedVersionNo=decimal(request.expectedVersionNo);clean.expectedHeadRevision=decimal(request.expectedHeadRevision);}
   if(['edit_accept','correct','change'].includes(action)){clean.body=text(request.body,48000);if(!clean.body.trim()||[...clean.body].length>12000)throw invalid();}
   if(action==='restore')clean.restoredFromVersionNo=decimal(request.restoredFromVersionNo);
   const snapshot=await this.read(accepted);this.validate(input,true);
   if(clean.candidateIds?.some(id=>!snapshot.view.candidates.some(c=>c.id===id)))return {status:'source_stale'};
   if(clean.memoryId&&!snapshot.view.memories.some(m=>m.id===clean.memoryId&&m.state==='active'&&m.current!==null))return {status:'source_stale'};
   const response=await this.request('/api/memory-management/decisions','POST',clean);this.validate(input,true);
   const result=object(response.data);return {status:'applied',result:{decisionId:uuid(result.decisionId),memoryId:result.memoryId===null?null:uuid(result.memoryId),versionNo:result.versionNo===null?null:decimal(result.versionNo),action:member(result.action,[action])}};
  }catch(error){
   this.synchronize();const code=error instanceof BackendRequestFailure?error.code:undefined;
   if(code&&['memory_head_conflict','memory_request_conflict','memory_candidate_stale'].includes(code))return {status:'conflict'};
   if(code==='memory_protected')return {status:'protected'};
   if(error instanceof ManagementInvalid||code&&/stale|deleted|invalidated|not_eligible|scope/.test(code))return {status:'source_stale'};
   return {status:'unavailable'};
  }
 }
}
export function installSqliteMemoryManagementBridge(commands:PageCommands,backend:BackendHost,contacts:Contacts){
 const controller=new SqliteMemoryManagementController(backend,()=>commands.publish('memory:management-invalidated',{},'manager'),contacts);
 backend.onStateChanged(()=>controller.synchronize());
 commands.handle('memory:management-read',(...args)=>{if(args.length!==1)throw invalid();return controller.read(args[0] as MemoryManagementRead);},'manager');
 commands.handle('memory:management-decide',(...args)=>{if(args.length!==1)throw invalid();return controller.decide(args[0] as MemoryManagementDecision);},'manager');
 commands.handle('memory:management-release',(...args)=>{noArguments(args);controller.release();},'manager');return controller;
}
