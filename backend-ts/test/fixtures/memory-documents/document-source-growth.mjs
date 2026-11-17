import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {sourceGrowthFixture} from '../memory-management/adjudication-source-growth.mjs';
import {memoryDocumentsStageActions} from '../../../src/memory/sqlite/documents/stages.ts';

const claimScene=memoryDocumentsStageActions.find(action=>action.name==='memoryDocuments.claim');

/** 复用正式合成候选与同源父池；只领取文档步骤，不调用文档模型。 */
export async function documentSourceGrowthFixture(t,count){
 const f=await sourceGrowthFixture(t,count),candidate=(await f.read()).candidates.find(value=>value.id===f.candidateId);
 assert.ok(candidate);
 await f.management.decide({requestKey:randomUUID(),action:'reject',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));t.after(()=>db.close());
 const all=(sql,values=[])=>{const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all(...values);};
 const get=(sql,values)=>all(sql,values)[0],run=(sql,values=[])=>db.prepare(sql).run(...values);
 const task=get(`SELECT t.id FROM memory_candidate c JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.produced_attempt_id
  JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
  WHERE c.owner_id=? AND c.id=? AND t.scope_kind='contact' AND t.contact_id=? AND t.document_basis_state='pending'`,[f.owner,f.candidateId,f.contactId]);
 assert.ok(task);
 function scene(){
  let queries=0,sourceQualificationQueries=0,sourceElapsedMs=0;
  const measure=(sql,work)=>{
   queries++;const sourceQuery=sql.includes('wanted AS (')&&sql.includes('current_source_ranges'),began=performance.now();
   try{return work();}finally{if(sourceQuery){sourceQualificationQueries++;sourceElapsedMs+=performance.now()-began;}}
  };
  const tx={all:(sql,values)=>measure(sql,()=>all(sql,values)),get:(sql,values)=>measure(sql,()=>get(sql,values)),run};
  db.exec('BEGIN IMMEDIATE');const began=performance.now();
  try{
   const claim=claimScene.execute(tx,{ownerId:f.owner,taskId:task.id},f.storage.status);assert.ok(claim,'合成任务应可领取主题文档步骤');
   return {memoryCount:claim.memories.length,sourceMessageCount:new Set(claim.memories.flatMap(memory=>memory.message_ids)).size,
    queries,sourceQualificationQueries,sourceElapsedMs,elapsedMs:performance.now()-began};
  }finally{db.exec('ROLLBACK');}
 }
 const deletingSource=()=>run("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND contact_id=? AND message_id IN (SELECT message_id FROM memory_citation WHERE owner_id=? AND source_contact_id=?)",[f.owner,f.contactId,f.owner,f.contactId]);
 return {...f,scene,deletingSource};
}
