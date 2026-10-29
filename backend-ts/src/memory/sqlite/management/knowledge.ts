import {sourceVerificationState} from './evidence.ts';
import {qualificationSources,mergeKnowledgeSources} from './dependencies.ts';
import type {StorageRow,StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {DiscussionScope} from '../../../reply/sqlite/contracts.ts';
import type {ReplyKnowledgeItem,ReplyKnowledgeReader,ReplySource} from '../../../reply/sqlite/candidates/contracts.ts';
import {available,fail,requireAutomaticCandidate,requireSources,requireVersion} from './qualification.ts';
/** identity_json保留额外修订；版本不变的保护操作也必须使旧快照失效。 */
export interface MemoryKnowledgeItem extends ReplyKnowledgeItem {headRevision:bigint;citationSources:ReplySource[];qualificationSources:ReplySource[]}
const knowledgeSources=(rows:StorageRow[])=>rows.map(r=>({contactId:String(r.source_contact_id),messageId:String(r.message_id),recordId:String(r.record_id),acceptedRevision:r.accepted_revision as bigint}));
function items(tx:StorageTransaction,scope:DiscussionScope,includeUnconfirmed:boolean):MemoryKnowledgeItem[]{
 const ownerId=scope.ownerId;available(tx,ownerId,{scopeKind:'contact',contactId:scope.contactId});
 if(tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed'",[ownerId]))return [];
 const result:MemoryKnowledgeItem[]=[];
 for(const m of tx.all("SELECT * FROM memory WHERE owner_id=? AND state='active' AND (scope_kind='self' OR contact_id=?) ORDER BY id",[ownerId,scope.contactId])){
  const v=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,m.id,m.current_version_no]);if(!v)continue;
  try{
   if(v.adoption_mode==='auto'&&sourceVerificationState(tx,ownerId,{memoryId:String(m.id),versionNo:v.version_no as bigint})!=='verified')continue;
   const rows=requireVersion(tx,ownerId,m,v),citations=knowledgeSources(rows),dependencies=qualificationSources(tx,ownerId,{memoryId:String(m.id),versionNo:v.version_no as bigint});
   result.push({kind:'memory',id:String(m.id),versionNo:v.version_no as bigint,headRevision:m.head_revision as bigint,scopeKind:m.scope_kind==='self'?'owner':'contact',contactId:m.contact_id as string|null,publicationId:null,text:String(v.body),qualification:v.adoption_mode==='auto'?'auto':'confirmed',sources:mergeKnowledgeSources(citations,dependencies),citationSources:citations,qualificationSources:dependencies});
  }catch{/* 失效来源不进入生成；不在读取时补证或改变正文。 */}
 }
 if(includeUnconfirmed)for(const c of tx.all("SELECT * FROM memory_candidate WHERE owner_id=? AND state='pending' AND (scope_kind='self' OR contact_id=?) ORDER BY id",[ownerId,scope.contactId])){
  try{requireAutomaticCandidate(tx,ownerId,c);const rows=requireSources(tx,ownerId,{candidateId:String(c.id)}),citations=knowledgeSources(rows),dependencies=qualificationSources(tx,ownerId,{candidateId:String(c.id)});
   result.push({kind:'memory_candidate',id:String(c.id),versionNo:1n,headRevision:c.state_revision as bigint,scopeKind:c.scope_kind==='self'?'owner':'contact',contactId:c.contact_id as string|null,publicationId:null,text:String(c.proposed_body),qualification:'unconfirmed',sources:mergeKnowledgeSources(citations,dependencies),citationSources:citations,qualificationSources:dependencies});
  }catch{/* 被拒绝／资格失效的候选没有参考资格。 */}
 }
 return result;
}
export function createMemoryKnowledgeReader(options={includeUnconfirmed:false}):ReplyKnowledgeReader{return {
 read:(tx,scope)=>items(tx,scope,options.includeUnconfirmed),
 requireCurrent(tx,scope,item){
  const found=items(tx,scope,options.includeUnconfirmed).find(k=>k.kind===item.kind&&k.id===item.id);
  const revision=(item as MemoryKnowledgeItem).headRevision;
  const sameSources=(a:ReplyKnowledgeItem,b:ReplyKnowledgeItem)=>JSON.stringify(a.sources,(_k,v)=>typeof v==='bigint'?v.toString():v)===JSON.stringify(b.sources,(_k,v)=>typeof v==='bigint'?v.toString():v);
  if(!found||found.versionNo!==item.versionNo||found.headRevision!==revision||found.scopeKind!==item.scopeKind||found.contactId!==item.contactId||found.qualification!==item.qualification||found.publicationId!==item.publicationId||found.text!==item.text||!sameSources(found,item))fail('memory_knowledge_stale');
 },
};}
export const memoryKnowledgeReader=createMemoryKnowledgeReader();
