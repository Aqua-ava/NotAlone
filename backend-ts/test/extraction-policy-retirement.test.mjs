import test from 'node:test';
import assert from 'node:assert/strict';
import {createExtractionPolicyVersion,validateExtractionRuntimeConfig} from '../src/memory/extraction/policy-version.ts';
import {prepareSourceVerification} from '../src/memory/extraction/verification/complete-claim.ts';
import {runExtractionFlow} from '../src/memory/extraction/flow.ts';

const window={owner_id:'11111111-1111-4111-8111-111111111111',contact_id:'22222222-2222-4222-8222-222222222222',messages:[{message_id:'33333333-3333-4333-8333-333333333333',sender:'contact',text:'合成来源。',occurred_at:null}]};

test('未具名和v1旧策略配置明确退役，不能被当前运行时静默升级',async()=>{
 const version=await createExtractionPolicyVersion();
 for(const config of [null,undefined,{version:1,mode:'legacy',rule_set_sha256:null},
  {version:1,mode:'bounded-runtime-v1',rule_set_sha256:'a'.repeat(64)}]){
  assert.throws(()=>validateExtractionRuntimeConfig(config),{code:'extraction_runtime_config_retired'});
  assert.throws(()=>version.resolve(config),{code:'extraction_runtime_config_retired'});
 }
 const config=version.newTaskConfig();
 assert.equal(version.resolve(config).verification.id,'complete-claim-v1');
 assert.throws(()=>version.resolve({...config,source_stamp:'f'.repeat(64)}),{code:'extraction_policy_source_unavailable'});
});

test('旧核验策略和运行模式参数不能绕过显式配置退役',async()=>{
 for(const id of ['legacy-v4','nullable-proof-v3'])
  assert.throws(()=>prepareSourceVerification({window,facts:[],policy:{id},requireCurrent:async()=>{}}),/policy_invalid/);
 let calls=0;
 for(const mode of ['legacy','bounded-runtime-v1'])
  await assert.rejects(runExtractionFlow({window,mode,signal:new AbortController().signal,
   requireCurrent:async()=>{},record:async()=>{},invoke:async()=>{calls++;throw new Error('不得执行');}}),/retired/);
 assert.equal(calls,0);
});
