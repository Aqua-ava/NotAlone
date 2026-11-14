import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {adjudicationFixture} from './fixtures/memory-management/adjudication-support.mjs';
import {memoryAdjudicationActions} from '../src/memory/sqlite/management/adjudication-actions.ts';

const claim=memoryAdjudicationActions.find(action=>action.name==='memoryAdjudication.claim');

test('大量已释放历史不阻挡正常裁决，未知占位检查按目标使用现有部分索引',async t=>{
 const f=await adjudicationFixture(t);await f.extract(['我长期喜欢合成园艺。']);
 const candidate=(await f.read()).candidates[0];assert.ok(candidate);
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));t.after(()=>db.close());
 const all=(sql,values=[])=>{const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all(...values);};
 const get=(sql,values)=>all(sql,values)[0],run=(sql,values=[])=>db.prepare(sql).run(...values);
 const prior=get('SELECT * FROM model_operation WHERE owner_id=? AND memory_step_id IS NOT NULL ORDER BY slot LIMIT 1',[f.owner]);
 const target=get("SELECT item_id FROM run_input WHERE owner_id=? AND role='target' LIMIT 1",[f.owner]);
 db.exec('BEGIN IMMEDIATE');
 for(let index=0;index<2000;index++){
  const operationId=randomUUID();
  run("INSERT INTO model_operation(owner_id,id,purpose,memory_step_id,slot,input_seal,state) VALUES(?,?,?,?,?,?,'applied')",[f.owner,operationId,prior.purpose,prior.memory_step_id,10000+index,prior.input_seal]);
  run("INSERT INTO operation_item VALUES(?,?,?,?,'released')",[f.owner,operationId,target.item_id,prior.purpose]);
 }
 db.exec('COMMIT');
 const plans=[];
 const tx={all,get(sql,values){
  if(sql.includes('FROM task_contribution t JOIN run_input i')&&sql.includes('JOIN operation_item oi'))plans.push(...all('EXPLAIN QUERY PLAN '+sql,values).map(row=>String(row.detail)));
  return get(sql,values);
 },run};
 db.exec('BEGIN IMMEDIATE');
 const began=performance.now();let result;
 try{result=claim.execute(tx,{ownerId:f.owner,candidateId:candidate.id},f.storage.status);}
 finally{db.exec('ROLLBACK');}
 assert.ok(result,'全部旧调用已释放时当前候选仍正常领取');
 t.diagnostic(JSON.stringify({releasedHistory:2000,elapsedMs:performance.now()-began,occupancyPlan:plans}));
 assert.ok(plans.some(detail=>/operation_item_occupied.*owner_id=.*item_id=/.test(detail)),'必须使用现有按目标身份的部分索引，不能按owner扫描全部历史占位');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('真实裁决未知占位仍阻止同轮其他候选领取且保留原未知记录',async t=>{
 const f=await adjudicationFixture(t);
 await f.management.decide({requestKey:'unknown-occupancy-comparison',action:'manual',scope:f.scope,body:'独立合成长期资料。'});
 f.setRespond(async()=>{throw new Error('合成发送后回执失联');});
 const runId=await f.extract(['我长期喜欢合成园艺。','我长期偏好合成白茶。']);
 await f.adjudication.publishRun(runId,f.contactId);
 const before=await f.trace(),unknown=before.calls.find(call=>call.state==='unknown');assert.ok(unknown);
 const occupied=before.events.find(event=>event.kind==='adjudication_basis').payload.candidateId;
 const candidate=(await f.read()).candidates.find(item=>item.id!==occupied);assert.ok(candidate);
 await assert.rejects(f.storage.execute('memoryAdjudication.claim',{ownerId:f.owner,candidateId:candidate.id}),{code:'memory_adjudication_receipt_unknown'});
 const after=await f.trace();assert.equal(after.steps.length,before.steps.length);
 assert.deepEqual(after.calls,before.calls,'索引优化不释放未知占位或改写未知回执');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
