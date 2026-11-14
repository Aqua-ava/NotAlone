import type {ReplyKnowledgeItem} from './candidates/contracts.ts';
import {currentReplyKnowledgeReader} from './candidates/knowledge-context.ts';
import {StorageFailure,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {assertReplyLocalSources} from '../../history/sqlite/reply-local-source.ts';
import type {MessageSourceReference} from '../../history/sqlite/contracts.ts';
import {requireFrozenReplyKnowledge} from './candidates/validation.ts';

export interface ReplyDependencyScope {ownerId:string;contextIds?:readonly string[];requestIds?:readonly string[];copyIds?:readonly string[]}
interface AcceptedSource extends MessageSourceReference {acceptedRevision:bigint}
function unavailable():never {throw new StorageFailure('history_source_not_available');}

/** 只核本次实际依赖；全用户的删除影响传播由删除流程另行承担。 */
export function requireCurrentReplyDependencies(tx:StorageTransaction,scope:ReplyDependencyScope):void {
 const {ownerId}=scope,pending=new Set(scope.contextIds),requests=new Set<string>(),sources=new Map<string,AcceptedSource>();
 const hasCandidateSources=Boolean(tx.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reply_candidate_input_source'"));
 const includeRequest=(requestId:string)=>{
  if(requests.has(requestId))return;requests.add(requestId);
  const request=tx.get('SELECT state FROM reply_request WHERE owner_id=? AND id=?',[ownerId,requestId]);
  if(!request||request.state==='invalidated')unavailable();
  for(const row of tx.all('SELECT id FROM reply_context WHERE owner_id=? AND request_id=?',[ownerId,requestId]))pending.add(String(row.id));
 };
 for(const requestId of scope.requestIds??[])includeRequest(requestId);
 for(const copyId of scope.copyIds??[]){
  if(!tx.get('SELECT 1 FROM runtime_copy WHERE owner_id=? AND id=?',[ownerId,copyId]))unavailable();
  for(const row of tx.all('SELECT context_id,provenance_state FROM runtime_context WHERE owner_id=? AND copy_id=?',[ownerId,copyId])){
   if(row.provenance_state!=='verified')unavailable();pending.add(String(row.context_id));
  }
 }
 for(const contextId of pending){
  const context=tx.get('SELECT state,request_id,contact_id,discussion_id FROM reply_context WHERE owner_id=? AND id=?',[ownerId,contextId]);
  if(!context||context.state!=='active')unavailable();
  if(context.request_id!==null)includeRequest(String(context.request_id));
  if(hasCandidateSources){
   const identities=tx.all("SELECT identity_json FROM reply_candidate_input WHERE owner_id=? AND context_id=? AND kind IN ('memory','memory_candidate','document')",[ownerId,contextId])
    .map(item=>JSON.parse(String(item.identity_json),(_key,value)=>value&&typeof value==='object'&&Object.keys(value).length===1&&typeof value.$integer==='string'?BigInt(value.$integer):value) as ReplyKnowledgeItem);
   try{
    const reader=currentReplyKnowledgeReader(),knowledgeScope={ownerId,contactId:String(context.contact_id),discussionId:String(context.discussion_id)};
    requireFrozenReplyKnowledge(tx,knowledgeScope,identities,reader);
   }catch{unavailable();}
  }
  const rows=tx.all(`SELECT source_contact_id,record_id,message_id,accepted_revision FROM reply_context_item WHERE owner_id=? AND context_id=? AND kind='message'
   ${hasCandidateSources?'UNION SELECT source_contact_id,record_id,message_id,accepted_revision FROM reply_candidate_input_source WHERE owner_id=? AND context_id=?':''}`,
   hasCandidateSources?[ownerId,contextId,ownerId,contextId]:[ownerId,contextId]);
  for(const row of rows){
   const source={owner_id:ownerId,contact_id:String(row.source_contact_id),record_id:String(row.record_id),message_id:String(row.message_id),acceptedRevision:row.accepted_revision as bigint};
   sources.set(JSON.stringify([source.contact_id,source.record_id,source.message_id,String(source.acceptedRevision)]),source);
  }
  // 旧讨论正文和明确携入的选稿也携带原请求的实际资料，不能当作新的无来源文字。
  for(const entry of tx.all(`SELECT e.id,e.role,e.content_state,e.origin_request_id FROM reply_context_item x
   LEFT JOIN discussion_entry e ON e.owner_id=x.owner_id AND e.id=x.entry_id
   WHERE x.owner_id=? AND x.context_id=? AND x.kind='entry'`,[ownerId,contextId])){
   if(!entry.id||entry.content_state!=='available')unavailable();
   if(entry.role==='assistant')includeRequest(String(entry.origin_request_id));
  }
  if(hasCandidateSources)for(const item of tx.all("SELECT identity_json FROM reply_candidate_input WHERE owner_id=? AND context_id=? AND kind='selection'",[ownerId,contextId])){
   const identity=JSON.parse(String(item.identity_json)) as {selectionId?:unknown};
   if(typeof identity.selectionId!=='string')unavailable();
   const selected=tx.get(`SELECT s.request_id FROM reply_selection s JOIN reply_candidate_version v
    ON v.owner_id=s.owner_id AND v.candidate_id=s.candidate_id AND v.version_no=s.version_no
    WHERE s.owner_id=? AND s.id=? AND v.content_state='available'`,[ownerId,identity.selectionId]);
   if(!selected)unavailable();includeRequest(String(selected.request_id));
  }
 }
 const refs=[...sources.values()];assertReplyLocalSources(tx,refs);
 for(let offset=0;offset<refs.length;offset+=200){
  const batch=refs.slice(offset,offset+200);
  const invalid=tx.get(`WITH expected(contact_id,message_id,revision) AS (VALUES ${batch.map(()=>'(?,?,?)').join(',')})
   SELECT 1 FROM expected e LEFT JOIN message m ON m.owner_id=? AND m.contact_id=e.contact_id AND m.id=e.message_id
   WHERE m.id IS NULL OR m.interpretation_revision<>e.revision LIMIT 1`,[...batch.flatMap(ref=>[ref.contact_id,ref.message_id,ref.acceptedRevision]),ownerId]);
  if(invalid)unavailable();
 }
}

export function hasCurrentReplyDependencies(tx:StorageTransaction,scope:ReplyDependencyScope):boolean {
 try{requireCurrentReplyDependencies(tx,scope);return true;}
 catch(error){if(error instanceof StorageFailure&&error.code==='history_source_not_available')return false;throw error;}
}
