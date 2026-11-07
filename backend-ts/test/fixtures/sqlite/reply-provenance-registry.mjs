import {simulateSourceGuard} from '../history/runtime-guard-fixture.mjs';
import {createReplyKnowledgeStorageRegistry} from '../../../src/reply/sqlite/candidates/knowledge-context.ts';
import {registry as base,reader} from '../sqlite-reply-candidates/knowledge-registry.mjs';
import {requireCurrentReplyDependencies,hasCurrentReplyDependencies} from '../../../src/reply/sqlite/provenance.ts';

export const registry=createReplyKnowledgeStorageRegistry({migrations:base.migrations,actions:[...base.actions,
 {name:'provenanceTest.check',mode:'read',retryBusy:false,execute(tx,i){
  requireCurrentReplyDependencies(tx,i);return true;
 }},
 {name:'provenanceTest.sourceUnavailable',mode:'write',retryBusy:false,execute(tx,i){
  tx.run("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND contact_id=? AND id=?",[i.ownerId,i.contactId,i.recordId]);
 }},
 {name:'provenanceTest.guardLost',mode:'write',retryBusy:false,execute(tx,i){
  // 合成渠道没有长连接守卫；在Worker内模拟该联系人的易失守卫丢失。
  simulateSourceGuard(tx,{ownerId:i.ownerId,contactId:i.contactId});
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
]},reader);
