/** 已约定business.open接缝：真实双臂的来源、持久草稿和审核边界。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {runSyntheticProbe} from './probe.mjs';

test('明确纠错经真实双臂业务形成pending草稿，启用v1保持且不自动发布', {timeout:180000}, async()=>{
  const result=await runSyntheticProbe({scenarios:['correction']});
  assert.equal(result.actual_http,2);
  assert.equal(result.budget.used,2);
  assert.ok(result.budget.remaining>2);
  for(const row of result.records){
    assert.equal(row.terminal_status,'succeeded');
    assert.equal(row.draft_count,1);
    assert.deepEqual(row.draft_states,['pending']);
    assert.deepEqual(row.draft_revisions,[1]);
    assert.equal(row.existing_v1_unchanged,true);
    assert.equal(row.correction_source_bound,true);
    assert.equal(row.target_version_bound,true);assert.ok(row.source_rechecks>=4);
    if(row.arm==='new'){
      assert.equal(row.approval_without_comparison.rejected,true);
      assert.ok(Number.isInteger(row.approval_without_comparison.http_status));
    }
    assert.equal(row.pg_ledger_count,1);
    assert.equal(row.actual_http,1);
    assert.equal(row.automatic_retries,0);
    assert.equal(row.published_count,0);
    assert.equal(row.five_phase_evidence.complete,true);
  }
  assert.equal(result.cleanup.complete,true);
  assert.equal(result.formal_quality_runs,0);
});

test('503后两臂各一次HTTP与PG失败台账，充足余额不重试且无草稿', {timeout:180000}, async()=>{
  const result=await runSyntheticProbe({scenarios:['failure']});
  assert.equal(result.actual_http,2);assert.equal(result.budget.used,2);assert.ok(result.budget.remaining>100);
  assert.equal(result.broker.states.failed,2);
  for(const row of result.records){
    assert.equal(row.terminal_status,'failed');assert.equal(row.business_terminal_status,'failed');
    assert.equal(row.actual_http,1);assert.deepEqual(row.http_statuses,[503]);assert.equal(row.pg_ledger_count,1);
    assert.equal(row.draft_count,0);assert.equal(row.published_count,0);assert.equal(row.automatic_retries,0);
    assert.equal(row.task_steps.find(s=>s.step_name==='propose_skill').attempt_count,1);
    assert.equal(row.existing_v1_unchanged,true);assert.equal(row.five_phase_evidence.complete,false);
  }
  assert.equal(result.cleanup.complete,true);
});

test('持久关闭授权后到达的非空提案不保存，原v1不变且真实请求仍记账', {timeout:180000}, async()=>{
  const result=await runSyntheticProbe({scenarios:['cancel']});
  assert.equal(result.actual_http,2);assert.equal(result.budget.used,2);
  assert.equal(result.broker.states.responded,2);
  for(const row of result.records){
    assert.equal(row.terminal_status,'cancelled');assert.equal(row.business_terminal_status,'cancelled');
    assert.equal(row.cancel_persisted,true);assert.equal(row.actual_http,1);assert.equal(row.pg_ledger_count,1);
    assert.equal(row.draft_count,0);assert.equal(row.published_count,0);assert.equal(row.existing_v1_unchanged,true);
    assert.equal(row.automatic_retries,0);
    assert.equal(row.task_states[0].status,'cancelled');
    assert.equal(row.five_phase_evidence.final_persisted_result_ms,null);
  }
  assert.equal(result.cleanup.complete,true);
});

test('缺少协议结束标记保持unknown，不把完整工具JSON冒充持久成功', {timeout:180000}, async()=>{
  const result=await runSyntheticProbe({scenarios:['unknown']});
  assert.equal(result.actual_http,2);assert.equal(result.budget.used,2);assert.equal(result.broker.states.unknown,2);
  for(const row of result.records){
    assert.equal(row.terminal_status,'unknown');assert.equal(row.business_terminal_status,'failed');assert.equal(row.actual_http,1);assert.equal(row.pg_ledger_count,1);
    assert.equal(row.draft_count,0);assert.equal(row.existing_v1_unchanged,true);assert.equal(row.published_count,0);
    assert.equal(row.five_phase_evidence.final_persisted_result_ms,null);
    assert.equal(row.physical_attempts[0].status,'unknown');assert.equal(row.physical_attempts[0].sent,true);
  }
  assert.equal(result.cleanup.complete,true);
});
