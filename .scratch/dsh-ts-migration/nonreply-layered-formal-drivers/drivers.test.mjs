/** 只在已约定 business.open / 真实业务 HTTP 接缝检查公开行为。 */
import test from 'node:test';
import assert from 'node:assert/strict';
test('两个具名 driver 暴露 FormalExecutor business.open 并拒绝错域',async()=>{
  const {createL2ScenarioBusiness,createL3ProfileBusiness}=await import('./business.mjs');
  for(const [create,domain]of [[createL2ScenarioBusiness,'l2_scenario'],[createL3ProfileBusiness,'l3_profile']]){
    const business=create({});assert.equal(typeof business.open,'function');
    await assert.rejects(business.open({domain:domain==='l2_scenario'?'l3_profile':'l2_scenario'}),/named_domain_driver_mismatch/);
  }
});
test('未约定的评测时钟在建立数据库及 SDK 之前拒绝',async()=>{
  const {createL2ScenarioBusiness}=await import('./business.mjs');
  const pin='1'.repeat(40),business=createL2ScenarioBusiness({snapshot:{source:{candidate_commit:pin}},evaluationClock:{mode:'time_travel'}});
  await assert.rejects(business.open({domain:'l2_scenario',arm:'new',commit:pin}),/explicit_evaluation_clock_mode_required/);
});
test('仓库目录不能接收原始业务日志或模型正文',async()=>{
  const {createL2ScenarioBusiness}=await import('./business.mjs');
  const pin='1'.repeat(40),business=createL2ScenarioBusiness({snapshot:{source:{candidate_commit:pin}},directory:process.cwd()});
  await assert.rejects(business.open({domain:'l2_scenario',arm:'new',commit:pin}),/private_evidence_directory_required/);
});
