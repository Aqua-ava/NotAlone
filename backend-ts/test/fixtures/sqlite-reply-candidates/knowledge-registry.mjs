import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {createReplyCandidateActions} from '../../../src/reply/sqlite/candidates/actions.ts';
import {encode} from '../../../src/reply/sqlite/requests.ts';
import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';
const itemId='e1111111-1111-4111-8111-111111111111',publicationId='e2222222-2222-4222-8222-222222222222';
function current(tx,scope){
 const c=tx.get('SELECT * FROM synthetic_reply_publisher WHERE owner_id=? AND target_contact_id=?',[scope.ownerId,scope.contactId]);if(!c||c.mode==='none')return null;
 const s=tx.get("SELECT r.id record_id,r.message_id,m.interpretation_revision FROM capture_record r JOIN message m ON m.owner_id=r.owner_id AND m.id=r.message_id WHERE r.owner_id=? AND r.contact_id=? AND r.availability='available' AND m.availability='available' LIMIT 1",[scope.ownerId,c.source_contact_id]);if(!s)return null;
 return {kind:c.mode.startsWith('document')?'document':c.mode==='unconfirmed'?'memory_candidate':'memory',id:itemId,versionNo:1n,scopeKind:c.mode==='owner'?'owner':'contact',contactId:c.mode==='owner'?null:scope.contactId,publicationId:c.mode.startsWith('document')?publicationId:null,text:c.mode.startsWith('document')?'合成已发布场景：周末一起散步。':c.mode==='unconfirmed'?'合成待确认记忆：可能喜欢散步。':'合成本人已采纳资料：喜欢安静散步。',qualification:c.mode.startsWith('document')?'published':c.mode==='unconfirmed'?'unconfirmed':'auto',sources:[{contactId:String(c.source_contact_id),messageId:String(s.message_id),recordId:String(s.record_id),acceptedRevision:s.interpretation_revision}]};
}
const reader={read(tx,scope){const item=current(tx,scope);return item?[item]:[];},requireCurrent(tx,scope,item){const c=tx.get('SELECT * FROM synthetic_reply_publisher WHERE owner_id=? AND target_contact_id=?',[scope.ownerId,scope.contactId]),expected=current(tx,scope);if(!c||c.eligible!==1n||c.mode==='document_wrong_publication'||!expected||encode(item)!==encode(expected))throw new StorageFailure('synthetic_publication_unavailable');}};
export const registry={migrations:[...base.migrations,{version:base.migrations.length+1,sql:'CREATE TABLE synthetic_reply_publisher(owner_id TEXT PRIMARY KEY,target_contact_id TEXT NOT NULL,source_contact_id TEXT NOT NULL,mode TEXT NOT NULL,eligible INTEGER NOT NULL) STRICT;'}],actions:[...base.actions.filter(a=>!a.name.startsWith('reply.')),...createReplyCandidateActions(reader),
 {name:'synthetic.publishReplyKnowledge',mode:'write',retryBusy:false,execute(tx,i){tx.run('INSERT OR REPLACE INTO synthetic_reply_publisher VALUES(?,?,?,?,1)',[i.ownerId,i.contactId,i.sourceContactId,i.mode]);}},
 {name:'synthetic.invalidateReplyKnowledge',mode:'write',retryBusy:false,execute(tx,i){tx.run('UPDATE synthetic_reply_publisher SET eligible=0 WHERE owner_id=?',[i.ownerId]);tx.run('UPDATE owner SET memory_revision=memory_revision+1 WHERE owner_id=?',[i.ownerId]);}},
 {name:'synthetic.eraseReplyPart',mode:'write',retryBusy:false,execute(tx,i){tx.run('DELETE FROM reply_version_part WHERE owner_id=? AND candidate_id=? AND version_no=? AND part_no=?',[i.ownerId,i.candidateId,i.versionNo,i.partNo]);}},
]};
