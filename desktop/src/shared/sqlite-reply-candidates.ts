export interface SqliteCandidateScope {contactId:string;scopeRevision:number;sessionId:string}
export type SqliteCandidateOperation=SqliteCandidateScope & (
 | {action:'read'}
 | {action:'generate';requestKey:string;text:string;acceptIncomplete:boolean;carriedSelectionId?:string;selectedPackageId?:string}
 | {action:'edit';candidateId:string;versionNo:number;parts:string[]}
 | {action:'select'|'version';candidateId:string;versionNo:number}
);
export interface SqliteCandidateVersion {candidateId:string;versionNo:number;origin:'model'|'manual';parentVersionNo:number|null;parts:string[];basis:{itemNo:number;kind:string;text:string;verification:'actual_input'|'inherited_unverified'}[]}
export interface SqliteCandidateRequest {requestId:string;generationState?:'committed'|'running'|'failed'|'unknown'|'invalidated';coverageWarning:string|null;sourceState:'available'|'unavailable';candidates:SqliteCandidateVersion[];selections:{id:string;candidateId:string;versionNo:number;selectionNo:number}[];loadedSkills:{packageId:string;revisionNo:number;relativePath:string;text:string}[]}
export interface SqliteCandidatePage {availableSkills?:{packageId:string;name:string;revisionNo:number}[];requests:SqliteCandidateRequest[];coverage:{phase:'not_started'|'running'|'incomplete'|'complete'}}
export interface SqliteReplyCandidatesBridge {execute(operation:SqliteCandidateOperation):Promise<unknown>}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
function invalid():never{throw new Error('本次候选操作无效。');}
export function readSqliteCandidateOperation(value:unknown):SqliteCandidateOperation{
 if(!value||typeof value!=='object'||Array.isArray(value))invalid();const v=value as Record<string,unknown>;
 const common=['contactId','scopeRevision','sessionId','action'];
 const extra=v.action==='read'?[]:v.action==='generate'?['requestKey','text','acceptIncomplete','carriedSelectionId','selectedPackageId']:v.action==='edit'?['candidateId','versionNo','parts']:v.action==='select'||v.action==='version'?['candidateId','versionNo']:invalid();
 if(Object.keys(v).some(k=>![...common,...extra].includes(k))||!uuid(v.contactId)||!uuid(v.sessionId)||!Number.isSafeInteger(v.scopeRevision)||(v.scopeRevision as number)<0)invalid();
 if(v.action==='generate'&&(!uuid(v.requestKey)||typeof v.text!=='string'||!v.text.trim()||v.text.length>100000||typeof v.acceptIncomplete!=='boolean'||v.carriedSelectionId!==undefined&&!uuid(v.carriedSelectionId)||v.selectedPackageId!==undefined&&!uuid(v.selectedPackageId)))invalid();
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
 for(const r of v.requests){if(!r||!uuid(r.requestId)||!(r.coverageWarning===null||typeof r.coverageWarning==='string')||!['available','unavailable'].includes(r.sourceState)||!Array.isArray(r.candidates)||!Array.isArray(r.selections)||!Array.isArray(r.loadedSkills))invalid();r.candidates.forEach(readSqliteCandidateVersion);for(const s of r.selections)if(!uuid(s.id)||!uuid(s.candidateId)||!Number.isSafeInteger(s.versionNo)||!Number.isSafeInteger(s.selectionNo))invalid();for(const s of r.loadedSkills)if(!uuid(s.packageId)||!Number.isSafeInteger(s.revisionNo)||typeof s.relativePath!=='string'||typeof s.text!=='string'||s.text.length>100000)invalid();}
 return v;
}
