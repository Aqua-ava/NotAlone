import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createExtractionFixture} from './extraction-fixture.mjs';
import {
  ContactMemoryIndexError,
  ContactMemoryIndexRunner,
  PostgresContactMemoryIndexRepository,
} from '../src/memory/overview/catalog.ts';
import {ExtractionTaskStore} from '../src/memory/extraction/tasks/store.ts';
import {ExtractionWorker} from '../src/memory/extraction/tasks/worker.ts';

async function createIndexFixture(t){
  const fixture=await createExtractionFixture();
  const pool=new pg.Pool({host:'/tmp',database:fixture.client.database,max:4});
  t.after(async()=>{await pool.end();await fixture.close();});
  const ownerId=randomUUID(),contactId=randomUUID(),sourceId=randomUUID();
  await fixture.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成目录用户')",[ownerId]);
  await fixture.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成目录联系人')",[contactId,ownerId]);
  await fixture.client.query(`INSERT INTO source_document
    (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
    VALUES($1,$2,$3,'wechat_jsonl','synthetic-index.jsonl',$4,1)`,
  [sourceId,ownerId,contactId,'b'.repeat(64)]);
  return {fixture,pool,ownerId,contactId,sourceId,scope:{ownerId,contactId}};
}

async function addMemory(f,{
  category='preference',topic='work',text='合成目录事实',validAt=null,invalidAt=null,
  status='active',sourceIds=[f.sourceId],
}){
  const id=randomUUID();
  await f.fixture.client.query(`INSERT INTO confirmed_memory
    (id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method,status,valid_at,invalid_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::uuid[],'manual',$8,$9,$10)`,
  [id,f.ownerId,f.contactId,text,category,topic,sourceIds,status,validAt,invalidAt]);
  return id;
}

async function waitFor(check,timeoutMs=3000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const value=await check();
    if(value)return value;
    await delay(20);
  }
  throw new Error('synthetic_index_timeout');
}

test('目录按主题数量和稳定标识生成且不复制记忆正文',async t=>{
  const f=await createIndexFixture(t);
  const laterId='ffffffff-ffff-4fff-8fff-ffffffffffff';
  const earlierId='00000000-0000-4000-8000-000000000001';
  await f.fixture.client.query(`INSERT INTO confirmed_memory
    (id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method)
    VALUES
      ($1,$3,$4,'不应进入目录的正文甲','preference','work',$5::uuid[],'manual'),
      ($2,$3,$4,'不应进入目录的正文乙','preference','work',$5::uuid[],'manual')`,
  [laterId,earlierId,f.ownerId,f.contactId,[f.sourceId]]);
  const healthId=await addMemory(f,{category:'taboo',topic:'health',text:'不应进入目录的正文丙'});
  await f.fixture.client.query(`INSERT INTO contact_memory_state(owner_id,contact_id,memory_revision)
    VALUES($1,$2,3) ON CONFLICT(owner_id,contact_id) DO UPDATE SET memory_revision=3`,
  [f.ownerId,f.contactId]);

  const repository=new PostgresContactMemoryIndexRepository();
  await f.fixture.client.query('BEGIN');
  try{
    await repository.rebuild(f.fixture.client,f.scope);
    await f.fixture.client.query('COMMIT');
  }catch(error){
    await f.fixture.client.query('ROLLBACK');
    throw error;
  }
  const current=await repository.read(f.fixture.client,f.scope);

  assert.deepEqual(current?.topics,[
    {category:'preference',topic:'work',topic_summary:'preference:work',memory_ids:[earlierId,laterId]},
    {category:'taboo',topic:'health',topic_summary:'taboo:health',memory_ids:[healthId]},
  ]);
  assert.ok(!JSON.stringify(current?.topics).includes('不应进入目录的正文'));
});

test('目录只使用当前联系人有效来源且最多二十个主题',async t=>{
  const f=await createIndexFixture(t);
  const expiredId=await addMemory(f,{topic:'health',invalidAt:new Date(Date.now()-60_000)});
  const invalidatedId=await addMemory(f,{topic:'family',status:'invalidated'});
  const deadSourceId=randomUUID();
  await f.fixture.client.query(`INSERT INTO source_document
    (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count,status)
    VALUES($1,$2,$3,'wechat_jsonl','expired-index.jsonl',$4,1,'delete_failed')`,
  [deadSourceId,f.ownerId,f.contactId,'c'.repeat(64)]);
  const deadSourceMemoryId=await addMemory(f,{topic:'travel',sourceIds:[deadSourceId]});

  const categories=['common_fact','preference','taboo','recent_state','relationship_note'];
  const topicNames=['health','work','family','travel','finance','study','emotion','other'];
  const activeIds=[];
  for(let index=0;index<25;index++){
    activeIds.push(await addMemory(f,{
      category:categories[index%categories.length],
      topic:topicNames[index%topicNames.length],
      text:`合成资格正文 ${index}`,
    }));
  }

  const otherContactId=randomUUID(),otherSourceId=randomUUID(),otherOwnerId=randomUUID();
  await f.fixture.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'另一合成联系人')",[otherContactId,f.ownerId]);
  await f.fixture.client.query(`INSERT INTO source_document
    (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
    VALUES($1,$2,$3,'wechat_jsonl','other-contact.jsonl',$4,1)`,
  [otherSourceId,f.ownerId,otherContactId,'d'.repeat(64)]);
  const otherContactMemoryId=randomUUID();
  await f.fixture.client.query(`INSERT INTO confirmed_memory
    (id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method)
    VALUES($1,$2,$3,'另一联系人正文','preference','work',$4::uuid[],'manual')`,
  [otherContactMemoryId,f.ownerId,otherContactId,[otherSourceId]]);

  const otherOwnerContactId=randomUUID(),otherOwnerSourceId=randomUUID(),otherOwnerMemoryId=randomUUID();
  await f.fixture.client.query("INSERT INTO owner(id,display_name) VALUES($1,'另一合成目录用户')",[otherOwnerId]);
  await f.fixture.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'另一owner联系人')",[otherOwnerContactId,otherOwnerId]);
  await f.fixture.client.query(`INSERT INTO source_document
    (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
    VALUES($1,$2,$3,'wechat_jsonl','other-owner.jsonl',$4,1)`,
  [otherOwnerSourceId,otherOwnerId,otherOwnerContactId,'e'.repeat(64)]);
  await f.fixture.client.query(`INSERT INTO confirmed_memory
    (id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method)
    VALUES($1,$2,$3,'另一owner正文','preference','work',$4::uuid[],'manual')`,
  [otherOwnerMemoryId,otherOwnerId,otherOwnerContactId,[otherOwnerSourceId]]);

  const ownerMemoryId=randomUUID();
  await f.fixture.client.query(`INSERT INTO owner_memory
    (id,owner_id,text_content,category,topic,source_ids,adoption_method)
    VALUES($1,$2,'本人范围正文','preference','work',$3::uuid[],'manual')`,
  [ownerMemoryId,f.ownerId,[f.sourceId]]);
  await f.fixture.client.query(`INSERT INTO contact_memory_state(owner_id,contact_id,memory_revision)
    VALUES($1,$2,30) ON CONFLICT(owner_id,contact_id) DO UPDATE SET memory_revision=30`,
  [f.ownerId,f.contactId]);

  const repository=new PostgresContactMemoryIndexRepository();
  await f.fixture.client.query('BEGIN');
  try{
    await repository.rebuild(f.fixture.client,f.scope);
    await f.fixture.client.query('COMMIT');
  }catch(error){
    await f.fixture.client.query('ROLLBACK');
    throw error;
  }
  const current=await repository.read(f.fixture.client,f.scope);
  const indexed=new Set(current.topics.flatMap(topic=>topic.memory_ids));

  assert.equal(current.topics.length,20);
  assert.ok(activeIds.some(id=>indexed.has(id)));
  for(const excluded of [expiredId,invalidatedId,deadSourceMemoryId,otherContactMemoryId,otherOwnerMemoryId,ownerMemoryId]){
    assert.ok(!indexed.has(excluded));
  }
});

test('目录验证返回稳定错误并拒绝失效来源引用',async t=>{
  const f=await createIndexFixture(t);
  await addMemory(f,{topic:'work'});
  await f.fixture.client.query(`INSERT INTO contact_memory_state(owner_id,contact_id,memory_revision)
    VALUES($1,$2,1) ON CONFLICT(owner_id,contact_id) DO UPDATE SET memory_revision=1`,
  [f.ownerId,f.contactId]);
  const repository=new PostgresContactMemoryIndexRepository();
  await f.fixture.client.query('BEGIN');
  try{
    await repository.rebuild(f.fixture.client,f.scope);
    await f.fixture.client.query('COMMIT');
  }catch(error){
    await f.fixture.client.query('ROLLBACK');
    throw error;
  }

  assert.deepEqual(await repository.verify(f.fixture.client,f.scope),{
    valid:true,topicsCount:1,errorCode:null,
  });
  await f.fixture.client.query(`UPDATE contact_memory_index SET status='stale'
    WHERE owner_id=$1 AND contact_id=$2`,[f.ownerId,f.contactId]);
  assert.equal((await repository.verify(f.fixture.client,f.scope)).errorCode,'index_not_active');
  await f.fixture.client.query(`UPDATE contact_memory_index SET status='active',built_from_memory_revision=0
    WHERE owner_id=$1 AND contact_id=$2`,[f.ownerId,f.contactId]);
  assert.equal((await repository.verify(f.fixture.client,f.scope)).errorCode,'index_stale');
  await f.fixture.client.query(`UPDATE contact_memory_index SET built_from_memory_revision=1
    WHERE owner_id=$1 AND contact_id=$2`,[f.ownerId,f.contactId]);
  await f.fixture.client.query(`UPDATE source_document SET status='delete_failed' WHERE id=$1`,[f.sourceId]);
  assert.equal((await repository.verify(f.fixture.client,f.scope)).errorCode,'index_reference_invalid');
  await f.fixture.client.query(`DELETE FROM contact_memory_index WHERE owner_id=$1 AND contact_id=$2`,
  [f.ownerId,f.contactId]);
  assert.equal((await repository.verify(f.fixture.client,f.scope)).errorCode,'index_missing');
});

test('同一唯一Worker在原任务租约内完成index和verify',async t=>{
  const f=await createIndexFixture(t);
  const memoryId=await addMemory(f,{topic:'work',text:'合成Worker目录正文'});
  await f.fixture.client.query(`INSERT INTO contact_memory_state(owner_id,contact_id,memory_revision)
    VALUES($1,$2,1) ON CONFLICT(owner_id,contact_id) DO UPDATE SET memory_revision=1`,
  [f.ownerId,f.contactId]);
  const store=new ExtractionTaskStore(f.pool);
  const taskId=await store.enqueueImport(f.scope,f.sourceId,1);
  await f.fixture.client.query(`UPDATE background_task_step
    SET status='succeeded',processed_count=1,total_count=1
    WHERE task_id=$1 AND step_name IN ('parse','normalize','extract_memory')`,[taskId]);
  await f.fixture.client.query(`UPDATE background_task
    SET status='queued',current_step='index' WHERE id=$1`,[taskId]);

  let worker;
  t.after(async()=>{await worker?.stop();});
  const runner=new ContactMemoryIndexRunner({store});
  worker=new ExtractionWorker({store,ownerId:f.ownerId,runner:{
    async run(){throw new Error('semantic_runner_must_not_run');},
  },indexRunner:runner,idleMs:20,leaseMs:5000,heartbeatMs:500});
  assert.equal(await worker.start(),true);
  assert.equal(worker.wake(f.scope,taskId),true);
  await waitFor(async()=>(await f.fixture.client.query(
    "SELECT status FROM background_task WHERE id=$1",[taskId],
  )).rows[0]?.status==='succeeded');

  const steps=(await f.fixture.client.query(`SELECT step_name,status,processed_count,total_count
    FROM background_task_step WHERE task_id=$1 ORDER BY step_order`,[taskId])).rows;
  assert.deepEqual(steps.slice(3),[
    {step_name:'index',status:'succeeded',processed_count:1,total_count:20},
    {step_name:'verify',status:'succeeded',processed_count:1,total_count:20},
  ]);
  const repository=new PostgresContactMemoryIndexRepository();
  const current=await repository.read(f.fixture.client,f.scope);
  assert.ok(current.topics.some(topic=>topic.memory_ids.includes(memoryId)));
  assert.equal((await repository.verify(f.fixture.client,f.scope)).valid,true);
});

test('index写入后失败会回滚并保留旧目录',async t=>{
  const f=await createIndexFixture(t);
  const oldMemoryId=await addMemory(f,{topic:'work',text:'旧目录正文'});
  await f.fixture.client.query(`INSERT INTO contact_memory_state(owner_id,contact_id,memory_revision)
    VALUES($1,$2,1) ON CONFLICT(owner_id,contact_id) DO UPDATE SET memory_revision=1`,
  [f.ownerId,f.contactId]);
  const repository=new PostgresContactMemoryIndexRepository();
  await f.fixture.client.query('BEGIN');
  try{
    await repository.rebuild(f.fixture.client,f.scope);
    await f.fixture.client.query('COMMIT');
  }catch(error){
    await f.fixture.client.query('ROLLBACK');
    throw error;
  }
  await addMemory(f,{topic:'travel',text:'新目录正文'});
  await f.fixture.client.query(`UPDATE contact_memory_state SET memory_revision=2
    WHERE owner_id=$1 AND contact_id=$2`,[f.ownerId,f.contactId]);
  const store=new ExtractionTaskStore(f.pool);
  const taskId=await store.enqueueImport(f.scope,f.sourceId,1);
  await f.fixture.client.query(`UPDATE background_task_step SET status='succeeded'
    WHERE task_id=$1 AND step_name IN ('parse','normalize','extract_memory')`,[taskId]);
  const claim=await store.claim(f.scope,{workerId:randomUUID(),leaseMs:5000,supportedSteps:['index','verify']});
  assert.equal(claim?.stepName,'index');
  const runner=new ContactMemoryIndexRunner({store,repository:{
    async rebuild(client,scope){
      await repository.rebuild(client,scope);
      throw new Error('synthetic_after_write');
    },
    verify:repository.verify.bind(repository),
  }});

  await assert.rejects(runner.run(claim,new AbortController().signal),error=>
    error instanceof ContactMemoryIndexError
    &&error.code==='index_rebuild_failed'&&error.retryable);
  const current=await repository.read(f.fixture.client,f.scope);
  assert.equal(current.builtFromMemoryRevision,1n);
  assert.deepEqual(current.topics.flatMap(topic=>topic.memory_ids),[oldMemoryId]);
});

test('verify失败不标记成功且可在修复后恢复原任务',async t=>{
  const f=await createIndexFixture(t);
  await addMemory(f,{topic:'work',text:'可恢复目录正文'});
  await f.fixture.client.query(`INSERT INTO contact_memory_state(owner_id,contact_id,memory_revision)
    VALUES($1,$2,1) ON CONFLICT(owner_id,contact_id) DO UPDATE SET memory_revision=1`,
  [f.ownerId,f.contactId]);
  const repository=new PostgresContactMemoryIndexRepository();
  await f.fixture.client.query('BEGIN');
  try{
    await repository.rebuild(f.fixture.client,f.scope);
    await f.fixture.client.query(`UPDATE contact_memory_index SET status='stale'
      WHERE owner_id=$1 AND contact_id=$2`,[f.ownerId,f.contactId]);
    await f.fixture.client.query('COMMIT');
  }catch(error){
    await f.fixture.client.query('ROLLBACK');
    throw error;
  }
  const store=new ExtractionTaskStore(f.pool);
  const taskId=await store.enqueueImport(f.scope,f.sourceId,1);
  await f.fixture.client.query(`UPDATE background_task_step
    SET status='succeeded',processed_count=1,total_count=20
    WHERE task_id=$1 AND step_name IN ('parse','normalize','extract_memory','index')`,[taskId]);
  await f.fixture.client.query(`UPDATE background_task
    SET status='verifying',current_step='verify' WHERE id=$1`,[taskId]);

  let worker;
  t.after(async()=>{await worker?.stop();});
  worker=new ExtractionWorker({store,ownerId:f.ownerId,runner:{
    async run(){throw new Error('semantic_runner_must_not_run');},
  },indexRunner:new ContactMemoryIndexRunner({store}),idleMs:20,leaseMs:5000,heartbeatMs:500});
  assert.equal(await worker.start(),true);
  assert.equal(worker.wake(f.scope,taskId),true);
  await waitFor(async()=>{
    const row=(await f.fixture.client.query("SELECT status,last_error_code FROM background_task WHERE id=$1",[taskId])).rows[0];
    return row?.status==='failed'&&row?.last_error_code==='index_not_active';
  });

  const failed=(await f.fixture.client.query(`SELECT status,attempt_count,last_error_code
    FROM background_task_step WHERE task_id=$1 AND step_name='verify'`,[taskId])).rows[0];
  assert.deepEqual(failed,{status:'failed',attempt_count:3,last_error_code:'index_not_active'});
  await f.fixture.client.query(`UPDATE contact_memory_index SET status='active'
    WHERE owner_id=$1 AND contact_id=$2`,[f.ownerId,f.contactId]);
  assert.equal((await store.resume(f.scope,taskId,'resume')).status,'queued');
  assert.equal(worker.wake(f.scope,taskId),true);
  await waitFor(async()=>(await f.fixture.client.query(
    "SELECT status FROM background_task WHERE id=$1",[taskId],
  )).rows[0]?.status==='succeeded');
});

test('没有有效记忆时生成可验证的空目录',async t=>{
  const f=await createIndexFixture(t);
  const repository=new PostgresContactMemoryIndexRepository();
  await f.fixture.client.query('BEGIN');
  try{
    assert.deepEqual(await repository.rebuild(f.fixture.client,f.scope),[]);
    await f.fixture.client.query('COMMIT');
  }catch(error){
    await f.fixture.client.query('ROLLBACK');
    throw error;
  }
  assert.deepEqual((await repository.read(f.fixture.client,f.scope)).topics,[]);
  assert.deepEqual(await repository.verify(f.fixture.client,f.scope),{
    valid:true,topicsCount:0,errorCode:null,
  });
});

test('来源删除后原任务不能被唯一Worker领取',async t=>{
  const f=await createIndexFixture(t);
  await addMemory(f,{topic:'work'});
  const store=new ExtractionTaskStore(f.pool);
  const taskId=await store.enqueueImport(f.scope,f.sourceId,1);
  await f.fixture.client.query(`UPDATE background_task_step SET status='succeeded'
    WHERE task_id=$1 AND step_name IN ('parse','normalize','extract_memory')`,[taskId]);
  await f.fixture.client.query(`UPDATE source_document SET status='delete_failed' WHERE id=$1`,[f.sourceId]);

  assert.equal(await store.claim(f.scope,{
    workerId:randomUUID(),leaseMs:5000,supportedSteps:['index','verify'],
  }),null);
  const row=(await f.fixture.client.query(`SELECT status FROM background_task_step
    WHERE task_id=$1 AND step_name='index'`,[taskId])).rows[0];
  assert.equal(row.status,'pending');
});

test('租约被接管后旧Runner晚到不能写目录',async t=>{
  const f=await createIndexFixture(t);
  const oldMemoryId=await addMemory(f,{topic:'work',text:'旧租约正文'});
  await f.fixture.client.query(`INSERT INTO contact_memory_state(owner_id,contact_id,memory_revision)
    VALUES($1,$2,1) ON CONFLICT(owner_id,contact_id) DO UPDATE SET memory_revision=1`,
  [f.ownerId,f.contactId]);
  const repository=new PostgresContactMemoryIndexRepository();
  await f.fixture.client.query('BEGIN');
  try{
    await repository.rebuild(f.fixture.client,f.scope);
    await f.fixture.client.query('COMMIT');
  }catch(error){
    await f.fixture.client.query('ROLLBACK');
    throw error;
  }
  await addMemory(f,{topic:'travel',text:'新租约正文'});
  await f.fixture.client.query(`UPDATE contact_memory_state SET memory_revision=2
    WHERE owner_id=$1 AND contact_id=$2`,[f.ownerId,f.contactId]);
  const store=new ExtractionTaskStore(f.pool);
  const taskId=await store.enqueueImport(f.scope,f.sourceId,1);
  await f.fixture.client.query(`UPDATE background_task_step SET status='succeeded'
    WHERE task_id=$1 AND step_name IN ('parse','normalize','extract_memory')`,[taskId]);
  const oldClaim=await store.claim(f.scope,{
    workerId:randomUUID(),leaseMs:5000,supportedSteps:['index','verify'],
  });
  await f.fixture.client.query(`UPDATE background_task_step
    SET worker_id=$2,lease_generation=lease_generation+1,lease_expires_at=now()+interval '5 minutes'
    WHERE id=$1`,[oldClaim.stepId,randomUUID()]);

  await assert.rejects(
    new ContactMemoryIndexRunner({store}).run(oldClaim,new AbortController().signal),
    error=>error?.code==='lease_stale',
  );
  const current=await repository.read(f.fixture.client,f.scope);
  assert.equal(current.builtFromMemoryRevision,1n);
  assert.deepEqual(current.topics.flatMap(topic=>topic.memory_ids),[oldMemoryId]);
});

test('Worker关闭取消在途index并回滚暂写目录',async t=>{
  const f=await createIndexFixture(t);
  const oldMemoryId=await addMemory(f,{topic:'work',text:'关闭前旧目录正文'});
  await f.fixture.client.query(`INSERT INTO contact_memory_state(owner_id,contact_id,memory_revision)
    VALUES($1,$2,1) ON CONFLICT(owner_id,contact_id) DO UPDATE SET memory_revision=1`,
  [f.ownerId,f.contactId]);
  const repository=new PostgresContactMemoryIndexRepository();
  await f.fixture.client.query('BEGIN');
  try{
    await repository.rebuild(f.fixture.client,f.scope);
    await f.fixture.client.query('COMMIT');
  }catch(error){
    await f.fixture.client.query('ROLLBACK');
    throw error;
  }
  await addMemory(f,{topic:'travel',text:'关闭时新目录正文'});
  await f.fixture.client.query(`UPDATE contact_memory_state SET memory_revision=2
    WHERE owner_id=$1 AND contact_id=$2`,[f.ownerId,f.contactId]);
  const store=new ExtractionTaskStore(f.pool);
  const taskId=await store.enqueueImport(f.scope,f.sourceId,1);
  await f.fixture.client.query(`UPDATE background_task_step SET status='succeeded'
    WHERE task_id=$1 AND step_name IN ('parse','normalize','extract_memory')`,[taskId]);

  let enteredResolve,releaseResolve;
  const entered=new Promise(resolve=>{enteredResolve=resolve;});
  const release=new Promise(resolve=>{releaseResolve=resolve;});
  let worker;
  t.after(async()=>{releaseResolve();await worker?.stop();});
  const blockingRunner=new ContactMemoryIndexRunner({store,repository:{
    async rebuild(client,scope){
      const topics=await repository.rebuild(client,scope);
      enteredResolve();
      await release;
      return topics;
    },
    verify:repository.verify.bind(repository),
  }});
  worker=new ExtractionWorker({store,ownerId:f.ownerId,runner:{
    async run(){throw new Error('semantic_runner_must_not_run');},
  },indexRunner:blockingRunner,idleMs:20,leaseMs:5000,heartbeatMs:500});
  assert.equal(await worker.start(),true);
  assert.equal(worker.wake(f.scope,taskId),true);
  await entered;
  const stopping=worker.stop(3000);
  releaseResolve();
  assert.equal(await stopping,true);
  assert.equal(worker.status().state,'stopped');

  const current=await repository.read(f.fixture.client,f.scope);
  assert.equal(current.builtFromMemoryRevision,1n);
  assert.deepEqual(current.topics.flatMap(topic=>topic.memory_ids),[oldMemoryId]);
});

test('重启后无wake提示仍恢复过期verify租约',async t=>{
  const f=await createIndexFixture(t);
  const memoryId=await addMemory(f,{topic:'work',text:'重启恢复目录正文'});
  await f.fixture.client.query(`INSERT INTO contact_memory_state(owner_id,contact_id,memory_revision)
    VALUES($1,$2,1) ON CONFLICT(owner_id,contact_id) DO UPDATE SET memory_revision=1`,
  [f.ownerId,f.contactId]);
  const repository=new PostgresContactMemoryIndexRepository();
  await f.fixture.client.query('BEGIN');
  try{
    await repository.rebuild(f.fixture.client,f.scope);
    await f.fixture.client.query('COMMIT');
  }catch(error){
    await f.fixture.client.query('ROLLBACK');
    throw error;
  }
  const store=new ExtractionTaskStore(f.pool);
  const taskId=await store.enqueueImport(f.scope,f.sourceId,1);
  await f.fixture.client.query(`UPDATE background_task_step
    SET status='succeeded',processed_count=1,total_count=20
    WHERE task_id=$1 AND step_name IN ('parse','normalize','extract_memory','index')`,[taskId]);
  await f.fixture.client.query(`UPDATE background_task_step
    SET status='running',worker_id=$2,lease_generation=1,attempt_count=1,
      lease_expires_at=now()-interval '1 second'
    WHERE task_id=$1 AND step_name='verify'`,[taskId,randomUUID()]);
  await f.fixture.client.query(`UPDATE background_task
    SET status='verifying',current_step='verify' WHERE id=$1`,[taskId]);

  let worker;
  t.after(async()=>{await worker?.stop();});
  worker=new ExtractionWorker({store,ownerId:f.ownerId,runner:{
    async run(){throw new Error('semantic_runner_must_not_run');},
  },indexRunner:new ContactMemoryIndexRunner({store}),idleMs:20,leaseMs:5000,heartbeatMs:500});
  assert.equal(await worker.start(),true);
  await waitFor(async()=>(await f.fixture.client.query(
    "SELECT status FROM background_task WHERE id=$1",[taskId],
  )).rows[0]?.status==='succeeded');

  assert.ok((await repository.read(f.fixture.client,f.scope))
    .topics.some(topic=>topic.memory_ids.includes(memoryId)));
});
