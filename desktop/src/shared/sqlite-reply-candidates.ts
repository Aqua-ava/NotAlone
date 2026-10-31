export interface SqliteCandidateScope {contactId:string;scopeRevision:number;sessionId:string}
export type SqliteWorkspaceTone='original'|'warm'|'concise'|'polite';
export interface SqliteReplyWorkspace {action:'express'|'suggest';draftText:string;tone:SqliteWorkspaceTone;instruction:string;contextText:string;includeRelationshipContext:boolean;excludedMessageIds:string[]}
export type SqliteCandidateOperation=SqliteCandidateScope & (
 | {action:'read'}
 | {action:'generate';requestKey:string;text:string;acceptIncomplete:boolean;carriedSelectionId?:string;selectedPackageId?:string;workspace?:SqliteReplyWorkspace}
 | {action:'edit';candidateId:string;versionNo:number;parts:string[]}
 | {action:'select'|'version';candidateId:string;versionNo:number}
);
export interface SqliteCandidateVersion {candidateId:string;versionNo:number;origin:'model'|'manual';parentVersionNo:number|null;parts:string[];basis:{itemNo:number;kind:string;text:string;verification:'actual_input'|'inherited_unverified'}[]}
export interface SqliteCandidateRequest {requestId:string;generationState?:'committed'|'running'|'failed'|'unknown'|'invalidated';coverageWarning:string|null;skillWarning?:string|null;sourceState:'available'|'unavailable';candidates:SqliteCandidateVersion[];selections:{id:string;candidateId:string;versionNo:number;selectionNo:number}[];loadedSkills:{packageId:string;name?:string;revisionNo:number;relativePath:string;text:string}[]}
export interface SqliteCandidateRecentMessage {messageId:string;sender:'owner'|'contact'|'unknown';text:string;occurredAt:string|null;timePrecision:'millisecond'|'second'|null;displayPosition:string;ordering:'verified'|'unknown'}
export interface SqliteCandidatePage {availableSkills?:{packageId:string;name:string;revisionNo:number}[];recentMessages?:SqliteCandidateRecentMessage[];requests:SqliteCandidateRequest[];coverage:{phase:'not_started'|'running'|'incomplete'|'complete'}}
export interface SqliteReplyCandidatesBridge {execute(operation:SqliteCandidateOperation):Promise<unknown>}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
function invalid():never{throw new Error('本次候选操作无效。');}
function validWorkspace(value:unknown):value is SqliteReplyWorkspace{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const w=value as Record<string,unknown>;
 if(Object.keys(w).some(k=>!['action','draftText','tone','instruction','contextText','includeRelationshipContext','excludedMessageIds'].includes(k))
  ||!['express','suggest'].includes(String(w.action))||typeof w.draftText!=='string'||w.draftText.length>100000
  ||w.draftText.length+(typeof w.instruction==='string'?w.instruction.length:0)+(typeof w.contextText==='string'?w.contextText.length:0)>99744
  ||w.action==='express'&&!w.draftText.trim()||!['original','warm','concise','polite'].includes(String(w.tone))
  ||typeof w.instruction!=='string'||w.instruction.length>100000||typeof w.contextText!=='string'||w.contextText.length>100000
  ||typeof w.includeRelationshipContext!=='boolean'||!Array.isArray(w.excludedMessageIds)||w.excludedMessageIds.length>20
  ||w.excludedMessageIds.some(id=>!uuid(id))||new Set(w.excludedMessageIds).size!==w.excludedMessageIds.length)return false;
 return true;
}
export function readSqliteCandidateOperation(value:unknown):SqliteCandidateOperation{
 if(!value||typeof value!=='object'||Array.isArray(value))invalid();const v=value as Record<string,unknown>;
 const common=['contactId','scopeRevision','sessionId','action'];
 const extra=v.action==='read'?[]:v.action==='generate'?['requestKey','text','acceptIncomplete','carriedSelectionId','selectedPackageId','workspace']:v.action==='edit'?['candidateId','versionNo','parts']:v.action==='select'||v.action==='version'?['candidateId','versionNo']:invalid();
 if(Object.keys(v).some(k=>![...common,...extra].includes(k))||!uuid(v.contactId)||!uuid(v.sessionId)||!Number.isSafeInteger(v.scopeRevision)||(v.scopeRevision as number)<0)invalid();
 if(v.action==='generate'&&(!uuid(v.requestKey)||typeof v.text!=='string'||v.text.length>100000||typeof v.acceptIncomplete!=='boolean'||v.carriedSelectionId!==undefined&&!uuid(v.carriedSelectionId)||v.selectedPackageId!==undefined&&!uuid(v.selectedPackageId)
  ||v.workspace!==undefined&&(!validWorkspace(v.workspace)||v.text!==v.workspace.draftText||v.carriedSelectionId!==undefined&&(!v.workspace.includeRelationshipContext||v.workspace.excludedMessageIds.length>0))
  ||v.workspace===undefined&&!v.text.trim()))invalid();
 if(['edit','select','version'].includes(String(v.action))&&(!uuid(v.candidateId)||!Number.isSafeInteger(v.versionNo)||(v.versionNo as number)<1))invalid();
 if(v.action==='edit'&&(!Array.isArray(v.parts)||!v.parts.length||v.parts.length>8||v.parts.some(p=>typeof p!=='string'||!p.trim()||p.length>10000)||v.parts.join('').length>30000))invalid();
 return v as unknown as SqliteCandidateOperation;
}
export function readSqliteCandidateVersion(value:unknown):SqliteCandidateVersion{
 if(!value||typeof value!=='object')invalid();const v=value as SqliteCandidateVersion;
 if(!uuid(v.candidateId)||!Number.isSafeInteger(v.versionNo)||v.versionNo<1||!['model','manual'].includes(v.origin)||!(v.parentVersionNo===null||Number.isSafeInteger(v.parentVersionNo)&&v.parentVersionNo>=1&&v.parentVersionNo<v.versionNo)||!Array.isArray(v.parts)||!v.parts.length||v.parts.length>8||v.parts.some(p=>typeof p!=='string'||!p.trim()||p.length>10000)||!Array.isArray(v.basis)||v.basis.length>50||v.basis.some(b=>!b||!Number.isSafeInteger(b.itemNo)||b.itemNo<1||typeof b.kind!=='string'||typeof b.text!=='string'||b.text.length>100000||!['actual_input','inherited_unverified'].includes(b.verification)))invalid();return v;
}
export function readSqliteCandidatePage(value:unknown):SqliteCandidatePage{
 if(!value||typeof value!=='object')invalid();const v=value as SqliteCandidatePage;
 if(!Array.isArray(v.requests)||!v.coverage||!['not_started','running','incomplete','complete'].includes(v.coverage.phase))invalid();
 if(v.availableSkills!==undefined&&(!Array.isArray(v.availableSkills)||v.availableSkills.some(s=>!s||!uuid(s.packageId)||typeof s.name!=='string'||s.name.length>4096||!Number.isSafeInteger(s.revisionNo)||s.revisionNo<1)))invalid();
 if(v.recentMessages!==undefined&&(!Array.isArray(v.recentMessages)||v.recentMessages.length>20||v.recentMessages.some(m=>!m||!uuid(m.messageId)||!['owner','contact','unknown'].includes(m.sender)||typeof m.text!=='string'||!m.text.trim()||m.text.length>100000||!(m.occurredAt===null||typeof m.occurredAt==='string'&&m.occurredAt.length<=64)||!(m.timePrecision===null||['second','millisecond'].includes(m.timePrecision))||typeof m.displayPosition!=='string'||m.displayPosition.length>64||!['verified','unknown'].includes(m.ordering))))invalid();
 for(const r of v.requests){if(!r||r.skillWarning!==undefined&&r.skillWarning!==null&&r.skillWarning!=='回复策略暂不可用'||!uuid(r.requestId)||!(r.coverageWarning===null||typeof r.coverageWarning==='string')||!['available','unavailable'].includes(r.sourceState)||!Array.isArray(r.candidates)||!Array.isArray(r.selections)||!Array.isArray(r.loadedSkills))invalid();r.candidates.forEach(readSqliteCandidateVersion);for(const s of r.selections)if(!uuid(s.id)||!uuid(s.candidateId)||!Number.isSafeInteger(s.versionNo)||!Number.isSafeInteger(s.selectionNo))invalid();for(const s of r.loadedSkills)if(s.name!==undefined&&(typeof s.name!=='string'||s.name.length>4096)||!uuid(s.packageId)||!Number.isSafeInteger(s.revisionNo)||typeof s.relativePath!=='string'||typeof s.text!=='string'||new TextEncoder().encode(s.text).byteLength>1024*1024)invalid();}
 return v;
}
