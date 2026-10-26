import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createExtractionFixture} from './extraction-fixture.mjs';
import {ExtractionTaskStore} from '../src/memory/extraction/tasks/store.ts';
import {createExtractionPolicyVersion} from '../src/memory/extraction/policy-version.ts';

test('真实新任务显式冻结v2，旧NULL冲突重入不升级，未知及源版本不匹配不领取',async()=>{
  const fixture=await createExtractionFixture(),c=fixture.client;
  const pool=new pg.Pool({host:'/tmp',database:c.connectionParameters.database,max:3});
  try {
    const ownerId=randomUUID(),contactId=randomUUID(),scope={ownerId,contactId};
    await c.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[ownerId]);
    await c.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contactId,ownerId]);
    const sources=[randomUUID(),randomUUID(),randomUUID()];
    for(const [index,id] of sources.entries())await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic',$4,0)",[id,ownerId,contactId,String(index+1).repeat(64)]);
    const legacy=new ExtractionTaskStore(pool),oldTask=await legacy.enqueueImport(scope,sources[0],0);
    const identity=await createExtractionPolicyVersion();
    const current=new ExtractionTaskStore(pool,{policyVersion:identity,verificationPolicy:'complete-claim-v1'});
    assert.equal(await current.enqueueImport(scope,sources[0],0),oldTask);
    assert.equal((await c.query('SELECT extraction_runtime_config FROM background_task WHERE id=$1',[oldTask])).rows[0].extraction_runtime_config,null);
    const task=await current.enqueueImport(scope,sources[1],0);
    assert.deepEqual((await c.query('SELECT extraction_runtime_config FROM background_task WHERE id=$1',[task])).rows[0].extraction_runtime_config,identity.newTaskConfig());
    await c.query("UPDATE background_task_step SET status='succeeded' WHERE task_id=$1 AND step_name IN ('parse','normalize')",[task]);
    const blocked=new ExtractionTaskStore(pool,{policyVersion:identity,unconfirmedRequests:()=>[task]});
    assert.equal(await blocked.claim(scope,{taskId:task,workerId:randomUUID(),leaseMs:30000}),null);
    const stale=await current.enqueueImport(scope,sources[2],0);
    await c.query("UPDATE background_task_step SET status='succeeded' WHERE task_id=$1 AND step_name IN ('parse','normalize')",[stale]);
    await c.query('UPDATE background_task SET extraction_runtime_config=$2::jsonb WHERE id=$1',[stale,JSON.stringify({...identity.newTaskConfig(),source_stamp:'b'.repeat(64)})]);
    await assert.rejects(current.claim(scope,{taskId:stale,workerId:randomUUID(),leaseMs:30000}),/source_unavailable/);
    const claim=await current.claim(scope,{taskId:task,workerId:randomUUID(),leaseMs:30000});
    assert.deepEqual(claim.runtimeConfig,identity.newTaskConfig());
  } finally {await pool.end();await fixture.close();}
});
