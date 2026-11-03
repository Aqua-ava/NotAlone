import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {hasCurrentReplyDependencies} from '../../../src/reply/sqlite/provenance.ts';
import {createReplyKnowledgeStorageRegistry} from '../../../src/reply/sqlite/candidates/knowledge-context.ts';
import {replyLocalKnowledgeReader} from '../../../src/memory/sqlite/documents/knowledge.ts';
export const registry=createReplyKnowledgeStorageRegistry({migrations:base.migrations,actions:[...base.actions,
 {name:'fixture.seedCrossContactInput',mode:'write',retryBusy:false,execute(tx,i){
  const message=tx.get('SELECT interpretation_revision FROM message WHERE owner_id=? AND contact_id=? AND id=?',[i.ownerId,i.sourceContactId,i.messageId]);
  // 此夹具只构造跨联系人实际来源，不伪造正式记忆身份或采纳证明。
  tx.run("INSERT INTO reply_candidate_input VALUES(?,?,1,'message','{}','合成跨联系人来源')",[i.ownerId,i.contextId]);
  tx.run('INSERT INTO reply_candidate_input_source VALUES(?,?,1,?,?,?,?)',[i.ownerId,i.contextId,i.sourceContactId,i.recordId,i.messageId,message.interpretation_revision]);
 }},
 {name:'fixture.quarantineImpact',mode:'read',retryBusy:false,execute(tx,i){
  // 测试可枚举自有合成库；产品热路径仍只检查当前请求的实际依赖。
  const contexts=tx.all('SELECT id FROM reply_context WHERE owner_id=?',[i.ownerId]).map(row=>String(row.id)).filter(id=>!hasCurrentReplyDependencies(tx,{ownerId:i.ownerId,contextIds:[id]}));
  const requests=tx.all('SELECT id FROM reply_request WHERE owner_id=?',[i.ownerId]).map(row=>String(row.id)).filter(id=>!hasCurrentReplyDependencies(tx,{ownerId:i.ownerId,requestIds:[id]}));
  const copies=tx.all('SELECT id FROM runtime_copy WHERE owner_id=?',[i.ownerId]).map(row=>String(row.id)).filter(id=>!hasCurrentReplyDependencies(tx,{ownerId:i.ownerId,copyIds:[id]}));
  return {requests,contexts,copies};
 }},
]},replyLocalKnowledgeReader);
