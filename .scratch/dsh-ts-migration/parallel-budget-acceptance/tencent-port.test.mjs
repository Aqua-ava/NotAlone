/** 只核腾讯入口的范围与错误透传；不评价提示词语义质量。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {L2ScenarioDocumentWorkspace,runScenarioDocumentAgent} from '../../../backend-ts/src/l2-scenario-workspace.ts';
import {L3ProfileWorkspace,runProfileDocumentAgent} from '../../../backend-ts/src/l3-profile-workspace.ts';
import {L2ScenarioModelError} from '../../../backend-ts/src/l2-scenario-model.ts';

const budget={max_memories:20,max_batch_memories:20,max_scenarios:15,max_paragraphs:40,max_characters:128000,max_model_calls:8};
for(const layer of ['l2','l3'])test(`腾讯 ${layer} 入口保留范围、取消、预约前失败和 ACK unknown 原错误`,async()=>{
 const options={claim:{task_id:randomUUID(),step_id:randomUUID(),step_name:'organize_memory',worker_id:randomUUID(),lease_generation:1},
  owner_id:randomUUID(),contact_id:randomUUID(),batch_id:randomUUID(),
  binding:{provider:'synthetic-route',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'},
  profile:{context_window_tokens:32000,safety_margin_tokens:512},signal:new AbortController().signal,requireCurrent:async()=>{}};
 for(const code of ['l2_scenario_model_failed','l2_scenario_model_ack_unknown']){
  const expected=new L2ScenarioModelError(code);let calls=0;
  const port={async call(input){
   calls++;for(const field of ['claim','owner_id','contact_id','batch_id','binding','profile'])assert.deepEqual(input[field],options[field]);
   assert.equal(input.signal,options.signal);assert.equal(input.requireCurrent,options.requireCurrent);
   assert.match(input.system,layer==='l2'?/默认策略是 UPDATE/:/Incremental Evolution Protocol/);
   assert.equal(JSON.parse(input.messages[0].content[0].text).layer,layer);
   throw expected;
  }};
  const run=layer==='l2'
   ?()=>runScenarioDocumentAgent({...options,port,workspace:new L2ScenarioDocumentWorkspace([],[],budget)})
   :()=>runProfileDocumentAgent({...options,port,workspace:new L3ProfileWorkspace(null,[],[],budget),existing:null,scenarios:[],memories:[],changedScenarios:[],removedScenarioVersionIds:[],baseProfileVersionId:null,corrections:[],remainingCalls:8});
  await assert.rejects(run,error=>error===expected&&error.receipt===null);
  assert.equal(calls,1,'物理边界错误必须直接返回，不在入口重新尝试');
 }
});
