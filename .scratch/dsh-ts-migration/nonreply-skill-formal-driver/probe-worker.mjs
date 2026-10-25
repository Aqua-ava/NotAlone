/** archive内的小样本工程执行；完整1056/1152分母保持。 */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {FormalExecutor} from '../nonreply-formal-model-seam/formal-executor.mjs';
import {prepareFormalPlan,timeQualification} from '../nonreply-formal-model-seam/plan.mjs';
import {createPersistentBroker} from '../nonreply-persistent-broker/broker.mjs';
import {createLoopbackTransport} from '../nonreply-persistent-broker/transport.mjs';
import {createSyntheticBudget} from '../nonreply-persistent-broker/synthetic-budget.mjs';
import {createSkillBusiness} from './skill-business.mjs';
import {createSupplier} from './supplier.mjs';
import {sha,PIN} from './snapshot.mjs';
const [directory,snapshotRoot,scenarioText]=process.argv.slice(2),scenarios=JSON.parse(scenarioText);
assert.ok(directory&&snapshotRoot&&Array.isArray(scenarios));
const manifest=JSON.parse(await readFile(join(snapshotRoot,'source-manifest.json'),'utf8'));
const source={async assertCurrent(){
  for(const [name,expected] of Object.entries(manifest.files))assert.equal(sha(await readFile(join(snapshotRoot,'candidate',name))),expected,'snapshot_source_drift:'+name);
  return manifest.source;
}};
const plan=await prepareFormalPlan({candidateCommit:PIN}),time=await timeQualification(plan);
const contexts=new Map(),receipts=[],modes=new Map(),selected=[];
for(const scenario of scenarios){
  const [caseId,repeat]=scenario==='correction'?['skill_learning-12',1]:scenario==='cancel'?['skill_learning-11',1]:scenario==='failure'?['skill_learning-01',1]:['skill_learning-01',2];
  const runs=plan.runs.filter(r=>r.case_id===caseId&&r.repeat===repeat);assert.equal(runs.length,2);
  selected.push(runs.map(r=>r.run_id));for(const r of runs)modes.set(r.run_id,scenario);
}
const permission={async assertAllowed(binding){assert.ok(binding.problem_id==='synthetic-skill-formal-driver');return true;}};
const budgetDirectory=join(directory,'synthetic-problem'),journalDirectory=join(directory,'attempt-journal');
await mkdir(budgetDirectory,{mode:0o700});await mkdir(journalDirectory,{mode:0o700});
const budget=await createSyntheticBudget({directory:budgetDirectory,limit:1000,deadline:Date.now()+300000,problemId:'synthetic-skill-formal-driver'});
const supplier=await createSupplier({contexts,directory});let broker,report,summary;
try{
  broker=await createPersistentBroker({directory:journalDirectory,budget:budget.port,source,permission,
    assertCurrent:async binding=>{const session=contexts.get(binding.run_id)?.session;assert.ok(session,'server_skill_session_required');const current=await session.assertCurrent();assert.equal(current.source_sha256,binding.server_source_sha256);assert.equal(current.lease_generation,binding.lease_generation);},
    controls:{model:'deepseek-flash',maxTokens:393216,temperature:0,thinking:'disabled'},transport:createLoopbackTransport({origin:supplier.origin,timeoutMs:20000})});
  const business=createSkillBusiness({snapshotRoot,directory,contexts,receipts,modes}),open=business.open.bind(business);
  business.open=async run=>{const session=await open(run);contexts.get(run.run_id).session=session;return session;};
  const executor=new FormalExecutor({plan,source,permission,budget:broker.budget,supplier:broker.supplier,business});
  for(const pair of selected)report=await executor.executePair(pair);
  await writeFile(join(directory,'executor-reported-raw.json'),JSON.stringify(report,null,2),{mode:0o600});
  report=broker.reconcileExecutorReport(report);
  let formalPreflight;
  try{await executor.preflight({qualityMode:'formal'});formalPreflight={blocked:false};}
  catch(error){formalPreflight={blocked:true,error_code:error.message,qualification_injected:false};}
  assert.equal(formalPreflight.blocked,true,'formal_quality_must_remain_unqualified');
  await source.assertCurrent();
  await writeFile(join(directory,'raw-report.json'),JSON.stringify(report,null,2),{mode:0o600});
  await writeFile(join(directory,'raw-time-qualification.json'),JSON.stringify(time,null,2),{mode:0o600});
  const brokerSummary=await broker.summary(),journal=broker.journal.list();
  const finalBudget=await budget.port.inspect();
  const records=report.records.map(row=>{
    const output=contexts.get(row.run_id)?.output,audit=output?.audit,drafts=output?.business_output.drafts??[];
    const wire=supplier.wire.filter(w=>w.run_id===row.run_id),attempts=journal.filter(j=>j.binding?.run_id===row.run_id||j.run_id===row.run_id);
    return {case_id:row.case_id,arm:row.arm,scenario:modes.get(row.run_id),source_commit:row.commit,terminal_status:row.terminal_status,
      business_terminal_status:output?.terminal_status??null,error_code:row.error_code??null,
      executor_reported_terminal_status:row.reported_terminal_status,broker_attempt_states:row.broker_attempt_states.map(a=>({state:a.state,physical_attempted:a.physical_attempted})),
      actual_http:wire.length,http_statuses:wire.map(w=>w.http_status),pg_ledger_count:audit?.persisted_physical_count??null,
      pg_ledger_outcomes:audit?.actual_ledger.map(l=>l.outcome)??null,pg_usage:audit?.actual_ledger.map(l=>({input_tokens:l.input_tokens,output_tokens:l.output_tokens}))??null,
      model_call_receipts:audit?.model_call_receipts??null,model_host_journal_sha256:audit?.model_host_journal_sha256??null,
      draft_count:drafts.length,draft_states:drafts.map(d=>d.status),draft_revisions:drafts.map(d=>d.revision),
      existing_v1_unchanged:audit?.existing_v1_unchanged??null,correction_source_bound:audit?.correction_source_bound??null,
      source_rechecks:audit?.source_rechecks??0,target_version_bound:audit?.target_version_bound??null,approval_without_comparison:audit?.approval_without_comparison??null,
      actual_wall_started_at:output?.observed_events.find(e=>e.type==='business_service_start')?.wall_at??null,
      actual_pg_observed_at:audit?.actual_pg_observed_at??null,draft_persisted_at:drafts.map(d=>d.created_at),
      published_count:audit?.published_count??null,cancel_persisted:audit?.cancel_persisted??false,
      automatic_retries:0,task_states:audit?.task_states??null,task_steps:audit?.task_steps??null,
      source_binding_sha256:audit?.actual_source_snapshot_sha256??null,source_versions:audit?.source_versions??null,
      five_phase_evidence:output?.five_phase_evidence??row.five_phase_evidence??{complete:false,unknown_reason:'business_open_failed'},
      execution:{runtime:row.execution?.runtime,profile_sha256:row.execution?.profile_sha256,profile_template_sha256:row.execution?.profile_template_sha256,
        model_host:row.execution?.model_host?.entry,public_entry:row.execution?.public_entry,inner_problem_budget_bound:row.execution?.inner_problem_budget_bound,
        normal_new_entry_python_processes:row.arm==='new'?0:null,background_worker_started:false,controls:row.execution?.controls,clock:row.execution?.clock},
      physical_attempts:row.attempts.map(a=>({route:a.route,status:a.status,sent:a.sent,reservation_ordinal:a.reservation?.ordinal??null,
        request_sha256:a.request_sha256,prompt_sha256:a.prompt_sha256,schema_sha256:a.schema_sha256,controls:a.controls,
        response_sha256:a.response_sha256??null,usage:a.usage??null,cost:a.cost??null,error_code:a.error_code??null})),
      broker_attempts:attempts.length};
  });
  summary={schema_version:'skill-formal-driver-engineering-v1',candidate_commit:PIN,old_commit:plan.old_commit,source_snapshot_sha256:sha(manifest.source),
    plan_sha256:sha(plan),material_manifest_sha256:plan.material_hash,source_manifest_sha256:sha(manifest),population:report.population,
    scenarios,records,actual_http:supplier.wire.length,budget:{used:finalBudget.used,limit:finalBudget.maxReservations,remaining:finalBudget.remaining},broker:brokerSummary,
    time_qualification:time,formal_preflight:formalPreflight,fixtures:receipts.map(r=>({dropped:r.dropped,database_absent:r.database_absent,remaining_connections:r.remaining_connections,migrations:r.migrations,python_processes:r.python_processes})),
    real_supplier_calls:0,formal_quality_runs:0,independent_reviews:0,output_capacity_gate:false,cost_gate:false,cost:null,cost_unknown_reason:'loopback_synthetic_no_billing_or_price_snapshot',
    cleanup:{complete:receipts.every(r=>r.dropped&&r.database_absent&&r.remaining_connections===0)},tickets_25_26_approved:false};
  await writeFile(join(directory,'broker-journal-raw.json'),JSON.stringify(journal,null,2),{mode:0o600});
  await writeFile(join(directory,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600});
  console.log('SKILL_SUMMARY '+JSON.stringify({records:records.length,actual_http:summary.actual_http,statuses:records.map(r=>[r.arm,r.terminal_status,r.error_code]),cleanup:summary.cleanup}));
}finally{
  await supplier.close();await broker?.close();await budget.close();
  await writeFile(join(directory,'final-fixtures.json'),JSON.stringify(receipts),{mode:0o600});
}
