import test from 'node:test';
import assert from 'node:assert/strict';
import {executeSession} from './session-executor.mjs';

const run={run_id:'synthetic-taskless',case_id:'empty',arm:'new',commit:'a'.repeat(40),domain:'l2_scenario',repeat:1,scope:{owner_id:'owner',contact_id:'contact'}};
function taskless({attemptSend=false,verified=true,rejection=false,onVerify}={}){
  let sent=0,reserved=0,businessRuns=0;
  const current={scope:run.scope,source_sha256:'c'.repeat(64),execution_kind:'taskless',task_id:null,lease_generation:null};
  const output={terminal_status:rejection?'rejected':'idle',business_output:{status:rejection?'rejected':'empty'},audit:{persisted_physical_count:0}};
  const ports={budget:{deadline:Date.now()+60000,async reserve(){reserved++;}},supplier:{async send(){sent++;}},source:{async assertCurrent(){return {};}},permission:{async assertAllowed(){return true;}},
    tasklessEvidence:{async verify(){await onVerify?.();return {verified,scope:run.scope,source_sha256:current.source_sha256,task_count:0,ledger_count:0,public_response_sha256:'d'.repeat(64),authorization:{allowed:!rejection},status:rejection?'rejected':'empty'};}},
    business:{async open(){return {evidence:{source_commit:run.commit,runtime:'typescript',inner_problem_budget_bound:false,profile_sha256:'b'.repeat(64),model_host:{used:false}},async assertCurrent(){return current;},async run(dispatch){businessRuns++;if(attemptSend)try{await dispatch({raw:'{}'});}catch{}return output;},async close(){}};}}};
  return {ports,counts:()=>({sent,reserved}),businessRuns:()=>businessRuns};
}
test('合法无任务 empty 记录 idle 和零调用，不伪造租约',async()=>{
  const fixture=taskless();const result=await executeSession(run,fixture.ports,{},new AbortController().signal);
  assert.equal(result.terminal_status,'idle');assert.equal(result.taskless,true);assert.equal(result.attempts.length,0);assert.deepEqual(fixture.counts(),{sent:0,reserved:0});
});
test('无任务路径即使吞掉 dispatch 错误，也不能被记为 idle 或消费额度',async()=>{
  const fixture=taskless({attemptSend:true});const result=await executeSession(run,fixture.ports,{},new AbortController().signal);
  assert.equal(result.terminal_status,'failed');assert.equal(result.error_code,'taskless_model_dispatch_forbidden');assert.deepEqual(fixture.counts(),{sent:0,reserved:0});
});
test('公开无任务证据未核验时，在业务运行前拒绝',async()=>{
  const fixture=taskless({verified:false});const result=await executeSession(run,fixture.ports,{},new AbortController().signal);
  assert.equal(result.terminal_status,'failed');assert.equal(fixture.businessRuns(),0);
});
test('明确已观察的范围拒绝保留rejected，不降格为unknown',async()=>{
  const fixture=taskless({rejection:true});const result=await executeSession(run,fixture.ports,{},new AbortController().signal);
  assert.equal(result.terminal_status,'rejected');assert.equal(result.attempts.length,0);assert.deepEqual(fixture.counts(),{sent:0,reserved:0});
});
test('零调用证据复验期间取消，禁止继续运行业务或把迟到结果记idle',async()=>{
  const controller=new AbortController(),fixture=taskless({onVerify:()=>controller.abort()});
  const result=await executeSession(run,fixture.ports,{},controller.signal);
  assert.equal(result.terminal_status,'cancelled');assert.equal(fixture.businessRuns(),0);assert.deepEqual(fixture.counts(),{sent:0,reserved:0});
});
