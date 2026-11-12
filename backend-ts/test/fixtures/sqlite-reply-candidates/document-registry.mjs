import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {documentKnowledgeReader,replyLocalKnowledgeReader} from '../../../src/memory/sqlite/documents/knowledge.ts';
import {withReplyLocalSourceEligibility,assertReplyLocalSource} from '../../../src/history/sqlite/reply-local-source.ts';
import {documentSources,withSourceMemo} from '../../../src/memory/sqlite/documents/basis.ts';
import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';
const verify=(tx,scope,items)=>documentKnowledgeReader.requireCurrentBatch?documentKnowledgeReader.requireCurrentBatch(tx,scope,items):items.forEach(item=>documentKnowledgeReader.requireCurrent(tx,scope,item));
export const registry={...base,actions:[...base.actions,
 {name:'fixture.measureLocalDocuments',mode:'read',retryBusy:false,execute(tx,scope){
  let queries=0,memoryVerificationReads=0,sourceQueries=0;const counted={...tx};
  for(const method of ['get','all','run'])counted[method]=(sql,values)=>{queries++;if(sql.startsWith('SELECT v.restored_from_version_no,d.action FROM memory_version'))memoryVerificationReads++;if(sql.includes('wanted AS ('))sourceQueries++;return tx[method](sql,values);};
  const start=performance.now(),items=withReplyLocalSourceEligibility(counted,scoped=>replyLocalKnowledgeReader.readDocuments(scoped,scope));
  return {count:items.length,ids:items.map(item=>item.id),queries,memoryVerificationReads,sourceQueries,elapsedMs:performance.now()-start};
 }},
 {name:'fixture.recheckLocalDocumentAfterMutation',mode:'write',retryBusy:false,execute(tx,{scope,mutation}){
  return withReplyLocalSourceEligibility(tx,scoped=>{
   const items=replyLocalKnowledgeReader.readDocuments(scoped,scope),source=items[0].sources[0];
   if(mutation==='revision')scoped.run('UPDATE message SET interpretation_revision=interpretation_revision+1 WHERE owner_id=? AND contact_id=? AND id=?',[scope.ownerId,source.contactId,source.messageId]);
   else scoped.run("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND contact_id=? AND id=?",[scope.ownerId,source.contactId,source.recordId]);
   const remaining=replyLocalKnowledgeReader.readDocuments(scoped,scope).length;
   try{replyLocalKnowledgeReader.requireFrozenBatch(scoped,scope,items);return {remaining,errorCode:null};}catch(error){return {remaining,errorCode:error.code};}
  });
 }},
 {name:'fixture.localDocumentMemoPolicy',mode:'read',retryBusy:false,execute(tx,scope){
  const item=replyLocalKnowledgeReader.readDocuments(tx,scope)[0],check=(readTx,policy)=>documentSources(readTx,scope.ownerId,item.id,item.versionNo,new Set(),new Map(),policy);
  return withSourceMemo(()=>{
   check(tx,assertReplyLocalSource);
   const outcome=(readTx,policy)=>{try{check(readTx,policy);return null;}catch(error){return error.code;}};
   const rejecting=()=>{throw new StorageFailure('synthetic_policy_rejected');};
   const otherTx={...tx,get(sql,values){if(sql.includes('wanted AS ('))return undefined;return tx.get(sql,values);}};
   return {otherPolicy:outcome(tx,rejecting),otherTransaction:outcome(otherTx,assertReplyLocalSource)};
  },tx,assertReplyLocalSource);
 }},
 {name:'fixture.measureDocuments',mode:'read',execute(tx,scope){
  let queries=0;const counted={...tx};for(const method of ['get','all','run'])counted[method]=(sql,values)=>{queries++;return tx[method](sql,values);};
  const start=performance.now(),items=documentKnowledgeReader.read(counted,scope),readMs=performance.now()-start,readQueries=queries;
  verify(counted,scope,items);
  return {count:items.length,ids:items.map(item=>item.id),readQueries,verifyQueries:queries-readQueries,readMs,verifyMs:performance.now()-start-readMs};
 }},
 {name:'fixture.requireDocuments',mode:'read',execute(tx,i){verify(tx,i,i.items);return true;}},
 {name:'fixture.recheckAfterSourceMutation',mode:'write',execute(tx,scope){
  const items=documentKnowledgeReader.read(tx,scope);verify(tx,scope,items);const source=items[0].sources[0];
  tx.run('UPDATE message SET interpretation_revision=interpretation_revision+1 WHERE owner_id=? AND contact_id=? AND id=?',[scope.ownerId,source.contactId,source.messageId]);
  try{verify(tx,scope,items);return null;}catch(error){return error.code;}
 }},
 {name:'fixture.budgets',mode:'read',execute:(tx,i)=>tx.all('SELECT receipt FROM model_call WHERE owner_id=? AND reply_context_id IS NOT NULL',[i.ownerId]).map(row=>JSON.parse(String(row.receipt)).inputBudget)},
 {name:'fixture.knowledge',mode:'read',execute:(tx,i)=>documentKnowledgeReader.read(tx,i)},
 {name:'fixture.readDocument',mode:'read',execute:(tx,i)=>documentKnowledgeReader.readDocument(tx,i,i.item,i.range)},
 {name:'fixture.requireDocument',mode:'read',execute(tx,i){documentKnowledgeReader.requireCurrent(tx,i,i.item);return true;}},
 {name:'fixture.input',mode:'read',execute:(tx,i)=>tx.all('SELECT x.* FROM reply_candidate_input x JOIN reply_context c ON c.owner_id=x.owner_id AND c.id=x.context_id WHERE c.owner_id=? AND c.discussion_id=? ORDER BY x.item_no',[i.ownerId,i.discussionId])},
]};
