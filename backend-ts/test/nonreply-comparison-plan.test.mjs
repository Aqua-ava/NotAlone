/** 冻结非回复矩阵的公开计划／执行／报告接缝。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,symlink,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadFrozenMaterials,createPlan,runPlan,assembleReport,assembleUnifiedReport,ROOT} from '../../.scratch/dsh-ts-migration/resumed-nonreply-evaluation/runner.mjs';

const candidate='263365556e9058b3fc7b1abbbdbe43b7f9a323d2';
let frozen;
const materials=async()=>frozen??=await loadFrozenMaterials();

test('CLI经符号路径启动仍生成完整分母报告，退出0不能伪装为未运行',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'notalone-nonreply-cli-'));
  const output=join(ROOT,'.scratch/dsh-ts-migration/resumed-nonreply-evaluation',`test-cli-${randomUUID()}`);
  try{
    const link=join(temporary,'runner.mjs');
    await symlink(join(ROOT,'.scratch/dsh-ts-migration/resumed-nonreply-evaluation/runner.mjs'),link);
    await promisify(execFile)(process.execPath,[link,'plan','--new-commit',candidate,'--output-directory',output],{timeout:10000});
    const report=JSON.parse(await readFile(join(output,'report.json'),'utf8'));
    assert.equal(report.population.planned,1152);
    assert.equal(report.population.recorded,0);
    assert.equal(report.overall,'undetermined');
  }finally{await rm(temporary,{recursive:true,force:true});await rm(output,{recursive:true,force:true});}
});

test('冻结1056分母保持全部case、三个重复和每对连续执行，并拒绝漂移材料',async()=>{
  const bundle=await materials();
  assert.equal(bundle.material_checks.length,56);
  assert.equal(bundle.total_unique_cases,301);
  const plan=createPlan(bundle,{newCommit:candidate});
  assert.equal(plan.runs.length,1056);
  assert.deepEqual(Object.fromEntries(Object.entries(plan.domains).map(([k,v])=>[k,v.logical_runs])),{
    memory_extraction:840,l2_scenario:72,l3_profile:72,skill_learning:72,
  });
  for(let i=0;i<plan.runs.length;i+=2){
    const [a,b]=plan.runs.slice(i,i+2);
    assert.equal(a.case_id,b.case_id);
    assert.equal(a.repeat,b.repeat);
    assert.notEqual(a.arm,b.arm);
    assert.deepEqual(a.scope,b.scope);
  }
  assert.equal(new Set(plan.runs.map(r=>r.run_id)).size,1056);
  assert.throws(()=>createPlan({...bundle,manifest_sha256:'bad'},{newCommit:candidate}),/material/);
  const altered=structuredClone(bundle);
  altered.cases[0].material.input.request='篡改冻结请求';
  assert.throws(()=>createPlan(altered,{newCommit:candidate}),/material/);
  assert.throws(()=>createPlan(bundle,{newCommit:''}),/commit/);
});

test('统一报告保留1152模型分母，召回向量与120正式资格单列，费用豁免不改成通过',async()=>{
  const plan=createPlan(await materials(),{newCommit:candidate});
  const report=assembleUnifiedReport({plan,observations:[],feePolicy:'waived_temporarily_by_user'});
  assert.equal(report.population.planned,1152);
  assert.equal(report.population.missing,1152);
  assert.equal(report.domains.reply.planned,96);
  assert.equal(report.retrieval.status,'not_executed');
  assert.equal(report.formal_120_qualification,'not_executed_separate_requirement');
  assert.equal(report.fee_policy.status,'waived_temporarily_by_user');
  assert.equal(report.fee_policy.measured_pass,false);
  assert.equal(report.overall,'undetermined');
  assert.equal(report.real_model_quality_verified,false);
  const mismatched={schema_version:'reply-migration-report-v1',protocol_version:plan.protocol_version,
    old_commit:plan.old_commit,new_commit:'aaaaaaaa',population:{planned:96,received:96,missing:0},overall:'passed'};
  const combined=assembleUnifiedReport({plan,observations:[],reply:mismatched});
  assert.equal(combined.population.missing,1152);
  assert.ok(combined.blocking_unknowns.includes('reply_candidate_pin_mismatch'));
  assert.equal(combined.reply.observed.population.received,96);
  const qualityFailure={...mismatched,new_commit:candidate,
    bindings:{manifest_sha256:plan.material_hash,arms:{old:{commit:plan.old_commit},new:{commit:candidate}}},
    semantic_quality:{status:'failed'},failure_rate:{status:'passed'},metrics:{cost:{status:'failed'}}};
  const waived=assembleUnifiedReport({plan,observations:[],reply:qualityFailure,feePolicy:'waived_temporarily_by_user'});
  assert.equal(waived.overall,'failed');
});

test('部分执行的失败、取消、未知与未执行全部留在原分母，假provider不能通过真实质量',async()=>{
  const plan=createPlan(await materials(),{newCommit:candidate});
  const selected=plan.runs.slice(0,4).map(r=>r.run_id),seen=[];
  const results=await runPlan(plan,{selectedRunIds:selected,execute:async run=>{
    seen.push(run.run_id);
    if(seen.length===2)throw Object.assign(new Error('synthetic_timeout'),{code:'synthetic_timeout'});
    if(seen.length===3)return{terminal_status:'cancelled',provider_kind:'loopback_fake',physical_calls:0,unknown_reason:'cancelled_before_dispatch'};
    return{terminal_status:'succeeded',provider_kind:'loopback_fake',physical_calls:1,output:{scenes:[]},deterministic_checks:[],unknown_reason:'synthetic_response'};
  }});
  const report=assembleReport(plan,results);
  assert.deepEqual(seen,selected);
  assert.equal(report.population.planned,1056);
  assert.equal(report.population.recorded,4);
  assert.equal(report.population.missing,1052);
  assert.equal(report.population.failed,1);
  assert.equal(report.population.cancelled,1);
  assert.equal(report.real_model_calls,0);
  assert.equal(report.real_model_quality_verified,false);
  assert.equal(report.overall,'undetermined');
  assert.equal(report.semantic_quality.status,'not_reviewed');
  assert.equal(report.cost.status,'undetermined');
  assert.equal(report.records.length,1056);
  assert.throws(()=>assembleReport(plan,[...results,results[0]]),/duplicate/);
  assert.throws(()=>assembleReport(plan,[{...results[0],run_id:'unknown'}]),/unplanned/);
});
