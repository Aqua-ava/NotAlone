/** 完整固定分母、串行逐对执行、持久恢复；真实能力仅由根注入。 */
import assert from 'node:assert/strict';
import {mkdir,lstat,realpath,readFile,writeFile} from 'node:fs/promises';
import {join,sep,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BASELINE,MANIFEST_SHA,DSH_COMMIT} from '../resumed-nonreply-evaluation/runner.mjs';
import {prepareFormalPlan} from '../nonreply-formal-model-seam/plan.mjs';
import {createPersistentBroker} from '../nonreply-persistent-broker/broker.mjs';
import {sha} from '../nonreply-persistent-broker/attempt-journal.mjs';
import {RunJournal,TERMINALS} from './run-journal.mjs';
import {executeSession} from './session-executor.mjs';

export const REPO=fileURLToPath(new URL('../../../',import.meta.url));
const clone=v=>structuredClone(v);
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export async function privateDirectory(path){
  assert.ok(isAbsolute(path??''),'private_absolute_directory_required');const s=await lstat(path);
  assert.ok(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&0o777)===0o700&&s.uid===process.getuid(),'private_directory_required');
  const actual=await realpath(path),repo=await realpath(REPO);
  assert.ok(actual!==repo&&!actual.startsWith(repo+sep),'private_directory_outside_repository_required');return actual;
}
export function population(records){
  const count=status=>records.filter(row=>row.terminal_status===status).length;
  return {planned:records.length,recorded:records.length-count('not_executed'),succeeded:count('succeeded'),failed:count('failed'),
    unknown:count('unknown'),rejected:count('rejected'),idle:count('idle'),cancelled:count('cancelled'),not_executed:count('not_executed')};
}
export function preserveBusinessTerminals(broker,records){
  const business=new Map(records.map(r=>[r.run_id,r.business_terminal_status??r.reported_terminal_status??r.terminal_status]));
  const rows=broker.reconcileExecutorReport({records}).records;
  for(const row of rows){row.business_terminal_status=business.get(row.run_id);row.reported_terminal_status=business.get(row.run_id);}
  return rows;
}
export function reportFor(plan,observations,{source=null,broker=null,runChain=null}={}){
  const allowed=new Map(plan.runs.map(r=>[r.run_id,r])),byId=new Map();
  for(const row of observations){
    const run=allowed.get(row.run_id);assert.ok(run,'unplanned_observation');assert.ok(!byId.has(row.run_id),'duplicate_observation');
    for(const key of ['case_id','case_sha256','commit','domain','arm','repeat'])assert.equal(row[key],run[key],'observation_binding_changed:'+key);
    assert.ok(TERMINALS.includes(row.terminal_status),'observation_terminal_invalid');byId.set(row.run_id,row);
  }
  const records=plan.runs.map(run=>byId.get(run.run_id)??{
    ...Object.fromEntries(['run_id','case_id','case_sha256','arm','commit','domain','repeat','order','sequence'].map(k=>[k,run[k]])),
    terminal_status:'not_executed',physical_calls:null,attempts:[],unknown_reason:'not_executed_in_this_journal',formal_quality:false,
    five_phase_evidence:{complete:false,unknown_reason:'not_executed'},response_model:'unknown',response_fingerprint:'unknown',usage:null,cost:null,
  });
  const counts=population(records),domains=Object.fromEntries(Object.keys(plan.domains).map(d=>[d,population(records.filter(r=>r.domain===d))]));
  return {schema_version:'nonreply-full-orchestration-report-v1',protocol_version:plan.protocol_version,plan_sha256:sha(plan),
    old_commit:plan.old_commit,new_commit:plan.new_commit,material_hash:plan.material_hash,dsh_commit:plan.dsh_commit,source,
    population:{nonreply:counts,unified:{planned:1152,recorded:counts.recorded,not_executed:counts.not_executed+96},reply:{planned:96,recorded:0,not_executed:96}},domains,
    frozen_manifest:{unique_cases:301,memory_extraction:140,reply_fidelity:16,memory_recall:109,organization_learning:36},
    historical_evidence:{source:'resumed-nonreply-evaluation/report.md:16',candidate_commit:'263365556e9058b3fc7b1abbbdbe43b7f9a323d2',
      provider:'loopback_fake',recorded:24,unified_not_executed:1128,nonreply_not_executed:1032,imported_as_current:false},
    retrieval:{cases:109,model_run_denominator:false,status:'separate_numeric_evidence_not_reexecuted_here'},
    broker,run_journal_chain:runChain,records,automatic_retries:0,formal_quality_runs:0,independent_reviews:0,
    policies:{output_capacity_gate:false,cost_gate:false,qualification_execution_gate:false,quality_source_authorization_cancellation_requirements_preserved:true},
    formal120:{status:'not_executed_separate_legacy_requirement',execution_gate:false,agent_review_is_human:false},
    timing:{five_phase_complete:records.filter(r=>r.five_phase_evidence?.complete===true).length,wallclock_total_is_not_five_phase:true},
    tickets_25_26_approved:false,overall:counts.failed?'failed':'undetermined'};
}

export class FullOrchestrator {
  #plan;#ports;#directory;#source;#broker;#journal;#active;#busy=false;#closed=false;#expected;
  constructor({plan,ports={},directory}){this.#plan=freeze(clone(plan));this.#ports=ports;this.#directory=directory;}
  async preflight(){
    const p=this.#ports,plan=this.#plan;
    assert.equal(plan?.runs?.length,1056,'full_nonreply_denominator_required');
    assert.equal(plan.old_commit,BASELINE,'old_source_pin_changed');assert.equal(plan.material_hash,MANIFEST_SHA,'frozen_material_changed');assert.equal(plan.dsh_commit,DSH_COMMIT,'dsh_pin_changed');
    this.#expected??=await prepareFormalPlan({candidateCommit:plan.new_commit});assert.equal(sha(plan),sha(this.#expected),'frozen_plan_bytes_changed');
    assert.equal(typeof p.permission?.assertAllowed,'function','root_permission_required');
    assert.equal(p.budget?.persistent,true,'root_persistent_budget_required');assert.equal(p.budget.reservationOwner,'outer_broker','unique_reservation_owner_required');
    for(const key of ['reserve','ack','inspect'])assert.equal(typeof p.budget[key],'function','root_budget_port_required');
    assert.equal(typeof p.source?.assertCurrent,'function','root_source_required');assert.equal(typeof p.business?.open,'function','named_business_router_required');
    assert.ok(p.transport&&typeof p.transport.prepare==='function','root_explicit_transport_required');
    assert.ok(['loopback_synthetic','official'].includes(p.transport.mode),'root_transport_mode_invalid');
    this.#directory=await privateDirectory(this.#directory);
    const source=await p.source.assertCurrent();assert.equal(source.candidate_commit,plan.new_commit,'candidate_archive_pin_mismatch');assert.equal(source.old_commit,BASELINE,'old_archive_pin_mismatch');
    assert.match(source.source_sha256??'',/^[a-f0-9]{64}$/,'source_snapshot_required');
    if(this.#source)assert.equal(sha(source),sha(this.#source),'source_snapshot_drift');else this.#source=clone(source);
    const status=await p.budget.inspect();assert.equal(status.problemId,p.budget.problemId,'root_problem_changed');assert.equal(status.deadline,p.budget.deadline,'root_deadline_changed');
    assert.ok(Date.now()<status.deadline,'root_deadline_expired');assert.ok(Number.isSafeInteger(status.used)&&status.used>=0,'root_used_counter_required');
    assert.equal(await p.permission.assertAllowed({phase:'preflight',problem_id:p.budget.problemId,plan_sha256:sha(plan)}),true,'root_permission_denied');
    // 资格影响结论，不以旧human/时间、输出或费用门槛阻塞采集。来源及出站许可仍为硬条件。
    const context=await p.observationContext?.inspect?.({plan_sha256:sha(plan),source:clone(source)})??null;
    return {ready:true,candidate_commit:plan.new_commit,source_snapshot_sha256:sha(source),plan_sha256:sha(plan),population:{nonreply:1056,unified:1152},
      transport:p.transport.mode,problem_id:p.budget.problemId,observed_used:status.used,deadline:status.deadline,observation_context:context,
      quality_qualified:false,qualification_execution_gate:false};
  }
  async open(){
    assert.ok(!this.#broker&&!this.#closed,'orchestrator_already_open');await this.preflight();
    const attemptDir=join(this.#directory,'attempt-journal'),runDir=join(this.#directory,'run-journal');
    await mkdir(attemptDir,{mode:0o700,recursive:true});await mkdir(runDir,{mode:0o700,recursive:true});
    this.#broker=await createPersistentBroker({directory:attemptDir,budget:this.#ports.budget,source:this.#ports.source,permission:this.#ports.permission,
      controls:this.#ports.controls??{model:'deepseek-flash',temperature:0,thinking:'disabled'},transport:this.#ports.transport,
      recoverStaleLock:this.#ports.recoverStaleLock,assertCurrent:async binding=>{
        assert.equal(this.#active?.run.run_id,binding.run_id,'active_run_changed');
        const current=await this.#active.session.assertCurrent();assert.deepEqual(current.scope,binding.scope,'broker_scope_changed');
        assert.equal(current.source_sha256,binding.server_source_sha256,'broker_business_source_changed');assert.equal(current.lease_generation,binding.lease_generation,'broker_lease_changed');
      }});
    try{
      this.#journal=await RunJournal.open({directory:runDir,binding:{problem_id:this.#ports.budget.problemId,plan_sha256:sha(this.#plan),source_sha256:sha(this.#source)},recoverStaleLock:this.#ports.recoverStaleLock});
      const attempts=this.#broker.journal.list();
      for(const run of this.#plan.runs){const prior=attempts.filter(a=>a.run_id===run.run_id);if(prior.length&&!this.#journal.get(run.run_id))this.#journal.recoverOrphan(this.#metadata(run),prior);}
      return this;
    }catch(error){await this.#broker.close();throw error;}
  }
  #metadata(run){return Object.fromEntries(['run_id','case_id','case_sha256','arm','commit','domain','repeat','order','sequence','scope'].map(k=>[k,run[k]]));}
  async executePair(runIds,{signal=new AbortController().signal,resume=false}={}){
    assert.ok(!this.#closed&&this.#journal,'orchestrator_not_open');assert.ok(!this.#busy,'orchestrator_serial_only');this.#busy=true;
    try{
      await this.preflight();assert.equal(new Set(runIds).size,2,'one_pair_required');
      const pair=this.#plan.runs.filter(r=>runIds.includes(r.run_id));assert.equal(pair.length,2,'unplanned_run');
      assert.ok(pair[0].case_id===pair[1].case_id&&pair[0].repeat===pair[1].repeat&&pair[0].arm!==pair[1].arm,'paired_selection_required');
      if(!resume)for(const run of pair)assert.equal(this.#journal.get(run.run_id),null,'run_already_recorded');
      const outcomes=[];
      for(const run of pair){
        const prior=this.#journal.get(run.run_id);if(prior){assert.ok(resume,'run_already_recorded');outcomes.push({run_id:run.run_id,action:'retained',terminal_status:prior.terminal_status});continue;}
        if(signal.aborted){outcomes.push({run_id:run.run_id,action:'not_executed',reason:'cancelled_before_business_start'});continue;}
        await this.#ports.business.assertSupports?.(run);
        this.#journal.start(this.#metadata(run));
        const business={open:async current=>{const session=await this.#ports.business.open(current);this.#active={run:current,session};return session;}};
        let record;
        try{record=await executeSession(run,{...this.#ports,business,budget:this.#broker.budget,supplier:this.#broker.supplier,plan:this.#plan},this.#source,signal);}
        finally{this.#active=null;}
        record={...this.#metadata(run),...record};record=preserveBusinessTerminals(this.#broker,[record])[0];
        const attempts=this.#broker.journal.list().filter(a=>a.run_id===run.run_id);
        record.physical_calls=attempts.some(a=>a.physical_attempted===null)?null:attempts.filter(a=>a.physical_attempted===true).length;
        record.attempt_journal_sha256=sha(attempts);record.automatic_retries=0;
        this.#journal.finish(run.run_id,record);outcomes.push({run_id:run.run_id,action:'executed',terminal_status:record.terminal_status});
        await this.#ports.onResult?.(clone(record));
      }
      return {outcomes,report:await this.report()};
    }finally{this.#busy=false;}
  }
  async run({selectedRunIds,signal=new AbortController().signal,resume=true}={}){
    const selected=new Set(selectedRunIds??this.#plan.runs.map(r=>r.run_id));
    for(const id of selected)assert.ok(this.#plan.runs.some(r=>r.run_id===id),'unplanned_selection');
    for(let i=0;i<this.#plan.runs.length;i+=2){const pair=this.#plan.runs.slice(i,i+2);assert.equal(selected.has(pair[0].run_id),selected.has(pair[1].run_id),'unpaired_selection');}
    for(let i=0;i<this.#plan.runs.length&&!signal.aborted;i+=2){const pair=this.#plan.runs.slice(i,i+2);if(selected.has(pair[0].run_id))await this.executePair(pair.map(r=>r.run_id),{signal,resume});}
    return this.report();
  }
  async report(){
    assert.ok(this.#journal&&!this.#closed,'orchestrator_not_open');
    const records=preserveBusinessTerminals(this.#broker,this.#journal.list());
    return reportFor(this.#plan,records,{source:clone(this.#source),broker:await this.#broker.summary(),runChain:this.#journal.verify()});
  }
  async saveReport(path){assert.ok(isAbsolute(path),'report_absolute_path_required');await privateDirectory(dirname(path));const report=await this.report();await writeFile(path,JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});return {report_sha256:sha(report),population:report.population};}
  async close(){if(this.#closed)return;assert.equal(this.#busy,false,'drain_or_abort_active_pair_before_close');await this.#journal?.close();await this.#broker?.close();this.#closed=true;}
}
