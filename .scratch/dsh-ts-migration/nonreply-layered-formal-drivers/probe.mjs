/** 固定小型工程探针；没有真实供应商或完整矩阵执行选项。 */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,chmod,stat} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createLayeredSnapshot,REPO,OWN,CANDIDATE,hash} from './snapshot.mjs';
import {createL2ScenarioBusiness,createL3ProfileBusiness} from './business.mjs';
import {startSyntheticSupplier} from './loopback-supplier.mjs';
import {FormalExecutor} from '../nonreply-formal-model-seam/formal-executor.mjs';
import {prepareFormalPlan} from '../nonreply-formal-model-seam/plan.mjs';
import {createPersistentBroker} from '../nonreply-persistent-broker/broker.mjs';
import {createLoopbackTransport} from '../nonreply-persistent-broker/transport.mjs';
import {createSyntheticBudget} from '../nonreply-persistent-broker/synthetic-budget.mjs';
const execute=promisify(execFile),args=process.argv.slice(2);
assert.equal(args[0],'--synthetic-only','explicit_synthetic_flag_required');const only=args[1]??'all';assert.ok(['all','l2-success','l3-success','failures','cancellations','guards'].includes(only),'unknown_probe');
const directory=await mkdtemp(join(tmpdir(),'notalone-layered-evidence-'));await chmod(directory,0o700);
const sourceDirectory=join(directory,'source-archive'),snapshot=await createLayeredSnapshot({directory:sourceDirectory});
await writeFile(join(directory,'source-manifest.json'),await readFile(join(sourceDirectory,'source-manifest.json')),{mode:0o600});
const plan=await prepareFormalPlan({candidateCommit:CANDIDATE}),contexts=new Map(),receipts=[],reports=[],runRecords=[],snapshots=[];
let supplier,budget,broker,active,guardMode=null;
const source={assertCurrent:()=>snapshot.assertCurrent()},permission={async assertAllowed(binding){return !(guardMode==='permission'&&binding.phase!=='preflight');}};
try{
  const budgetDirectory=join(directory,'budget');await mkdir(budgetDirectory,{mode:0o700});
  budget=await createSyntheticBudget({directory:budgetDirectory,limit:1000,deadline:Date.now()+900000,problemId:'synthetic-layered-formal-drivers'});
  supplier=await startSyntheticSupplier({});const journal=join(directory,'journal');await mkdir(journal,{mode:0o700});
  broker=await createPersistentBroker({directory:journal,budget:budget.port,source,permission,assertCurrent:async binding=>{const session=active;assert.ok(session,'active_layered_session_required');await session.assertCurrent();},
    controls:{model:'deepseek-flash',maxTokens:393216,temperature:0,thinking:'disabled'},transport:createLoopbackTransport({origin:supplier.origin,timeoutMs:60000})});
  const options={snapshot,directory,contexts,receipts};
  for(const domain of ['l2_scenario','l3_profile'])for(const mode of ['success','http_failure','cancel','permission','source','lease']){
    if(only==='l2-success'&&(domain!=='l2_scenario'||mode!=='success')||only==='l3-success'&&(domain!=='l3_profile'||mode!=='success')||only==='failures'&&mode!=='http_failure'||only==='cancellations'&&mode!=='cancel'||only==='guards'&&!['permission','source','lease'].includes(mode)||only==='all'&&['permission','source','lease'].includes(mode))continue;
    const caseId=domain+(mode==='cancel'?'-11':mode==='source'?'-03':mode==='lease'?'-05':'-01'),repeat=mode==='http_failure'?2:mode==='success'||mode==='cancel'?1:3;
    const pair=plan.runs.filter(r=>r.domain===domain&&r.case_id===caseId&&r.repeat===repeat);assert.equal(pair.length,2);
    const modeDirectory=join(directory,`${domain}-${mode}`);await mkdir(modeDirectory,{mode:0o700});
    const business=(domain==='l2_scenario'?createL2ScenarioBusiness:createL3ProfileBusiness)({...options,directory:modeDirectory});
    const opened={async open(run){const s=await business.open(run);active=s;supplier.setRun(run,mode,s.cancel);guardMode=mode==='permission'?'permission':null;
      const context=contexts.get(run.run_id);if(mode==='source')await context.fixture.client.query("UPDATE source_document SET content_sha256=repeat('f',64) WHERE id=$1",[context.sources[0].storage_id]);
      if(mode==='lease')await context.fixture.client.query('UPDATE background_task_step SET lease_generation=lease_generation+1 WHERE id=$1',[context.claim.stepId]);
      const close=s.close;return {...s,async close(){const context=contexts.get(run.run_id);snapshots.push({run_id:run.run_id,mode,final:await context.durable(),source_hashes:context.sources.map(s=>({source_id:s.source_id,storage_id:s.storage_id,memory_id:s.memory_id,version:s.version,observed_at:s.observed_at,sha256:hash(s.text)}))});await close();active=null;guardMode=null;}};}};
    const executor=new FormalExecutor({plan,budget:broker.budget,source,permission,supplier:broker.supplier,business:opened});
    const reported=await executor.executePair(pair.map(r=>r.run_id)),report=broker.reconcileExecutorReport(reported);reports.push({domain,mode,report});for(const record of report.records)runRecords.push({mode,...record});
    await writeFile(join(directory,`report-${domain}-${mode}.json`),JSON.stringify(report,null,2),{mode:0o600});
    process.stdout.write(JSON.stringify({domain,mode,runs:report.records.map(r=>({arm:r.arm,status:r.terminal_status,error:r.error_code,business_error:r.business_error,attempts:r.attempts.length,audit:r.audit,scenarios:r.business_output?.scenarios.length,profiles:r.business_output?.profiles.length}))})+'\n');
  }
  await writeFile(join(directory,'supplier-requests-raw.json'),JSON.stringify(supplier.requests),{mode:0o600});await writeFile(join(directory,'snapshots-raw.json'),JSON.stringify(snapshots),{mode:0o600});
  const journalSummary=await broker.summary(),budgetSummary=await budget.port.inspect();await writeFile(join(directory,'journal-summary-raw.json'),JSON.stringify(journalSummary),{mode:0o600});
  const summary={schema_version:'layered-formal-driver-engineering-v1',candidate_commit:CANDIDATE,old_commit:snapshot.source.old_commit,source_snapshot_sha256:hash(snapshot.source),
    formal_quality:false,independent_semantic_reviews:0,real_vendor_calls:0,physical_loopback_http:supplier.requests.length,problem_budget:budgetSummary,records:runRecords,cost_status:'unknown_no_vendor_bill',usage_source:'loopback_supplier_declared_fixture',
    persistent_journal:journalSummary,observed_engineering_runs:runRecords.length,unique_planned_run_ids:new Set(runRecords.map(r=>r.run_id)).size,formal_quality_runs:0,nonreply_planned:1056,unified_planned:1152,unified_formal_not_run:1152,source_observation_times:['2026-10-20T09:00:00+08:00'],requested_as_of:'2026-10-23T12:00:00+08:00',effective_clock:'actual_wall_engineering_only',
    frozen_semantic_oracle_used_by_supplier:false,raw_directory_label:directory.split('/').at(-1),expected_probes:only,receipts};
  await snapshot.assertCurrent();await writeFile(join(directory,'summary-raw.json'),JSON.stringify(summary,null,2),{mode:0o600});
  const publicText=JSON.stringify(summary,(key,value)=>['problem_id','problemId','database'].includes(key)?'<synthetic-redacted>':['owner_id','contact_id'].includes(key)&&value!==null?'sha256:'+hash(value):value,2);
  const sanitized=publicText.replaceAll(sourceDirectory,'<owned-source>').replaceAll(directory,'<private-evidence>').replaceAll(REPO,'<repo>').replaceAll(homedir(),'<home>').replace(/\/tmp\/na-model-\d+-[a-f0-9]{24}\/p\.sock/g,'<model-host-socket>');
  await writeFile(new URL('./'+directory.split('/').at(-1)+'-summary.json',import.meta.url),sanitized+'\n');
  let history=[];try{history=JSON.parse(await readFile(new URL('./probe-history.json',import.meta.url)));}catch{}
  history.push({label:directory.split('/').at(-1),raw_sha256:hash(await readFile(join(directory,'summary-raw.json'))),public_sha256:hash(sanitized+'\n'),observed:runRecords.length,physical_http:supplier.requests.length,formal_quality:false});await writeFile(new URL('./probe-history.json',import.meta.url),JSON.stringify(history,null,2)+'\n');
  const checks=runRecords.map(r=>({run_id:r.run_id,mode:r.mode,passed:r.mode==='success'?r.terminal_status==='succeeded'&&r.durable_accounting_matches===true&&(r.domain==='l2_scenario'?r.business_output.scenarios.length>0:r.business_output.profiles.length>0):r.mode==='http_failure'?r.terminal_status==='failed'&&r.attempts.length===1:r.mode==='cancel'?r.terminal_status==='cancelled'&&r.audit.persistent_cancel_committed&&r.business_output.scenarios.length===0&&r.business_output.profiles.length===0&&r.attempts.length===1:['failed','unknown'].includes(r.terminal_status)&&r.attempts.every(a=>a.sent===false)}));
  await writeFile(new URL('./'+directory.split('/').at(-1)+'-checks.json',import.meta.url),JSON.stringify(checks,null,2)+'\n');
  assert.ok(checks.every(c=>c.passed),'layered_engineering_probe_failed');assert.equal(budgetSummary.used,supplier.requests.length,'physical_http_outer_reservations_mismatch');
}catch(error){await writeFile(join(directory,'failure-raw.log'),String(error.stack??error),{mode:0o600});process.stderr.write('layered_probe_failed_private_evidence_preserved\n');throw error;}
finally{await broker?.close();await budget?.close();await supplier?.close();const cleanup=await snapshot.close();await writeFile(join(directory,'cleanup.json'),JSON.stringify({snapshot:cleanup,fixtures:receipts.map(r=>({dropped:r.dropped})),all_fixtures_dropped:receipts.every(r=>r.dropped)}),{mode:0o600});
  await writeFile(new URL('./'+directory.split('/').at(-1)+'-cleanup.json',import.meta.url),JSON.stringify({snapshot:cleanup,all_fixtures_dropped:receipts.every(r=>r.dropped)},null,2)+'\n');}
