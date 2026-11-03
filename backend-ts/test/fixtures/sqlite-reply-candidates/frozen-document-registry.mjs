import {decode} from '../../../src/reply/sqlite/requests.ts';
import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {createReplyKnowledgeStorageRegistry} from '../../../src/reply/sqlite/candidates/knowledge-context.ts';
import {documentKnowledgeReader,replyLocalKnowledgeReader} from '../../../src/memory/sqlite/documents/knowledge.ts';
export const registry=createReplyKnowledgeStorageRegistry({...base,actions:[...base.actions,
 {name:'frozenDocumentTest.input',mode:'read',retryBusy:false,execute:(tx,i)=>tx.all('SELECT x.* FROM reply_candidate_input x JOIN reply_context c ON c.owner_id=x.owner_id AND c.id=x.context_id WHERE c.owner_id=? AND c.discussion_id=? ORDER BY x.item_no',[i.ownerId,i.discussionId])},
 {name:'frozenDocumentTest.batchPublications',mode:'read',retryBusy:false,execute(tx,i){
  const current=replyLocalKnowledgeReader.read(tx,i).filter(item=>item.kind==='document');
  const previous=i.currentOnly?[]:tx.all("SELECT x.identity_json FROM reply_candidate_input x JOIN reply_context c ON c.owner_id=x.owner_id AND c.id=x.context_id WHERE c.owner_id=? AND c.discussion_id=? AND x.kind='document' ORDER BY x.item_no",[i.ownerId,i.discussionId]).map(row=>decode(String(row.identity_json)));
  replyLocalKnowledgeReader.requireFrozenBatch(tx,i,[...previous,...current]);
  const reusedVersions=current.filter(item=>previous.some(prior=>prior.id===item.id&&prior.versionNo===item.versionNo&&prior.publicationId!==item.publicationId)).length;
  return {publicationIds:[...new Set([...previous,...current].map(item=>item.publicationId))],reusedVersions};
 }},
 {name:'frozenDocumentTest.removePublicationMember',mode:'write',retryBusy:false,execute(tx,i){
  // 只在隔离库损坏指定旧集合，确认完整新集合不能替代它的资格。
  const member=tx.get('SELECT document_id FROM publication_member WHERE owner_id=? AND publication_id=? ORDER BY document_id LIMIT 1',[i.ownerId,i.publicationId]);
  if(!member)throw Error('synthetic_member_missing');tx.run('DELETE FROM publication_member WHERE owner_id=? AND publication_id=? AND document_id=?',[i.ownerId,i.publicationId,member.document_id]);
 }},
 {name:'frozenDocumentTest.local',mode:'read',retryBusy:false,execute:(tx,i)=>replyLocalKnowledgeReader.read(tx,i)},
 {name:'frozenDocumentTest.strict',mode:'read',retryBusy:false,execute:(tx,i)=>documentKnowledgeReader.read(tx,i)},
 {name:'frozenDocumentTest.guardLost',mode:'write',retryBusy:false,execute(tx,{ownerId,contactId}){
  // 合成渠道没有常驻守卫；模拟真实表中的失证状态，不改本机消息或资料资格。
  tx.run(`INSERT INTO history_guard_lease(owner_id,contact_id,binding_id,conversation_id,source_generation,guard_id,runtime_id,state)
   SELECT b.owner_id,b.contact_id,b.id,b.conversation_id,a.source_generation,'synthetic-frozen-guard',d.runtime_id,'lost'
   FROM conversation_binding b JOIN channel_conversation c ON c.owner_id=b.owner_id AND c.id=b.conversation_id
   JOIN channel_account a ON a.owner_id=c.owner_id AND a.id=c.account_id JOIN database_instance d ON d.slot=1
   WHERE b.owner_id=? AND b.contact_id=? ON CONFLICT(owner_id,contact_id) DO UPDATE SET state='lost'`,[ownerId,contactId]);
 }},
]},replyLocalKnowledgeReader);
