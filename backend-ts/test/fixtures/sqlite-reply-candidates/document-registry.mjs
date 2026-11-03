import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {documentKnowledgeReader} from '../../../src/memory/sqlite/documents/knowledge.ts';
const verify=(tx,scope,items)=>documentKnowledgeReader.requireCurrentBatch?documentKnowledgeReader.requireCurrentBatch(tx,scope,items):items.forEach(item=>documentKnowledgeReader.requireCurrent(tx,scope,item));
export const registry={...base,actions:[...base.actions,
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
