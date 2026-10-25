/** 仅固定archive运行：官方profile/ModelHost/PG通过broker到localhost。 */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {FormalExecutor} from '../nonreply-formal-model-seam/formal-executor.mjs';
import {extractionBusiness} from '../nonreply-formal-model-seam/extraction-business.mjs';
import {loadFrozenMaterials,createPlan} from '../resumed-nonreply-evaluation/runner.mjs';
import {createPersistentBroker} from './broker.mjs';
import {createSyntheticBudget} from './synthetic-budget.mjs';
import {createLoopbackTransport} from './transport.mjs';
import {startSyntheticUpstream} from './synthetic-upstream.mjs';
import {sha} from './attempt-journal.mjs';
import {budgetFixture} from '../nonreply-formal-model-seam/test-fixture.mjs';
const [snapshotRoot,evidenceRoot]=process.argv.slice(2);assert.ok(snapshotRoot&&evidenceRoot,'private_roots_required');
const frozen=JSON.parse(await readFile(join(snapshotRoot,'snapshot.json'),'utf8'));
const source={async assertCurrent(){for(const [path,digest]of Object.entries(frozen.files))assert.equal(sha(await readFile(join(snapshotRoot,path))),digest,'snapshot_source_changed');
  for(const [path,digest]of Object.entries(frozen.sdk_files))assert.equal(sha(await readFile(join(snapshotRoot,'candidate/backend-ts/node_modules',path))),digest,'installed_sdk_changed');return frozen.source;}};
const plan=createPlan(await loadFrozenMaterials(),{newCommit:frozen.source.candidate_commit}),runs=plan.runs.filter(r=>r.case_id==='明确事实'&&r.repeat===1);
assert.equal(runs.length,2);const scenarios=[];
for(const scenario of ['success','http503']){
  const directory=join(evidenceRoot,scenario);await mkdir(directory,{mode:0o700});const contexts=new Map(),receipts=[],sessions=new Map();
  const upstream=await startSyntheticUpstream({contexts,status:scenario==='http503'?503:200});
  await mkdir(join(directory,'budget'),{mode:0o700});await mkdir(join(directory,'journal'),{mode:0o700});
  const fixture=await createSyntheticBudget({directory:join(directory,'budget'),limit:1000,deadline:Date.now()+180000});
  const permission={assertAllowed:async()=>true};
  const broker=await createPersistentBroker({directory:join(directory,'journal'),budget:fixture.port,source,permission,
    assertCurrent:async binding=>{const session=sessions.get(binding.run_id);assert.ok(session,'synthetic_session_required');await session.assertCurrent();},
    controls:{model:'deepseek-flash',maxTokens:393216,temperature:0,thinking:'disabled'},transport:createLoopbackTransport({origin:upstream.origin})});
  const inner=extractionBusiness({snapshotRoot,directory,contexts,receipts}),business={async open(run){const session=await inner.open(run);sessions.set(run.run_id,session);return session;}};
  let report,summary,rows,reported;
  try{
    const executor=new FormalExecutor({plan,source,permission,budget:broker.budget,supplier:broker.supplier,business});
    reported=await executor.executePair(runs.map(r=>r.run_id));report=broker.reconcileExecutorReport(reported);summary=await broker.summary();rows=broker.journal.list();
    await writeFile(join(directory,'reported-unreconciled.json'),JSON.stringify(reported,null,2),{mode:0o600});
    await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
    await writeFile(join(directory,'wire.json'),JSON.stringify(upstream.wire,null,2),{mode:0o600});
    await writeFile(join(directory,'journal-events.json'),JSON.stringify(broker.journal.events(),null,2),{mode:0o600});
  }finally{await broker.close();await fixture.close();await upstream.close();}
  const result={scenario,population:report.population,overall:'undetermined',formal_quality_runs:0,
    records:report.records.map(r=>({arm:r.arm,terminal_status:r.terminal_status,reported_terminal_status:r.reported_terminal_status,error_code:r.error_code??null,
      attempts:r.attempts.map(a=>({route:a.route,status:a.status,sent:a.sent,request_sha256:a.request_sha256,controls:a.controls})),
      persisted_count:r.audit?.persisted_physical_count??contexts.get(r.run_id)?.final_ledger_count??null,
      model_call_receipts:r.audit?.model_call_receipts??null,durable_accounting_matches:r.durable_accounting_matches??false,
      formal_profile:r.execution?.profile_sha256??null,model_host:r.execution?.model_host?.entry??null,
      inner_problem_budget_bound:r.execution?.inner_problem_budget_bound??null,facts:r.business_output?.facts?.length??null,
      five_phase_evidence:r.five_phase_evidence??{complete:false,unknown_reason:'failed_business_no_final_markers'}})),
    http:upstream.wire.length,request_bytes_preserved:rows.length===upstream.wire.length&&rows.every((r,i)=>r.request_sha256===upstream.wire[i].request_sha256),
    broker:summary,journal:rows.map(r=>({route:r.route,state:r.state,physical_attempted:r.physical_attempted,
      request_sha256:r.request_sha256,response_sha256:r.response_sha256??null,http_status:r.http_status??null,
      controls:r.actual_controls??null,usage:r.usage,cost:r.cost,transport_timeline:r.transport_timeline??null})),
    pg_cleaned:receipts.length===2&&receipts.every(r=>r.dropped),real_supplier_calls:0};
  scenarios.push(result);
}
const bindingFixture=await budgetFixture({limit:1000,deadline:Date.now()+60000});let bridgeContract;
await mkdir(join(evidenceRoot,'frozen-port-journal'),{mode:0o700});
const bindingBroker=await createPersistentBroker({directory:join(evidenceRoot,'frozen-port-journal'),budget:bindingFixture.port,source,
  permission:{assertAllowed:async()=>true},assertCurrent:async()=>{},controls:{model:'deepseek-flash',maxTokens:393216,temperature:0,thinking:'disabled'},
  transport:createLoopbackTransport({origin:'http://127.0.0.1:9'})});
try{
  const body={model:'deepseek-flash',temperature:0,thinking:{type:'disabled'},stream:true,max_tokens:393216,messages:[{role:'user',content:'合成端口合同，不发送'}]},raw=JSON.stringify(body);
  const binding={problem_id:bindingBroker.budget.problemId,attempt_id:'synthetic-frozen-port-attempt',run_id:'synthetic-frozen-port-contract',route:'messages',path:'/anthropic/v1/messages',request_sha256:sha(raw),source_snapshot_sha256:sha(frozen.source)};
  await bindingBroker.supplier.validate({request:{raw,body,path:binding.path,route:binding.route},binding});const r=await bindingBroker.budget.reserve(binding);
  await bindingBroker.budget.ack(r);await bindingBroker.budget.ack(r);
  bridgeContract={frozen_problem_budget_port:true,used:bindingFixture.read().used,ack_count:2,http:0,reserve_count:1,refunds:0,synthetic_fixture_removed:true};
}finally{await bindingBroker.close();await bindingFixture.close();}
await writeFile(join(evidenceRoot,'profile-probe.json'),JSON.stringify({candidate_commit:frozen.source.candidate_commit,sdk:frozen.sdk,legacy_sdk:frozen.legacy_sdk,scenarios,bridge_contract:bridgeContract},null,2),{mode:0o600});
assert.equal(scenarios[0].http,4,'success_http_denominator');assert.equal(scenarios[0].broker.new_reservations,4,'success_outer_reservations');
assert.ok(scenarios[0].records.every(r=>r.terminal_status==='succeeded'&&r.persisted_count===2&&r.durable_accounting_matches),'official_profile_business_failed');
assert.equal(scenarios[1].http,2,'failure_sdk_or_business_retried');assert.equal(scenarios[1].broker.new_reservations,2,'failure_outer_reservations');
assert.ok(scenarios[1].records.every(r=>r.terminal_status==='failed'&&r.persisted_count===1),'failure_persisted_denominator');
assert.ok(scenarios.every(s=>s.pg_cleaned),'owned_pg_cleanup_failed');
assert.ok(scenarios.every(s=>s.request_bytes_preserved),'sdk_request_bytes_changed');assert.equal(bridgeContract.used,1,'ack_must_not_reserve');
console.log(JSON.stringify({success_http:scenarios[0].http,failure_http:scenarios[1].http,actual_supplier_calls:0,pg_cleaned:true}));
