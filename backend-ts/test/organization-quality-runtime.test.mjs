import test from 'node:test';
import assert from 'node:assert/strict';
import {organizationQualityFixture,inputAnnotations} from './organization-quality-fixture.mjs';
import {createOrganizationQualityRuntime} from '../src/diagnostics/organization-quality-runtime.ts';
import {qualityInputSourceRef} from '../src/diagnostics/organization-quality-store.ts';

test('公开执行的模型边界失败持久终结，不把未发送计成成功或重开后重试',async t=>{
  let calls=0;
  const runtime=createOrganizationQualityRuntime({transportKind:'synthetic',binding:{provider:'synthetic',model:'synthetic',maxTokens:1024,temperature:0,reasoningEffort:'off'},
    profile:{context_window_tokens:128_000,safety_margin_tokens:512},call:async()=>{calls++;throw new Error('合成模型边界不可用');}});
  const f=await organizationQualityFixture(t,{runtime});
  const input=(await f.createInput()).body.quality_input;
  const report=(await f.createRun([input.case_id])).body.quality_report;
  assert.equal((await f.request(`quality-runs/${report.report_id}/execute`,{allow_unreviewed_smoke:false})).status,409);
  assert.equal(calls,0);
  const executed=await f.request(`quality-runs/${report.report_id}/execute`,{allow_unreviewed_smoke:true});
  assert.equal(executed.status,200);
  assert.equal(executed.body.quality_report.state,'complete');
  assert.equal(executed.body.quality_report.organization.status,'failed');
  assert.equal(executed.body.quality_report.cases[0].execution_state,'failed');
  assert.equal(executed.body.quality_report.http_attempts_used,0);
  assert.equal(executed.body.quality_report.phase_counts.l2_proposal.case_denominator,1);
  assert.equal((await f.request(`quality-inputs/${input.case_id}/annotations`,inputAnnotations(input))).status,409);
  await f.request(`quality-runs/${report.report_id}/execute`,{allow_unreviewed_smoke:true});
  assert.equal(calls,1);
});

test('SDK缺安装时累计guard或冻结来源匹配时返回503，且不认领或消费case',async t=>{
  const configurations=[{diagnosticProblemBudgetBound:false,sourceRef:qualityInputSourceRef},
    {diagnosticProblemBudgetBound:true},
    {diagnosticProblemBudgetBound:true,sourceRef:input=>qualityInputSourceRef({...input,input_sha256:'0'.repeat(64)})}];
  for(const configuration of configurations){
    let calls=0;
    const runtime=createOrganizationQualityRuntime({transportKind:'sdk',binding:{provider:'synthetic',model:'synthetic',maxTokens:1024,temperature:0,reasoningEffort:'off'},
      profile:{context_window_tokens:128_000,safety_margin_tokens:512},call:async()=>{calls++;throw new Error('不应进入模型边界');},...configuration});
    const f=await organizationQualityFixture(t,{runtime});
    const input=(await f.createInput()).body.quality_input,report=(await f.createRun([input.case_id])).body.quality_report;
    assert.deepEqual(await f.request(`quality-runs/${report.report_id}/execute`,{allow_unreviewed_smoke:true}),
      {status:503,body:{error:'quality_evaluation_unavailable'}});
    const reopened=(await f.request(`quality-runs/${report.report_id}`)).body.quality_report;
    assert.equal(reopened.state,'prepared');
    assert.equal(reopened.cases[0].execution_state,'prepared');
    assert.equal(reopened.input_review_frozen,false);
    assert.equal(reopened.http_attempts_used,0);
    assert.equal(calls,0);
  }
});
