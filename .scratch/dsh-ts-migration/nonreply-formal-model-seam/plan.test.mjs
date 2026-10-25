import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareFormalPlan,timeQualification} from './plan.mjs';
test('完整1056/1152及原消息锚点保留，不能据此开放统一时间资格',async()=>{
  const plan=await prepareFormalPlan({candidateCommit:'4f89bb976dd4086a02b7ae983fee2760d6e4ff64'});
  assert.equal(plan.runs.length,1056);assert.equal(plan.domains.memory_extraction.cases,140);
  const q=await timeQualification(plan);assert.equal(q.extraction.message_time.status,'matches_frozen_original_builder');
  assert.equal(q.extraction.evaluation_as_of,'unknown');assert.equal(q.skill.public_evaluation_clock,'absent');
  assert.equal(q.operational_clock.global_Date_mocked,false);assert.equal(q.operational_clock.pg_now_mocked,false);
  assert.equal(q.formal_time_qualified,false);
});
