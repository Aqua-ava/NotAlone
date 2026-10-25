import test from 'node:test';
import assert from 'node:assert/strict';
import {preserveBusinessTerminals,reportFor} from './orchestrator.mjs';
import {prepareFormalPlan} from '../nonreply-formal-model-seam/plan.mjs';

test('broker多次降级及resume导出仍保留原业务failed',()=>{
  const broker={reconcileExecutorReport(report){return {records:report.records.map(r=>({...r,reported_terminal_status:r.terminal_status,terminal_status:'unknown'}))};}};
  const first=preserveBusinessTerminals(broker,[{run_id:'stable-run',terminal_status:'failed'}]);
  const resumed=preserveBusinessTerminals(broker,first);
  assert.equal(first[0].terminal_status,'unknown');assert.equal(resumed[0].terminal_status,'unknown');
  assert.equal(resumed[0].business_terminal_status,'failed');assert.equal(resumed[0].reported_terminal_status,'failed');
});
test('完整分母保留失败、未知、空闲和所有未执行，旧fake记录不累计为当前成绩',async()=>{
  const plan=await prepareFormalPlan({candidateCommit:'e60074b5946b8d1c990fcb75ba13bd58f789b2fb'});
  const rows=plan.runs.slice(0,3).map((run,index)=>({...run,terminal_status:['idle','failed','unknown'][index],attempts:[]}));
  const report=reportFor(plan,rows);
  assert.equal(report.records.length,1056);assert.equal(report.population.nonreply.recorded,3);assert.equal(report.population.nonreply.not_executed,1053);
  assert.equal(report.population.nonreply.failed,1);assert.equal(report.population.nonreply.unknown,1);assert.equal(report.population.nonreply.idle,1);
  assert.equal(report.population.unified.not_executed,1149);assert.equal(report.historical_evidence.recorded,24);assert.equal(report.historical_evidence.unified_not_executed,1128);
  assert.equal(report.frozen_manifest.unique_cases,301);assert.equal(report.retrieval.cases,109);assert.equal(report.formal_quality_runs,0);
});
