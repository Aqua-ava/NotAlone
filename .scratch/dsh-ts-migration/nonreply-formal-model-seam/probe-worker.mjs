/** 仅 archive 内调用；固定一对非空提取，所有传输均为 loopback。 */
import assert from 'node:assert/strict';
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {FormalExecutor,hash} from './formal-executor.mjs';
import {budgetFixture} from './test-fixture.mjs';
import {loadFrozenMaterials,createPlan} from '../resumed-nonreply-evaluation/runner.mjs';
import {writeTracePackets} from '../nonreply-formal-runner-preparation/neutral-trace.mjs';
import {extractionBusiness} from './extraction-business.mjs';
import {createFakeSupplier} from './fake-supplier.mjs';
const [directory]=process.argv.slice(2),snapshotRoot=process.env.NA_SEAM_SNAPSHOT;
assert.ok(directory&&snapshotRoot,'explicit_synthetic_snapshot_required');
const manifest=JSON.parse(await readFile(join(snapshotRoot,'source-manifest.json'),'utf8'));
const source={async assertCurrent(){for(const [name,expected]of Object.entries(manifest.files))assert.equal(hash(await readFile(join(snapshotRoot,'candidate',name))),expected,'snapshot_source_drift:'+name);return manifest.source;}};
const plan=createPlan(await loadFrozenMaterials(),{newCommit:manifest.source.candidate_commit});
const runs=plan.runs.filter(r=>r.case_id==='明确事实'&&r.repeat===1);
const contexts=new Map(),receipts=[],fixture=await budgetFixture({limit:4,deadline:Date.now()+180000});
const supplier=await createFakeSupplier({contexts,directory});let report,used,blind;
try{
  const executor=new FormalExecutor({plan,source,budget:fixture.port,permission:{assertAllowed:async()=>true},supplier:supplier.port,
    business:extractionBusiness({snapshotRoot,directory,contexts,receipts})});
  report=await executor.executePair(runs.map(r=>r.run_id));used=fixture.read();
  await writeFile(join(directory,'raw-report.json'),JSON.stringify(report,null,2),{mode:0o600});
  blind=await writeTracePackets({directory:join(directory,'neutral-packets'),repositoryRoot:join(snapshotRoot,'candidate'),
    records:report.records.map(row=>({case_id:row.case_id,arm:row.arm,commit:row.commit,scope:row.scope,
      events:row.trace_events??[],sources:contexts.get(row.run_id)?.prepared.messages.map(message_id=>({message_id}))??[]}))});
}finally{await supplier.close();await writeFile(join(directory,'budget-final.json'),JSON.stringify(used??fixture.read()),{mode:0o600});await fixture.close();}
const summary={schema_version:'nonreply-model-seam-synthetic-pair-v1',candidate_commit:manifest.source.candidate_commit,
  source_manifest_sha256:hash(await readFile(join(snapshotRoot,'source-manifest.json'))),population:report.population,
  records:report.records.map(r=>({case_id:r.case_id,arm:r.arm,status:r.terminal_status,error:r.error_code??null,
    attempts:r.attempts.map(a=>({route:a.route,status:a.status,sent:a.sent,reservation_ordinal:a.reservation?.ordinal??null,request_sha256:a.request_sha256,
      prompt_sha256:a.prompt_sha256,schema_sha256:a.schema_sha256,controls:a.controls,response_sha256:a.response_sha256??null,error:a.error_code??null})),
    persistent_count:r.audit?.persisted_physical_count??null,durable_accounting_matches:r.durable_accounting_matches??false,
    execution:{runtime:r.execution?.runtime,source_commit:r.execution?.source_commit,profile_sha256:r.execution?.profile_sha256,
      model_host:r.execution?.model_host?.entry,inner_problem_budget_bound:r.execution?.inner_problem_budget_bound},
    trace_events:r.trace_events?.length??0,business_facts:r.business_output?.facts?.length??0,five_phase_evidence:r.five_phase_evidence??null})),
  shared_budget:{problem:used.problem,limit:used.max_calls,used:used.used,removed:true},fake_physical_http:supplier.wire.length,
  real_model_calls:0,receipts:receipts.map(r=>({database:r.database,dropped:r.dropped})),blind,
  formal_quality_runs:0,independent_reviews:0,tickets_25_26_approved:false};
await writeFile(join(directory,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600});
console.log('SEAM_RESULT '+JSON.stringify(summary));
