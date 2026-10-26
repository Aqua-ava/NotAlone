import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createL2ScenarioWorkerRunner} from '../src/memory/scenarios/worker.ts';

function claim(overrides={}){
  return {
    ownerId:randomUUID(),contactId:randomUUID(),taskId:randomUUID(),stepId:randomUUID(),
    stepName:'organize_memory',workerId:randomUUID(),leaseGeneration:2,messageCount:4,
    ...overrides,
  };
}

test('L2 Worker runner只映射organize_memory并返回真实批次处理量',async()=>{
  const input=claim({contactId:null}),controller=new AbortController();
  let received;
  const runner=createL2ScenarioWorkerRunner({
    async run(scope,modelClaim,signal){
      received={scope,modelClaim,active:!signal.aborted};
      return {state:{},status:'completed',processed_count:3};
    },
  });
  assert.deepEqual(await runner.run(input,controller.signal),{processedCount:3,totalCount:4});
  assert.deepEqual(received,{
    scope:{owner_id:input.ownerId,contact_id:null},
    modelClaim:{task_id:input.taskId,step_id:input.stepId,step_name:'organize_memory',
      worker_id:input.workerId,lease_generation:2},
    active:true,
  });
});

test('L2 Worker runner拒绝错误步骤和在途取消',async()=>{
  let calls=0;
  const runner=createL2ScenarioWorkerRunner({
    async run(){calls++;return {state:{},status:'idle',processed_count:0};},
  });
  await assert.rejects(runner.run(claim({stepName:'extract_memory'}),new AbortController().signal),
    {code:'l2_scenario_worker_claim_invalid'});
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(runner.run(claim(),cancelled.signal),{name:'AbortError'});
  assert.equal(calls,0);
});
