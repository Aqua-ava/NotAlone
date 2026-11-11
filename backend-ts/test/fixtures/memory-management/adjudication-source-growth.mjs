import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {adjudicationFixture} from './adjudication-support.mjs';
import {memoryAdjudicationActions} from '../../../src/memory/sqlite/management/adjudication-actions.ts';

const claim=memoryAdjudicationActions.find(action=>action.name==='memoryAdjudication.claim');

/** 只连接本测试创建的临时库；候选和父记忆沿公开服务生成，引用只种合成来源。 */
export async function sourceGrowthFixture(t,count){
 const f=await adjudicationFixture(t);
 await f.extract(['我长期喜欢合成园艺。']);
 const candidate=(await f.read()).candidates[0];assert.ok(candidate);
 const parents=[];
 for(let index=0;index<count;index++){
  const memory=await f.management.decide({requestKey:`source-growth-parent-${index}`,action:'manual',scope:f.scope,body:`合成长期事项${index}。`});
  parents.push(memory.memoryId);
 }
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));t.after(()=>db.close());
 const statement=(sql,values=[])=>{const value=db.prepare(sql);value.setReadBigInts(true);return {value,values};};
 const all=(sql,values)=>{const query=statement(sql,values);return query.value.all(...query.values);};
 const get=(sql,values)=>all(sql,values)[0];
 const run=(sql,values=[])=>db.prepare(sql).run(...values);
 const source=get(`SELECT r.id AS record_id,r.message_id,m.interpretation_revision,m.text_body
  FROM capture_record r JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id
  WHERE r.owner_id=? AND r.contact_id=? AND r.state='normalized' AND r.availability='available' AND m.kind='text' ORDER BY m.display_no LIMIT 1`,[f.owner,f.contactId]);
 assert.ok(source);
 for(const memoryId of parents){
  run('INSERT INTO memory_required_message VALUES(?,?,?,?,?,?,?)',[f.owner,randomUUID(),null,memoryId,1n,f.contactId,source.message_id]);
  run('INSERT INTO memory_citation(owner_id,id,memory_id,version_no,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end) VALUES(?,?,?,?,?,?,?,?,?,?)',
   [f.owner,randomUUID(),memoryId,1n,f.contactId,source.message_id,source.record_id,source.interpretation_revision,0n,BigInt([...source.text_body].length)]);
 }
 function probe(){
  let queries=0,sourceQualificationQueries=0,sourceElapsedMs=0;
  const measure=(sql,work)=>{
   queries++;const sourceQuery=sql.includes('wanted AS (')&&sql.includes('current_source_ranges'),began=performance.now();
   try{return work();}finally{if(sourceQuery){sourceQualificationQueries++;sourceElapsedMs+=performance.now()-began;}}
  };
  const tx={all:(sql,values)=>measure(sql,()=>all(sql,values)),get:(sql,values)=>measure(sql,()=>get(sql,values)),run};
  db.exec('BEGIN IMMEDIATE');const began=performance.now();
  try{
   const result=claim.execute(tx,{ownerId:f.owner,candidateId:candidate.id},f.storage.status);assert.ok(result,'合成候选应可领取裁决步骤');
   return {parentCount:result.basis.parents.length,similarCount:result.basis.item.similar.length,queries,sourceQualificationQueries,sourceElapsedMs,elapsedMs:performance.now()-began};
  }finally{
   // 领取动作真实写入步骤，测量后回滚，下一次动作不得被running prior提前短路。
   db.exec('ROLLBACK');
  }
 }
 return {...f,probe,distinctSources:1,candidateId:candidate.id};
}
