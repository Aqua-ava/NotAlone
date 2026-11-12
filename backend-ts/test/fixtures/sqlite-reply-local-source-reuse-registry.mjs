import {randomUUID} from 'node:crypto';
import {registry as base} from '../../src/storage/sqlite/registry.ts';
import {withReplyLocalSourceEligibility} from '../../src/history/sqlite/reply-local-source.ts';
import {createReplyCandidateActions} from '../../src/reply/sqlite/candidates/actions.ts';

const freeze=base.actions.find(action=>action.name==='reply.freezeInput');
const assertInput=base.actions.find(action=>action.name==='reply.assertInput');
export const registry={...base,actions:[...base.actions,{
 name:'fixture.replySourceReferences',mode:'read',retryBusy:false,
 execute(tx,i){return tx.all(`SELECT r.owner_id,r.contact_id,r.id record_id,r.message_id,m.interpretation_revision,m.text_body
  FROM capture_record r JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id
  WHERE r.owner_id=? AND r.contact_id=? AND m.kind='text' ORDER BY r.id`,[i.ownerId,i.contactId]);},
},{
 name:'fixture.attachReplySources',mode:'write',retryBusy:false,
 execute(tx,i){for(const source of i.sources){
  tx.run('INSERT INTO memory_required_message VALUES(?,?,NULL,?,1,?,?)',[i.ownerId,randomUUID(),i.memoryId,source.contact_id,source.message_id]);
  tx.run('INSERT INTO memory_citation(owner_id,id,memory_id,version_no,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end) VALUES(?,?,?,1,?,?,?,?,0,?)',
   [i.ownerId,randomUUID(),i.memoryId,source.contact_id,source.message_id,source.record_id,source.interpretation_revision,BigInt([...source.text_body].length)]);
 }},
},{
 name:'fixture.freezeReplyMeasured',mode:'write',retryBusy:false,
 execute(tx,i,lease){
  let sourceQueries=0,queries=0;
  const counted={...tx};for(const method of ['get','all','run'])counted[method]=(sql,values)=>{
   queries++;if(sql.includes('wanted AS ('))sourceQueries++;return tx[method](sql,values);
  };
  const start=performance.now(),items=freeze.execute(counted,i,lease);
  return {sourceQueries,queries,elapsedMs:performance.now()-start,memories:items.filter(item=>item.kind==='memory').map(item=>({id:item.identity.id,sources:item.sources.length}))};
 },
},{
 name:'fixture.reviseFrozenReply',mode:'write',retryBusy:false,
 execute(tx,i,lease){return withReplyLocalSourceEligibility(tx,scoped=>{
  const before=assertInput.execute(scoped,i,lease),source=tx.get('SELECT source_contact_id,message_id FROM reply_candidate_input_source WHERE owner_id=? AND context_id=? LIMIT 1',[i.ownerId,i.contextId]);
  scoped.run('UPDATE message SET interpretation_revision=interpretation_revision+1 WHERE owner_id=? AND contact_id=? AND id=?',[i.ownerId,source.source_contact_id,source.message_id]);
  try{assertInput.execute(scoped,i,lease);return {before,errorCode:null};}catch(error){return {before,errorCode:error.code};}
 });},
},{
 name:'fixture.memoryPoolReads',mode:'read',retryBusy:false,
 execute(tx,i,lease){
  const calls={list:0,read:0,documents:0},items=[{kind:'memory',id:'synthetic-memory',versionNo:1n,text:'合成记忆头部'},{kind:'memory_candidate',id:'synthetic-candidate',versionNo:1n,text:'未确认候选'},{kind:'document',id:'synthetic-document',versionNo:1n,text:'文档不进入语义记忆池'}];
  const reader={read(){calls.read++;return items;},readDocuments(){calls.documents++;return [];},open(){throw new Error('语义记忆池不核验来源正文');},requireCurrent(){},...(i.legacy?{}:{list(){calls.list++;return items;}})};
  const action=createReplyCandidateActions(reader).find(action=>action.name==='reply.memoryPool');
  return {pool:action.execute(tx,i,lease),calls};
 },
}]};
