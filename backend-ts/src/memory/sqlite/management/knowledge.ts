import {assertSourceEligibility,type SourceEligibility} from '../../../history/sqlite/source.ts';
import {sourceVerificationState} from './evidence.ts';
import {mergeKnowledgeSources} from './dependencies.ts';
import type {StorageRow,StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {DiscussionScope} from '../../../reply/sqlite/contracts.ts';
import type {ReplyKnowledgeHeader,ReplyKnowledgeItem,ReplyMemoryReader,ReplySource} from '../../../reply/sqlite/candidates/contracts.ts';
import {available,fail,requireAutomaticCandidate,requireVersion} from './qualification.ts';
import {memoryTimeEligibility} from './temporal.ts';
/** identity_json保留额外修订；版本不变的保护操作也必须使旧快照失效。 */
export interface MemoryKnowledgeItem extends ReplyKnowledgeItem {headRevision:bigint;citationSources:ReplySource[];qualificationSources:ReplySource[]}
const knowledgeSources=(rows:StorageRow[])=>rows.map(r=>({contactId:String(r.source_contact_id),messageId:String(r.message_id),recordId:String(r.record_id),acceptedRevision:r.accepted_revision as bigint}));
function availableScope(tx:StorageTransaction,scope:DiscussionScope):boolean{
 available(tx,scope.ownerId,{scopeKind:'contact',contactId:scope.contactId});
 return !tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed'",[scope.ownerId]);
}
/** 仅按精确身份物化；旧候选分支只供历史冻结材料复验，不提供新输入入口。 */
function frozenItem(tx:StorageTransaction,scope:DiscussionScope,selected:Pick<ReplyKnowledgeItem,'kind'|'id'>,sourceEligibility:SourceEligibility):MemoryKnowledgeItem|null{
 const ownerId=scope.ownerId;if(!availableScope(tx,scope))return null;
 try{
  if(selected.kind==='memory'){
   const m=tx.get("SELECT * FROM memory WHERE owner_id=? AND state='active' AND (scope_kind='self' OR contact_id=?) AND id=?",[ownerId,scope.contactId,selected.id]);if(!m)return null;
   const v=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,m.id,m.current_version_no]);if(!v)return null;
   if(memoryTimeEligibility(tx,ownerId,{memoryId:String(m.id),versionNo:v.version_no as bigint})!=='eligible')return null;
   if(v.adoption_mode==='auto'&&sourceVerificationState(tx,ownerId,{memoryId:String(m.id),versionNo:v.version_no as bigint},sourceEligibility)!=='verified')return null;
   const proof=requireVersion(tx,ownerId,m,v,sourceEligibility),citations=knowledgeSources(proof.citations),dependencies=proof.dependencies;
   return {kind:'memory',id:String(m.id),versionNo:v.version_no as bigint,headRevision:m.head_revision as bigint,scopeKind:m.scope_kind==='self'?'owner':'contact',contactId:m.contact_id as string|null,publicationId:null,text:String(v.body),qualification:v.adoption_mode==='auto'?'auto':'confirmed',sources:mergeKnowledgeSources(citations,dependencies),citationSources:citations,qualificationSources:dependencies};
  }
  if(selected.kind==='memory_candidate'){
   const c=tx.get("SELECT * FROM memory_candidate WHERE owner_id=? AND state='pending' AND (scope_kind='self' OR contact_id=?) AND id=?",[ownerId,scope.contactId,selected.id]);if(!c)return null;
   if(memoryTimeEligibility(tx,ownerId,{candidateId:String(c.id)})!=='eligible')return null;
   const proof=requireAutomaticCandidate(tx,ownerId,c,sourceEligibility),citations=knowledgeSources(proof.citations),dependencies=proof.dependencies;
   return {kind:'memory_candidate',id:String(c.id),versionNo:1n,headRevision:c.state_revision as bigint,scopeKind:c.scope_kind==='self'?'owner':'contact',contactId:c.contact_id as string|null,publicationId:null,text:String(c.proposed_body),qualification:'unconfirmed',sources:mergeKnowledgeSources(citations,dependencies),citationSources:citations,qualificationSources:dependencies};
  }
 }catch{/* 失效来源不进入生成或历史回看；不在读取时补证或改变正文。 */}
 return null;
}
/** 头部仅供正式记忆排序；时间、来源及版本在 open 中定向核验。 */
function headers(tx:StorageTransaction,scope:DiscussionScope):ReplyKnowledgeHeader[]{
 if(!availableScope(tx,scope))return [];
 return tx.all(`SELECT m.id,m.scope_kind,m.contact_id,v.version_no,v.body,v.adoption_mode FROM memory m JOIN memory_version v ON v.owner_id=m.owner_id AND v.memory_id=m.id AND v.version_no=m.current_version_no
  WHERE m.owner_id=? AND m.state='active' AND (m.scope_kind='self' OR m.contact_id=?) ORDER BY m.id`,[scope.ownerId,scope.contactId])
  .map(m=>({kind:'memory',id:String(m.id),versionNo:m.version_no as bigint,scopeKind:m.scope_kind==='self'?'owner':'contact',contactId:m.contact_id as string|null,text:String(m.body),qualification:m.adoption_mode==='auto'?'auto':'confirmed'}));
}
export function createMemoryKnowledgeReader(sourceEligibility:SourceEligibility=assertSourceEligibility):ReplyMemoryReader{return {
 list:headers,
 open(tx,scope,header){
  if(header.kind!=='memory')return null;
  const found=frozenItem(tx,scope,header,sourceEligibility);
  return found&&found.versionNo===header.versionNo&&found.text===header.text?found:null;
 },
 requireCurrent(tx,scope,item){
  const found=frozenItem(tx,scope,item,sourceEligibility);
  const revision=(item as MemoryKnowledgeItem).headRevision;
  const sameSources=(a:ReplyKnowledgeItem,b:ReplyKnowledgeItem)=>JSON.stringify(a.sources,(_k,v)=>typeof v==='bigint'?v.toString():v)===JSON.stringify(b.sources,(_k,v)=>typeof v==='bigint'?v.toString():v);
  if(!found||found.versionNo!==item.versionNo||found.headRevision!==revision||found.scopeKind!==item.scopeKind||found.contactId!==item.contactId||found.qualification!==item.qualification||found.publicationId!==item.publicationId||found.text!==item.text||!sameSources(found,item))fail('memory_knowledge_stale');
 },
};}
export const memoryKnowledgeReader=createMemoryKnowledgeReader();
