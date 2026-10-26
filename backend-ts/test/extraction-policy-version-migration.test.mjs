import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createExtractionFixture} from './extraction-fixture.mjs';
import {validateExtractionRuntimeConfig} from '../src/memory/extraction/policy-version.ts';

test('116真实随机_test迁移兼容旧快照，SQL与TS同时拒绝非法v2',async()=>{
  const fixture=await createExtractionFixture(),c=fixture.client;
  try {
    const owner=randomUUID(),contact=randomUUID(),task=randomUUID();
    await c.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
    await c.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
    await c.query("INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,message_count) VALUES($1,$2,$3,'observation','queued','extract_memory',0)",[task,owner,contact]);
    const valid={version:2,mode:'legacy',rule_set_sha256:null,verification_policy:'complete-claim-v1',source_stamp:'a'.repeat(64)};
    const good=[null,{version:1,mode:'legacy',rule_set_sha256:null},
      {version:1,mode:'bounded-runtime-v1',rule_set_sha256:'b'.repeat(64)},valid];
    for(const config of good){
      validateExtractionRuntimeConfig(config);
      await c.query('UPDATE background_task SET extraction_runtime_config=$2::jsonb WHERE id=$1',[task,config===null?null:JSON.stringify(config)]);
    }
    const bad=[{...valid,source_stamp:null},{...valid,source_stamp:'A'.repeat(64)},{...valid,extra:true},
      {...valid,verification_policy:null},{...valid,rule_set_sha256:'c'.repeat(64)},{...valid,mode:'bounded-runtime-v1'},
      {...valid,version:3},Object.fromEntries(Object.entries(valid).filter(([key])=>key!=='source_stamp')),
      {version:1,mode:['bounded-runtime-v1'],rule_set_sha256:'b'.repeat(64)}];
    for(const config of bad){
      assert.throws(()=>validateExtractionRuntimeConfig(config));
      await assert.rejects(c.query('UPDATE background_task SET extraction_runtime_config=$2::jsonb WHERE id=$1',[task,JSON.stringify(config)]),{code:'23514'});
    }
    assert.deepEqual((await c.query('SELECT extraction_runtime_config FROM background_task WHERE id=$1',[task])).rows[0].extraction_runtime_config,valid);
  } finally {await fixture.close();}
});
