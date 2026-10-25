/** 有界混合工程小集：实际业务/SDK/PG、仅localhost供应商；从不跑1056假样本。 */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,chmod,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createUnifiedSnapshot} from './snapshot.mjs';
import {FullOrchestrator,privateDirectory} from './orchestrator.mjs';
import {createNamedRouter,materialCoverage} from './router.mjs';
import {prepareFormalPlan} from '../nonreply-formal-model-seam/plan.mjs';
import {createSyntheticBudget} from '../nonreply-persistent-broker/synthetic-budget.mjs';
import {createLoopbackTransport} from '../nonreply-persistent-broker/transport.mjs';
import {startSyntheticUpstream} from '../nonreply-persistent-broker/synthetic-upstream.mjs';
import {sha} from '../nonreply-persistent-broker/attempt-journal.mjs';
import {exportBlind} from './blind.mjs';
const args=process.argv.slice(2),arg=name=>args[args.indexOf('--'+name)+1];
assert.ok(args.includes('--synthetic-only'),'explicit_synthetic_only_required');
const directory=await privateDirectory(arg('directory')),candidateCommit=args.includes('--candidate-commit')?arg('candidate-commit'):'e60074b5946b8d1c990fcb75ba13bd58f789b2fb';
const selection=args.includes('--selection')?arg('selection'):'mixed';assert.ok(['zero','empty','mixed'].includes(selection),'fixed_synthetic_selection_required');
const snapshotDirectory=join(directory,'source');await mkdir(snapshotDirectory,{mode:0o700});
const snapshot=await createUnifiedSnapshot({directory:snapshotDirectory,candidateCommit});
const plan=await prepareFormalPlan({candidateCommit}),contexts=new Map(),activeContexts=new Map(),receipts=[],modes=new Map();
let orchestrator,budget,extraction,extractionFailure,layered,skill,current,report,cleanup;
const selectedCases=selection==='empty'?[["l2_scenario","l2_scenario-02",1]]:selection==='zero'?[["skill_learning","skill_learning-02",1],["l2_scenario","l2_scenario-02",1]]:
  [["memory_extraction","明确事实",1],["l2_scenario","l2_scenario-01",1],["l3_profile","l3_profile-01",1],["skill_learning","skill_learning-12",1],
    ["skill_learning","skill_learning-02",1],["l2_scenario","l2_scenario-02",1],["memory_extraction","明确事实",2],["skill_learning","skill_learning-01",2]];
const pairs=selectedCases.map(([domain,caseId,repeat])=>{const pair=plan.runs.filter(r=>r.domain===domain&&r.case_id===caseId&&r.repeat===repeat);assert.equal(pair.length,2);return pair;});
for(const run of pairs.flat())if(run.domain==='skill_learning')modes.set(run.run_id,run.case_id==='skill_learning-01'?'unknown':'correction');
const originalCwd=process.cwd();
try{
  process.chdir(join(snapshot.candidate,'backend-ts'));
  const load=path=>import(pathToFileURL(join(snapshot.candidate,'.scratch/dsh-ts-migration',path)));
  const [{startSyntheticSupplier},{createSupplier}]=await Promise.all([load('nonreply-layered-formal-drivers/loopback-supplier.mjs'),load('nonreply-skill-formal-driver/supplier.mjs')]);
  extraction=await startSyntheticUpstream({contexts:activeContexts});extractionFailure=await startSyntheticUpstream({contexts:activeContexts,status:503});
  layered=await startSyntheticSupplier({});skill=await createSupplier({contexts:activeContexts,directory});
  const transports={extraction:createLoopbackTransport({origin:extraction.origin,timeoutMs:30000}),fault:createLoopbackTransport({origin:extractionFailure.origin,timeoutMs:30000}),
    layered:createLoopbackTransport({origin:layered.origin,timeoutMs:60000}),skill:createLoopbackTransport({origin:skill.origin,timeoutMs:30000})};
  const router=await createNamedRouter({snapshot,directory,contexts,receipts,modes,onOpen:async({run,session,context})=>{
    current=run;activeContexts.clear();activeContexts.set(run.run_id,context);
    if(['l2_scenario','l3_profile'].includes(run.domain))layered.setRun(run,'success',session.cancel);
  }});
  const budgetDirectory=join(directory,'budget');await mkdir(budgetDirectory,{mode:0o700});
  budget=await createSyntheticBudget({directory:budgetDirectory,limit:1000,deadline:Date.now()+900000,problemId:'synthetic-full-orchestration'});
  const executionDirectory=join(directory,'execution');await mkdir(executionDirectory,{mode:0o700});
  const ports={...router,budget:budget.port,source:{assertCurrent:()=>snapshot.assertCurrent()},permission:{async assertAllowed(){return true;}},
    controls:{model:'deepseek-flash',maxTokens:393216,temperature:0,thinking:'disabled'},
    transport:{mode:'loopback_synthetic',async prepare(input){assert.ok(current,'current_synthetic_run_required');
      const transport=current.domain==='memory_extraction'?(current.repeat===2?transports.fault:transports.extraction):current.domain==='skill_learning'?transports.skill:transports.layered;
      return transport.prepare(input);}}};
  orchestrator=await new FullOrchestrator({plan,ports,directory:executionDirectory}).open();
  for(const pair of pairs){
    const result=await orchestrator.executePair(pair.map(r=>r.run_id));
    process.stdout.write(JSON.stringify({case_id:pair[0].case_id,repeat:pair[0].repeat,outcomes:result.outcomes.map(r=>({status:r.terminal_status,action:r.action}))})+'\n');
    await writeFile(join(directory,'last-report.json'),JSON.stringify(result.report,null,2),{mode:0o600});
  }
  report=await orchestrator.report();const usedBefore=(await budget.port.inspect()).used;
  await orchestrator.close();orchestrator=await new FullOrchestrator({plan,ports,directory:executionDirectory}).open();
  for(const pair of pairs){const result=await orchestrator.executePair(pair.map(r=>r.run_id),{resume:true});assert.ok(result.outcomes.every(r=>r.action==='retained'),'resume_replayed_recorded_run');}
  assert.equal((await budget.port.inspect()).used,usedBefore,'resume_consumed_new_reservation');report=await orchestrator.report();
  const physical=extraction.wire.length+extractionFailure.wire.length+layered.requests.length+skill.wire.length;
  assert.equal(physical,usedBefore,'physical_http_outer_reservations_mismatch');assert.equal(report.broker.physical_attempts,physical,'physical_http_journal_mismatch');
  const observed=report.records.filter(r=>r.terminal_status!=='not_executed'),checks=[];
  for(const row of observed){
    const success=row.repeat===1&&!row.case_id.endsWith('-02'),fault=row.domain==='memory_extraction'&&row.repeat===2,unknown=row.domain==='skill_learning'&&row.repeat===2;
    checks.push({run_id:row.run_id,passed:fault?row.terminal_status==='failed'&&row.attempts.length===1:unknown?row.terminal_status==='unknown'&&row.attempts.length===1:success?
      row.terminal_status==='succeeded'&&row.durable_accounting_matches===true:row.terminal_status==='idle'&&row.physical_calls===0,
      status:row.terminal_status,error_code:row.error_code??null});
  }
  const nonempty=Object.fromEntries(['memory_extraction','l2_scenario','l3_profile','skill_learning'].map(domain=>[domain,observed.filter(r=>r.domain===domain&&r.terminal_status==='succeeded').map(r=>{
    const output=r.business_output;return domain==='memory_extraction'?output?.facts?.length>0:domain==='skill_learning'?output?.drafts?.length>0:domain==='l2_scenario'?output?.scenarios?.length>0:output?.profiles?.length>0;})]));
  if(selection==='mixed')for(const values of Object.values(nonempty))assert.ok(values.length===2&&values.every(Boolean),'named_domain_nonempty_not_observed');
  const projector={contract_sha256:sha(await readFile(new URL('./probe.mjs',import.meta.url))),async project({run,record}){
    if(record.terminal_status!=='succeeded')return {items:[],unobserved:record.terminal_status,source_mapping_status:'not_prepared_for_formal_review'};
    const output=record.business_output;let texts=[];
    if(run.domain==='memory_extraction')texts=(output?.facts??[]).map(f=>f.text_content??f.text);
    if(run.domain==='l2_scenario')texts=(output?.scenarios??[]).flatMap(f=>f.paragraphs?.map(p=>p.text)??[f.title??'场景正文尚未规范化']);
    if(run.domain==='l3_profile')texts=(output?.profiles??[]).flatMap(f=>f.entries?.map(p=>p.text)??[f.summary??'画像正文尚未规范化']);
    if(run.domain==='skill_learning')texts=(output?.drafts??[]).flatMap(f=>f.strategy?.methods?.map(m=>m.instruction)??['合成待审提案已持久化']);
    return {items:texts.map(text=>({kind:run.domain,text:String(text),evidence:[],status:'synthetic_engineering_only'})),source_mapping_status:'not_prepared_for_formal_review'};
  }};
  const blind=await exportBlind({plan,report,directory:join(directory,'blind'),projector});
  const summary={schema_version:'full-orchestration-synthetic-probe-v1',candidate_commit:candidateCommit,final_production_pin:false,selection,node_version:process.version,
    old_commit:plan.old_commit,material_hash:plan.material_hash,source_snapshot_sha256:sha(snapshot.source),plan_sha256:sha(plan),population:report.population,
    domains:report.domains,physical_loopback_http:physical,outer_used:usedBefore,attempt_journal:report.broker,states:checks,nonempty,
    zero_call:observed.filter(r=>r.zero_call).map(r=>({run_id:r.run_id,taskless:r.taskless,terminal_status:r.terminal_status,physical_calls:r.physical_calls,
      actual_task_count:r.taskless_evidence.task_count,status:r.taskless_evidence.status,auxiliary_rejection:r.audit.auxiliary_foreign_scope_rejection??null})),
    material_coverage:materialCoverage(plan),blind,resume_replayed:0,sdk_retries:0,business_retries:0,real_supplier_calls:0,app_runs:0,wechat_runs:0,
    formal_quality_runs:0,tickets_25_26_approved:false,checks_passed:checks.every(c=>c.passed),all_failures_preserved:true};
  await writeFile(join(directory,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600});
  await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
  await writeFile(join(directory,'supplier-metadata.json'),JSON.stringify({extraction:extraction.wire,extractionFailure:extractionFailure.wire,layered:layered.requests}),{mode:0o600});
  assert.ok(summary.checks_passed,'mixed_probe_contract_failed');
  process.stdout.write(JSON.stringify({summary_sha256:sha(summary),population:summary.population,http:physical,reserve:usedBefore,checks_passed:true})+'\n');
}catch(error){await writeFile(join(directory,'failure.log'),String(error.stack??error),{mode:0o600});process.stderr.write('synthetic_orchestration_failed_private_evidence_preserved\n');throw error;}
finally{
  await orchestrator?.close();await budget?.close();await extraction?.close();await extractionFailure?.close();await layered?.close();await skill?.close();process.chdir(originalCwd);
  cleanup={snapshot:await snapshot.close(),fixtures:receipts.map(r=>({dropped:r.dropped,remaining_connections:r.remaining_connections??null})),all_fixtures_dropped:receipts.every(r=>r.dropped),real_supplier_calls:0};
  await writeFile(join(directory,'cleanup.json'),JSON.stringify(cleanup),{mode:0o600});
}
