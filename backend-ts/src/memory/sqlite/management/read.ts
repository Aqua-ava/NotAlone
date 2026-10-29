import {qualificationSources} from './dependencies.ts';
import type {StorageRow,StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {available,citations,fail,id,requireCandidate,requireVersion,scope} from './qualification.ts';
import type {MemoryManagementView,MemoryScope,MemorySource,MemoryVersionView} from './contracts.ts';
export function sourceViews(rows:StorageRow[]):MemorySource[]{return rows.map(r=>({contactId:String(r.source_contact_id),messageId:String(r.message_id),recordId:String(r.record_id),acceptedRevision:String(r.accepted_revision),quote:[...String(r.text_body)].slice(Number(r.span_start),Number(r.span_end)).join('')}));}
export function versionView(tx:StorageTransaction,ownerId:string,v:StorageRow):MemoryVersionView{return {versionNo:String(v.version_no),body:v.body as string|null,formationKind:String(v.formation_kind),adoptionMode:String(v.adoption_mode),previousVersionNo:v.previous_version_no===null?null:String(v.previous_version_no),restoredFromVersionNo:v.restored_from_version_no===null?null:String(v.restored_from_version_no),contentState:String(v.content_state),provenanceState:String(v.provenance_state),decisionId:String(v.decision_id),contributingContactIds:v.content_state==='present'?[...new Set(qualificationSources(tx,ownerId,{memoryId:String(v.memory_id),versionNo:v.version_no as bigint}).map(s=>s.contactId))]:[],sources:sourceViews(citations(tx,ownerId,{memoryId:String(v.memory_id),versionNo:v.version_no as bigint}))};}
export function managementRead(tx:StorageTransaction,input:unknown):MemoryManagementView{
 const q=input as any,ownerId=id(q?.ownerId),s=scope(q?.scope);available(tx,ownerId,s);
 // 删除进行期间立即撤下全部快照，不以按钮禁用替代敏感正文清除。
 if(tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed'",[ownerId]))return {candidates:[],memories:[]};
 const candidates=tx.all('SELECT * FROM memory_candidate WHERE owner_id=? AND scope_kind=? AND contact_id IS ? ORDER BY id',[ownerId,s.scopeKind,s.contactId]).flatMap(c=>{
  if(c.state==='deleted'||c.state==='invalidated')return [];
  try{requireCandidate(tx,ownerId,{...c,state:'pending'});}catch{return [];}
  return [{id:String(c.id),scopeKind:s.scopeKind,contactId:s.contactId,body:String(c.proposed_body),state:String(c.state),stateRevision:String(c.state_revision),eventId:String(c.event_id),contributingContactIds:[...new Set(qualificationSources(tx,ownerId,{candidateId:String(c.id)}).map(s=>s.contactId))],sources:sourceViews(citations(tx,ownerId,{candidateId:String(c.id)}))}];
 });
 const memories=tx.all('SELECT * FROM memory WHERE owner_id=? AND scope_kind=? AND contact_id IS ? ORDER BY id',[ownerId,s.scopeKind,s.contactId]).map(m=>{
  const versions=tx.all('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? ORDER BY version_no',[ownerId,m.id]).map(v=>{
   try{if(v.content_state==='present')requireVersion(tx,ownerId,m,v);return versionView(tx,ownerId,v);}catch{return {...versionView(tx,ownerId,{...v,body:null,content_state:'redacted'}),sources:[],provenanceState:'invalidated'};}
  });
  const current=m.state==='active'?versions.find(v=>v.versionNo===String(m.current_version_no)&&v.body!==null&&v.provenanceState==='eligible')??null:null;
  const decisions=tx.all('SELECT * FROM memory_decision WHERE owner_id=? AND target_memory_id=? ORDER BY COALESCE(expected_head_revision,-1),id',[ownerId,m.id]).map(d=>({id:String(d.id),action:String(d.action),actorKind:String(d.actor_kind),createdAt:String(d.created_at),expectedHeadRevision:d.expected_head_revision===null?null:String(d.expected_head_revision),expectedVersionNo:d.expected_version_no===null?null:String(d.expected_version_no),outcome:String(d.outcome)}));
  return {id:String(m.id),scopeKind:s.scopeKind,contactId:s.contactId,headRevision:String(m.head_revision),state:String(m.state),manualProtection:m.manual_protection===1n,current,versions,decisions};
 });return {candidates,memories};
}
