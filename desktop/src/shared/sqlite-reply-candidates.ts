export const sqliteReplySourceUnavailableMessage='聊天来源待重新核验，请到联系人页处理同步问题。';
export interface SqliteCandidateScope {contactId:string;scopeRevision:number;sessionId:string}
export type SqliteWorkspaceTone='original'|'warm'|'concise'|'polite';
export interface SqliteReplyWorkspace {action:'express'|'suggest';draftText:string;tone:SqliteWorkspaceTone;instruction:string;contextText:string;includeRelationshipContext:boolean}
export type SqliteCandidateOperation=SqliteCandidateScope & (
 | {action:'read'}
 | {action:'status';requestKey:string}
 | {action:'skills';requestId:string;offset:number}
 | {action:'inputs';requestId:string;offset:number}
 | {action:'generate';requestKey:string;text:string;acceptIncomplete:boolean;carriedSelectionId?:string;selectedPackageId?:string;workspace?:SqliteReplyWorkspace}
 | {action:'edit';candidateId:string;versionNo:number;parts:string[]}
 | {action:'select'|'version';candidateId:string;versionNo:number}
);
export interface SqliteCandidateVersion {candidateId:string;versionNo:number;origin:'model'|'manual';parentVersionNo:number|null;parts:string[];basis:(SqliteCandidateInputMaterial&{verification:'actual_input'|'inherited_unverified'})[]}
export interface SqliteCandidateLoadedSkill {packageId:string;name?:string;title?:string;revisionNo:number;relativePath:string;text?:string;origin?:'explicit'|'auto_preload'|null;catalogRevision?:string|null}
export interface SqliteCandidateRequest {requestId:string;generationState?:'committed'|'running'|'failed'|'unknown'|'invalidated';generationErrorCode?:string|null;generationSent?:boolean;generationAbandoned?:boolean;coverageWarning:string|null;skillWarning?:string|null;sourceState:'available'|'unavailable';candidates:SqliteCandidateVersion[];selections:{id:string;candidateId:string;versionNo:number;selectionNo:number}[];loadedSkills:SqliteCandidateLoadedSkill[];preloadedSkills?:{packageId:string;name?:string;revisionNo:number;origin:'explicit'|'auto_preload';catalogRevision?:string}[]}
export interface SqliteCandidateRecentMessage {messageId:string;sender:'owner'|'contact'|'unknown';text:string;occurredAt:string|null;timePrecision:'millisecond'|'second'|null;displayPosition:string;ordering:'verified'|'unknown'}
export interface SqliteCandidatePage {recentMessages?:SqliteCandidateRecentMessage[];requests:SqliteCandidateRequest[];coverage:{phase:'not_started'|'running'|'incomplete'|'complete'};hasMoreRequests?:boolean}
export interface SqliteCandidateSkillPage {items:(SqliteCandidateLoadedSkill&{text:string})[];nextOffset:number|null;total:number}
export interface SqliteCandidateInputMaterial {itemNo:number;kind:string;text:string;versionNo?:number;scopeKind?:'owner'|'contact';workspaceItem?:'request'|'draft'|'instruction'|'supplemental_context';qualification?:'confirmed'|'auto'|'unconfirmed'|'published';projectionKind?:'directory'|'profile'|'blocks'}
export interface SqliteCandidateInputPage {items:SqliteCandidateInputMaterial[];nextOffset:number|null;total:number;recorded:boolean}
export interface SqliteReplyCandidatesBridge {execute(operation:SqliteCandidateOperation):Promise<unknown>}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
function invalid():never{throw new Error('本次候选操作无效。');}
function validWorkspace(value:unknown):value is SqliteReplyWorkspace{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const w=value as Record<string,unknown>;
 if(Object.keys(w).some(k=>!['action','draftText','tone','instruction','contextText','includeRelationshipContext'].includes(k))
  ||!['express','suggest'].includes(String(w.action))||typeof w.draftText!=='string'||w.draftText.length>100000
  ||w.draftText.length+(typeof w.instruction==='string'?w.instruction.length:0)+(typeof w.contextText==='string'?w.contextText.length:0)>99744
  ||w.action==='express'&&!w.draftText.trim()||!['original','warm','concise','polite'].includes(String(w.tone))
  ||typeof w.instruction!=='string'||w.instruction.length>100000||typeof w.contextText!=='string'||w.contextText.length>100000
  ||typeof w.includeRelationshipContext!=='boolean')return false;
 return true;
}
export function readSqliteCandidateOperation(value:unknown):SqliteCandidateOperation{
 if(!value||typeof value!=='object'||Array.isArray(value))invalid();const v=value as Record<string,unknown>;
 const common=['contactId','scopeRevision','sessionId','action'];
 const extra=v.action==='read'?[]:v.action==='status'?['requestKey']:v.action==='skills'||v.action==='inputs'?['requestId','offset']:v.action==='generate'?['requestKey','text','acceptIncomplete','carriedSelectionId','selectedPackageId','workspace']:v.action==='edit'?['candidateId','versionNo','parts']:v.action==='select'||v.action==='version'?['candidateId','versionNo']:invalid();
 if(Object.keys(v).some(k=>![...common,...extra].includes(k))||!uuid(v.contactId)||!uuid(v.sessionId)||!Number.isSafeInteger(v.scopeRevision)||(v.scopeRevision as number)<0)invalid();
 if(v.action==='status'&&!uuid(v.requestKey))invalid();
 if((v.action==='skills'||v.action==='inputs')&&(!uuid(v.requestId)||!Number.isSafeInteger(v.offset)||(v.offset as number)<0||(v.offset as number)>1_000_000))invalid();
 if(v.action==='generate'&&(!uuid(v.requestKey)||typeof v.text!=='string'||v.text.length>100000||typeof v.acceptIncomplete!=='boolean'||v.carriedSelectionId!==undefined&&!uuid(v.carriedSelectionId)||v.selectedPackageId!==undefined&&!uuid(v.selectedPackageId)
  ||v.workspace!==undefined&&(!validWorkspace(v.workspace)||v.text!==v.workspace.draftText||v.carriedSelectionId!==undefined&&!v.workspace.includeRelationshipContext)
  ||v.workspace===undefined&&!v.text.trim()))invalid();
 if(['edit','select','version'].includes(String(v.action))&&(!uuid(v.candidateId)||!Number.isSafeInteger(v.versionNo)||(v.versionNo as number)<1))invalid();
 if(v.action==='edit'&&(!Array.isArray(v.parts)||!v.parts.length||v.parts.length>8||v.parts.some(p=>typeof p!=='string'||!p.trim()||p.length>10000)||v.parts.join('').length>30000))invalid();
 return v as unknown as SqliteCandidateOperation;
}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))invalid();return value as Record<string,unknown>;}
function exact(value:Record<string,unknown>,required:string[],optional:string[]=[]):void{
 if(required.some(key=>!(key in value))||Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key)))invalid();
}
function validLoadedSkill(value:unknown,requireText:boolean):SqliteCandidateLoadedSkill&{text?:string}{
 const s=object(value),required=['packageId','revisionNo','relativePath',...(requireText?['text']:[])],optional=['name','title','origin','catalogRevision','text'];
 exact(s,required,optional);
 if(!uuid(s.packageId)||!Number.isSafeInteger(s.revisionNo)||!(s.revisionNo as number>0)||typeof s.relativePath!=='string'||!s.relativePath||s.relativePath.length>4096
  ||s.name!==undefined&&(typeof s.name!=='string'||!s.name||s.name.length>4096)
  ||s.title!==undefined&&(typeof s.title!=='string'||!s.title||s.title.length>4096)
  ||s.origin!==undefined&&s.origin!==null&&!['explicit','auto_preload'].includes(String(s.origin))
  ||s.catalogRevision!==undefined&&s.catalogRevision!==null&&(typeof s.catalogRevision!=='string'||!s.catalogRevision||s.catalogRevision.length>65536)
  ||s.text!==undefined&&(typeof s.text!=='string'||!s.text||new TextEncoder().encode(s.text).byteLength>1024*1024))invalid();
 return s as unknown as SqliteCandidateLoadedSkill&{text?:string};
}
export function readSqliteCandidateVersion(value:unknown):SqliteCandidateVersion{
 const v=object(value);exact(v,['candidateId','versionNo','origin','parentVersionNo','parts','basis']);
 if(!uuid(v.candidateId)||!Number.isSafeInteger(v.versionNo)||(v.versionNo as number)<1||!['model','manual'].includes(String(v.origin))
  ||!(v.parentVersionNo===null||Number.isSafeInteger(v.parentVersionNo)&&(v.parentVersionNo as number)>=1&&(v.parentVersionNo as number)<(v.versionNo as number))
  ||!Array.isArray(v.parts)||!v.parts.length||v.parts.length>8||v.parts.some(p=>typeof p!=='string'||!p.trim()||p.length>10000)
  ||!Array.isArray(v.basis)||v.basis.length>50)invalid();
 for(const basis of v.basis){const b=object(basis);exact(b,['itemNo','kind','text','verification'],['scopeKind','workspaceItem','qualification','projectionKind','versionNo']);validMaterial(b);if(!['actual_input','inherited_unverified'].includes(String(b.verification)))invalid();}
 return v as unknown as SqliteCandidateVersion;
}
export function readSqliteCandidatePage(value:unknown):SqliteCandidatePage{
 const v=object(value);exact(v,['requests','coverage'],['recentMessages','hasMoreRequests']);
 if(!Array.isArray(v.requests))invalid();
 if(v.hasMoreRequests!==undefined&&typeof v.hasMoreRequests!=='boolean')invalid();
 const coverage=object(v.coverage);exact(coverage,['phase']);if(!['not_started','running','incomplete','complete'].includes(String(coverage.phase)))invalid();
 if(v.recentMessages!==undefined){
  if(!Array.isArray(v.recentMessages)||v.recentMessages.length>50)invalid();
  for(const value of v.recentMessages){const m=object(value);exact(m,['messageId','sender','text','occurredAt','timePrecision','displayPosition','ordering']);
   if(!uuid(m.messageId)||!['owner','contact','unknown'].includes(String(m.sender))||typeof m.text!=='string'||!m.text.trim()||m.text.length>100000
    ||!(m.occurredAt===null||typeof m.occurredAt==='string'&&m.occurredAt.length<=64)||!(m.timePrecision===null||['second','millisecond'].includes(String(m.timePrecision)))
    ||typeof m.displayPosition!=='string'||m.displayPosition.length>64||!['verified','unknown'].includes(String(m.ordering)))invalid();}
 }
 for(const value of v.requests){const r=object(value);exact(r,['requestId','coverageWarning','sourceState','candidates','selections','loadedSkills'],['generationState','generationErrorCode','generationSent','generationAbandoned','skillWarning','preloadedSkills']);
  if(!uuid(r.requestId)||!(r.coverageWarning===null||typeof r.coverageWarning==='string')||!['available','unavailable'].includes(String(r.sourceState))
   ||r.generationState!==undefined&&!['committed','running','failed','unknown','invalidated'].includes(String(r.generationState))
   ||r.generationErrorCode!==undefined&&r.generationErrorCode!==null&&(typeof r.generationErrorCode!=='string'||!/^[a-z][a-z0-9_]{0,79}$/.test(r.generationErrorCode))
   ||r.generationSent!==undefined&&typeof r.generationSent!=='boolean'
   ||r.generationAbandoned!==undefined&&typeof r.generationAbandoned!=='boolean'
   ||r.skillWarning!==undefined&&r.skillWarning!==null&&r.skillWarning!=='回复策略暂不可用'
   ||!Array.isArray(r.candidates)||!Array.isArray(r.selections)||!Array.isArray(r.loadedSkills)||r.preloadedSkills!==undefined&&!Array.isArray(r.preloadedSkills))invalid();
  r.candidates.forEach(readSqliteCandidateVersion);
  for(const value of r.selections){const s=object(value);exact(s,['id','candidateId','versionNo','selectionNo']);if(!uuid(s.id)||!uuid(s.candidateId)||!Number.isSafeInteger(s.versionNo)||(s.versionNo as number)<1||!Number.isSafeInteger(s.selectionNo)||(s.selectionNo as number)<1)invalid();}
  for(const skill of r.loadedSkills)validLoadedSkill(skill,false);
  for(const value of r.preloadedSkills??[]){const s=object(value);exact(s,['packageId','revisionNo','origin'],['name','catalogRevision']);if(!uuid(s.packageId)||!Number.isSafeInteger(s.revisionNo)||(s.revisionNo as number)<1||!['explicit','auto_preload'].includes(String(s.origin))
   ||s.name!==undefined&&(typeof s.name!=='string'||!s.name||s.name.length>4096)||s.catalogRevision!==undefined&&(typeof s.catalogRevision!=='string'||!s.catalogRevision||s.catalogRevision.length>65536))invalid();}
 }
 return v as unknown as SqliteCandidatePage;
}
export function readSqliteCandidateSkillPage(value:unknown,offset:number):SqliteCandidateSkillPage{
 const v=object(value);exact(v,['items','nextOffset','total']);
 if(!Number.isSafeInteger(offset)||offset<0||!Array.isArray(v.items)||!Number.isSafeInteger(v.total)||(v.total as number)<0||!(v.nextOffset===null||Number.isSafeInteger(v.nextOffset)))invalid();
 const nextOffset=v.nextOffset as number|null,end=offset+v.items.length;
 if(end>(v.total as number)||end===offset&&offset<(v.total as number)||(nextOffset===null?end!==v.total:nextOffset!==end))invalid();
 for(const skill of v.items)validLoadedSkill(skill,true);
 return v as unknown as SqliteCandidateSkillPage;
}

function validMaterial(item:Record<string,unknown>):void{
 if(!Number.isSafeInteger(item.itemNo)||(item.itemNo as number)<1||typeof item.kind!=='string'||!item.kind||typeof item.text!=='string'||!item.text||new TextEncoder().encode(item.text).byteLength>1_500_000
  ||item.versionNo!==undefined&&(!Number.isSafeInteger(item.versionNo)||(item.versionNo as number)<1)
  ||item.scopeKind!==undefined&&!['owner','contact'].includes(String(item.scopeKind))
  ||item.workspaceItem!==undefined&&!['request','draft','instruction','supplemental_context'].includes(String(item.workspaceItem))
  ||item.qualification!==undefined&&!['confirmed','auto','unconfirmed','published'].includes(String(item.qualification))
  ||item.projectionKind!==undefined&&!['directory','profile','blocks'].includes(String(item.projectionKind)))invalid();
}
export function readSqliteCandidateInputPage(value:unknown,offset=0):SqliteCandidateInputPage{
 const v=object(value);exact(v,['items','nextOffset','total','recorded']);
 if(!Number.isSafeInteger(offset)||offset<0||typeof v.recorded!=='boolean'||!Array.isArray(v.items)||v.items.length>50||!Number.isSafeInteger(v.total)||(v.total as number)<0)invalid();
 const end=offset+v.items.length;
 if(end>(v.total as number)||end===offset&&offset<(v.total as number)||(v.nextOffset===null?end!==v.total:!Number.isSafeInteger(v.nextOffset)||v.nextOffset!==end)||!v.recorded&&(v.total!==0||v.items.length!==0||v.nextOffset!==null))invalid();
 const numbers=new Set<number>();
 for(const value of v.items){const item=object(value);exact(item,['itemNo','kind','text'],['scopeKind','workspaceItem','qualification','projectionKind','versionNo']);validMaterial(item);
  if(numbers.has(item.itemNo as number))invalid();
  numbers.add(item.itemNo as number);
 }
 return v as unknown as SqliteCandidateInputPage;
}

/** 进度只包含调用状态，不允许聊天、模型正文或诊断详情进入此通道。 */
export interface SqliteCandidateStatus {requestKey:string;phase:'not_found'|'preparing'|'queued'|'generating'|'saving'|'committed'|'failed'|'unknown';sent:boolean;/** 已发出但未收到结果、被本机自动放弃的调用；已收到响应的失败不属于此类。 */abandoned?:boolean;errorCode:string|null;retryable:boolean;startedAt:number|null;finishedAt:number|null}
export function readSqliteCandidateStatus(value:unknown):SqliteCandidateStatus{
 if(!value||typeof value!=='object'||Array.isArray(value))invalid();const v=value as SqliteCandidateStatus;
 const required=['requestKey','phase','sent','errorCode','retryable','startedAt','finishedAt'];
 if(required.some(k=>!(k in v))||Object.keys(v).some(k=>k!=='abandoned'&&!required.includes(k))
  ||v.abandoned!==undefined&&typeof v.abandoned!=='boolean'
  ||!uuid(v.requestKey)||!['not_found','preparing','queued','generating','saving','committed','failed','unknown'].includes(v.phase)
  ||typeof v.sent!=='boolean'||typeof v.retryable!=='boolean'||v.retryable&&v.phase!=='failed'
  ||!(v.errorCode===null||typeof v.errorCode==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(v.errorCode))
  ||[v.startedAt,v.finishedAt].some(t=>t!==null&&(!Number.isSafeInteger(t)||t<0)))invalid();
 return v;
}
