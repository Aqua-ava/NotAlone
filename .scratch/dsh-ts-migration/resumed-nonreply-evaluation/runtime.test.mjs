/** 本机假provider经官方profile及业务入口；只运行一个冻结成对切片。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadFrozenMaterials,createPlan,runPlan,assembleReport} from './runner.mjs';
import {createOfflineAdapter} from './offline-adapter.mjs';
const candidate=process.env.NOTALONE_NONREPLY_CANDIDATE_COMMIT??'263365556e9058b3fc7b1abbbdbe43b7f9a323d2';

test('同一冻结提取例经固定Python及官方TS profile得到来源、持久台账和完整记录',{timeout:120000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'notalone-nonreply-paired-'));
  const plan=createPlan(await loadFrozenMaterials(),{newCommit:candidate});
  const pair=plan.runs.filter(r=>r.case_id==='明确事实'&&r.repeat===1);
  assert.equal(pair.length,2);
  const adapter=await createOfflineAdapter({plan,directory});
  try{
    const results=await runPlan(plan,{execute:adapter.execute,selectedRunIds:pair.map(r=>r.run_id)});
    assert.equal(results.length,2);
    for(const result of results){
      assert.equal(result.terminal_status,'succeeded',JSON.stringify(result));
      assert.ok(result.physical_calls>=1);
      assert.equal(result.audit.persisted_physical_count,result.physical_calls);
      assert.ok(result.audit.trace_count>=1);
      assert.equal(result.audit.input_message_count,pair[0].material.messages.length);
      assert.equal(result.audit.external_connections,0);
      assert.equal(result.audit.dsh_profile_started,result.arm==='new');
    }
    const report=assembleReport(plan,results);
    assert.equal(report.population.missing,1054);
    assert.equal(report.real_model_quality_verified,false);
  }finally{await adapter.close();await rm(directory,{recursive:true,force:true});}
});

test('L2、L3与学习的冻结成对切片保持公开入口与未评分状态',{timeout:120000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'notalone-nonreply-domains-'));
  const plan=createPlan(await loadFrozenMaterials(),{newCommit:candidate});
  const ids=new Set(['l2_scenario-01','l3_profile-01','skill_learning-01']);
  const selected=plan.runs.filter(r=>ids.has(r.case_id)&&r.repeat===1).map(r=>r.run_id);
  const adapter=await createOfflineAdapter({plan,directory});
  try{
    const results=await runPlan(plan,{execute:adapter.execute,selectedRunIds:selected});
    for(const result of results){
      assert.equal(result.terminal_status,'succeeded',JSON.stringify(result));
      assert.equal(result.output?.state?.error_code??null,null,JSON.stringify({run_id:result.run_id,state:result.output?.state}));
      assert.equal(result.audit.persisted_physical_count,result.physical_calls);
    }
    const report=assembleReport(plan,results);
    assert.equal(report.population.recorded,6);
    assert.equal(report.population.missing,1050);
    assert.equal(report.semantic_quality.status,'not_reviewed');
    assert.equal(report.real_model_calls,0);
  }finally{await adapter.close();await rm(directory,{recursive:true,force:true});}
});
