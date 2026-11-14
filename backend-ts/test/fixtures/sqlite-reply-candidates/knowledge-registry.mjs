import {createReplyKnowledgeStorageRegistry} from '../../../src/reply/sqlite/candidates/knowledge-context.ts';
import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {createReplyCandidateActions} from '../../../src/reply/sqlite/candidates/actions.ts';
import {encode} from '../../../src/reply/sqlite/requests.ts';
import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';
import {randomUUID} from 'node:crypto';
const itemId='e1111111-1111-4111-8111-111111111111',publicationId='e2222222-2222-4222-8222-222222222222';
function current(tx,scope){
 const c=tx.get('SELECT * FROM synthetic_reply_publisher WHERE owner_id=? AND target_contact_id=?',[scope.ownerId,scope.contactId]);if(!c||c.mode==='none')return null;
 const s=tx.get("SELECT r.id record_id,r.message_id,m.interpretation_revision FROM capture_record r JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id WHERE r.owner_id=? AND r.contact_id=? AND r.availability='available' AND m.availability='available' AND m.kind='text' ORDER BY r.id LIMIT 1",[scope.ownerId,c.source_contact_id]);if(!s)return null;
 return {kind:c.mode.startsWith('document')?'document':c.mode==='unconfirmed'?'memory_candidate':'memory',id:c.memory_id??itemId,versionNo:1n,scopeKind:c.mode==='owner'?'owner':'contact',contactId:c.mode==='owner'?null:scope.contactId,publicationId:c.mode.startsWith('document')?publicationId:null,text:c.mode.startsWith('document')?'合成已发布场景：周末一起散步。':c.mode==='unconfirmed'?'合成待确认记忆：可能喜欢散步。':'合成本人已采纳资料：喜欢安静散步。',qualification:c.mode.startsWith('document')?'published':c.mode==='unconfirmed'?'unconfirmed':'confirmed',sources:[{contactId:String(c.source_contact_id),messageId:String(s.message_id),recordId:String(s.record_id),acceptedRevision:s.interpretation_revision}]};
}
export const reader={read(tx,scope){const item=current(tx,scope);return item?[item]:[];},requireCurrent(tx,scope,item){const c=tx.get('SELECT * FROM synthetic_reply_publisher WHERE owner_id=? AND target_contact_id=?',[scope.ownerId,scope.contactId]),expected=current(tx,scope);if(!c||c.eligible!==1n||c.mode==='document_wrong_publication'||!expected||encode(item)!==encode(expected))throw new StorageFailure('synthetic_publication_unavailable');}};
const manual=base.actions.find(action=>action.name==='memory.applyDecision');
export const registry=createReplyKnowledgeStorageRegistry({migrations:[...base.migrations,{version:base.migrations.length+1,sql:'CREATE TABLE synthetic_reply_publisher(owner_id TEXT PRIMARY KEY,target_contact_id TEXT NOT NULL,source_contact_id TEXT NOT NULL,mode TEXT NOT NULL,eligible INTEGER NOT NULL,memory_id TEXT) STRICT;'}],actions:[...base.actions.filter(a=>!a.name.startsWith('reply.')),...createReplyCandidateActions(reader),
 {name:'synthetic.publishReplyKnowledge',mode:'write',retryBusy:false,execute(tx,i,lease){
  let memoryId=null;
  if(i.mode!=='none'&&i.mode!=='unconfirmed'&&!i.mode.startsWith('document')){
   // 正式L1经过真实记忆版本与索引路径；合成发布控制只保留失效/跨联系人测试所需差异。
   const result=manual.execute(tx,{ownerId:i.ownerId,request:{requestKey:randomUUID(),action:'manual',scope:{scopeKind:i.mode==='owner'?'self':'contact',contactId:i.mode==='owner'?null:i.contactId},body:'合成本人已采纳资料：喜欢安静散步。'}},lease);
   memoryId=result.memoryId;
   const source=tx.get("SELECT r.id record_id,r.message_id,m.interpretation_revision,m.text_body FROM capture_record r JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id WHERE r.owner_id=? AND r.contact_id=? AND r.availability='available' AND m.availability='available' AND m.kind='text' ORDER BY r.id LIMIT 1",[i.ownerId,i.sourceContactId]);
   if(!source)throw new StorageFailure('synthetic_source_missing');
   tx.run('INSERT INTO memory_required_message VALUES(?,?,NULL,?,1,?,?)',[i.ownerId,randomUUID(),memoryId,i.sourceContactId,source.message_id]);
   tx.run('INSERT INTO memory_citation(owner_id,id,memory_id,version_no,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end) VALUES(?,?,?,1,?,?,?,?,0,?)',
    [i.ownerId,randomUUID(),memoryId,i.sourceContactId,source.message_id,source.record_id,source.interpretation_revision,BigInt([...source.text_body].length)]);
  }
  tx.run('INSERT OR REPLACE INTO synthetic_reply_publisher VALUES(?,?,?,?,1,?)',[i.ownerId,i.contactId,i.sourceContactId,i.mode,memoryId]);
 }},
 {name:'synthetic.invalidateReplyKnowledge',mode:'write',retryBusy:false,execute(tx,i){tx.run('UPDATE synthetic_reply_publisher SET eligible=0 WHERE owner_id=?',[i.ownerId]);tx.run('UPDATE owner SET memory_revision=memory_revision+1 WHERE owner_id=?',[i.ownerId]);}},
 {name:'synthetic.eraseReplyPart',mode:'write',retryBusy:false,execute(tx,i){tx.run('DELETE FROM reply_version_part WHERE owner_id=? AND candidate_id=? AND version_no=? AND part_no=?',[i.ownerId,i.candidateId,i.versionNo,i.partNo]);}},
]},reader);
