import {registry as base} from '../sqlite-reply-candidates/knowledge-registry.mjs';
import {requireCurrentReplyDependencies,hasCurrentReplyDependencies} from '../../../src/reply/sqlite/provenance.ts';

export const registry={migrations:base.migrations,actions:[...base.actions,
 {name:'provenanceTest.check',mode:'read',retryBusy:false,execute(tx,i){
  requireCurrentReplyDependencies(tx,i);return true;
 }},
 {name:'provenanceTest.sourceUnavailable',mode:'write',retryBusy:false,execute(tx,i){
  tx.run("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND contact_id=? AND id=?",[i.ownerId,i.contactId,i.recordId]);
 }},
 {name:'provenanceTest.guardLost',mode:'write',retryBusy:false,execute(tx,i){
  // 合成渠道没有长连接守卫；在真实表中模拟该联系人的守卫失证状态。
  tx.run(`INSERT INTO history_guard_lease(owner_id,contact_id,binding_id,conversation_id,source_generation,guard_id,runtime_id,state)
   SELECT b.owner_id,b.contact_id,b.id,b.conversation_id,a.source_generation,'synthetic-lost-guard',d.runtime_id,'lost'
   FROM conversation_binding b JOIN channel_conversation c ON c.owner_id=b.owner_id AND c.id=b.conversation_id
   JOIN channel_account a ON a.owner_id=c.owner_id AND a.id=c.account_id JOIN database_instance d ON d.slot=1
   WHERE b.owner_id=? AND b.contact_id=? ON CONFLICT(owner_id,contact_id) DO UPDATE SET state='lost'`,[i.ownerId,i.contactId]);
 }},
 {name:'provenanceTest.messageChanged',mode:'write',retryBusy:false,execute(tx,i){
  tx.run('UPDATE message SET interpretation_revision=interpretation_revision+1 WHERE owner_id=? AND contact_id=? AND id=?',[i.ownerId,i.contactId,i.messageId]);
 }},
 {name:'provenanceTest.copyContexts',mode:'write',retryBusy:false,execute(tx,i){
  // 仅模拟SDK已实际纳入的上下文清单，不构造磁盘副本或执行模型。
  for(const [index,contextId] of i.contextIds.entries())tx.run("INSERT INTO runtime_context(owner_id,copy_id,incorporation_no,context_id,provenance_state) VALUES(?,?,?,?,'verified')",[i.ownerId,i.copyId,index+1,contextId]);
 }},
 {name:'provenanceTest.inspect',mode:'read',retryBusy:false,execute(tx,i){
  let readRows=0;
  const measured={run:tx.run.bind(tx),get(sql,args){const row=tx.get(sql,args);readRows+=row?1:0;return row;},all(sql,args){const rows=tx.all(sql,args);readRows+=rows.length;return rows;}};
  const current=hasCurrentReplyDependencies(measured,i);return {current,readRows};
 }},
]};
