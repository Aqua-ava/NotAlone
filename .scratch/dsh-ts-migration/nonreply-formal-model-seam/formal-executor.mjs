/** 离线默认、仅根注入的非回复执行器；不提供任何默认供应商传输。 */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {BASELINE,DSH_COMMIT,MANIFEST_SHA,loadFrozenMaterials,createPlan} from '../resumed-nonreply-evaluation/runner.mjs';
export const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const clone=value=>structuredClone(value);
function fixed(value){if(value&&typeof value==='object'){Object.values(value).forEach(fixed);Object.freeze(value);}return value;}
function needHash(value,code){assert.match(value??'',/^[a-f0-9]{64}$/,code);}
function needPin(value){assert.match(value??'',/^[a-f0-9]{40}$/,'full_candidate_commit_required');}
function errorCode(error){const line=String(error.message??'executor_failed').split('\n')[0];return /^[a-z][a-z0-9_:.-]{1,160}$/i.test(line)?line:'executor_contract_failed';}
let frozenBundle;
export class FormalExecutor {
  #ports;#source;#busy=false;#records=[];#seen=new Set();
  constructor(ports={}){this.#ports={...ports,plan:ports.plan?fixed(clone(ports.plan)):undefined};}
  async preflight({qualityMode='engineering'}={}){
    const p=this.#ports,plan=p.plan,b=p.budget;
    assert.equal(typeof p.permission?.assertAllowed,'function','root_permission_required');
    assert.equal(b?.persistent,true,'root_persistent_budget_required');
    assert.equal(b.reservationOwner,'outer_broker','unique_reservation_owner_required');
    for(const key of ['inspect','reserve','ack'])assert.equal(typeof b[key],'function','root_budget_port_required');
    assert.ok(b.problemId&&Number.isFinite(b.deadline)&&b.deadline>Date.now(),'root_budget_deadline_expired');
    for(const [port,method]of [[p.source,'assertCurrent'],[p.supplier,'send'],[p.supplier,'validate'],[p.business,'open']])
      assert.equal(typeof port?.[method],'function','root_controlled_port_required');
    needPin(plan?.new_commit);assert.equal(plan.old_commit,BASELINE,'old_source_pin_changed');
    assert.equal(plan.material_hash,MANIFEST_SHA,'frozen_material_changed');assert.equal(plan.dsh_commit,DSH_COMMIT);
    assert.equal(plan.runs.length,1056,'full_nonreply_denominator_required');
    assert.equal(new Set(plan.runs.map(r=>r.run_id)).size,1056,'duplicate_planned_run');
    const expected=createPlan(await (frozenBundle??=loadFrozenMaterials()),{newCommit:plan.new_commit});
    assert.equal(hash(plan),hash(expected),'frozen_plan_bytes_changed');
    const source=await p.source.assertCurrent();
    assert.equal(source.candidate_commit,plan.new_commit,'candidate_archive_pin_mismatch');
    assert.equal(source.old_commit,BASELINE,'old_archive_pin_mismatch');needHash(source.source_sha256,'source_snapshot_required');
    if(this.#source)assert.equal(hash(source),hash(this.#source),'source_snapshot_drift');else this.#source=fixed(clone(source));
    assert.equal(await p.permission.assertAllowed({phase:'preflight',problem_id:b.problemId,plan_sha256:hash(plan)}),true,'root_permission_denied');
    const status=await b.inspect();
    assert.equal(status.problemId,b.problemId,'root_budget_problem_changed');assert.equal(status.deadline,b.deadline,'root_budget_deadline_changed');
    assert.ok(Number.isSafeInteger(status.remaining)&&status.remaining>0,'root_budget_exhausted');
    assert.ok(['engineering','formal'].includes(qualityMode),'quality_mode_invalid');
    if(qualityMode==='formal'){
      assert.equal(typeof p.qualification?.assertQualified,'function','formal_time_and_semantic_qualification_missing');
      const receipt=await p.qualification.assertQualified({plan_sha256:hash(plan),source:clone(source)});
      assert.equal(receipt?.status,'qualified','formal_time_and_semantic_qualification_missing');
      needHash(receipt.evidence_sha256,'formal_qualification_evidence_required');
      assert.equal(receipt.source_snapshot_sha256,hash(source),'formal_qualification_source_changed');
    }
    return {ready:true,mode:'root_injected',quality_qualified:qualityMode==='formal',population:{nonreply:1056,unified:1152},
      problem_id:b.problemId,deadline:b.deadline,remaining:status.remaining,source:clone(source)};
  }
  async executePair(runIds,{signal=new AbortController().signal,qualityMode='engineering'}={}){
    assert.ok(!this.#busy,'executor_serial_only');this.#busy=true;
    try{
      await this.preflight({qualityMode});
      const plan=this.#ports.plan,selected=plan.runs.filter(r=>runIds.includes(r.run_id));
      assert.equal(new Set(runIds).size,2,'one_pair_required');assert.equal(selected.length,2,'unplanned_run');
      const [a,b]=selected;assert.ok(a.case_id===b.case_id&&a.repeat===b.repeat&&a.arm!==b.arm,'paired_selection_required');
      for(const run of selected){assert.ok(!this.#seen.has(run.run_id),'run_already_recorded');this.#seen.add(run.run_id);
        const record=await this.#execute(run,signal);this.#records.push(fixed(record));}
      return this.report();
    }finally{this.#busy=false;}
  }
  async #execute(run,signal){
    const started=performance.now(),record={run_id:run.run_id,case_id:run.case_id,case_sha256:run.case_sha256,arm:run.arm,
      commit:run.commit,domain:run.domain,repeat:run.repeat,scope:clone(run.scope),attempts:[],terminal_status:'unknown',
      response_model:'unknown',response_fingerprint:'unknown',formal_quality:false};
    let session,dispatchBusy=false,failureLatched=false;
    try{
      signal.throwIfAborted();session=await this.#ports.business.open(run);
      assert.equal(session.evidence?.inner_problem_budget_bound,false,'inner_problem_budget_would_double_reserve');
      assert.equal(session.evidence.source_commit,run.commit,'business_source_pin_changed');
      assert.equal(session.evidence.runtime,run.arm==='new'?'typescript':'isolated_python','business_runtime_ownership_invalid');
      needHash(session.evidence.profile_sha256,'actual_profile_hash_required');
      assert.ok(session.evidence.model_host,'model_host_evidence_required');record.execution=clone(session.evidence);
      const original=await session.assertCurrent();
      assert.deepEqual(original.scope,run.scope,'server_scope_mismatch');needHash(original.source_sha256,'server_source_required');
      assert.ok(original.task_id&&Number.isSafeInteger(original.lease_generation),'server_lease_required');
      const recheck=async binding=>{
        signal.throwIfAborted();assert.ok(Date.now()<this.#ports.budget.deadline,'root_budget_deadline_expired');
        assert.equal(hash(await this.#ports.source.assertCurrent()),hash(this.#source),'source_snapshot_drift');
        assert.equal(await this.#ports.permission.assertAllowed(binding),true,'root_permission_denied');
        const current=await session.assertCurrent();assert.equal(hash(current),hash(original),'server_source_or_lease_drift');
        signal.throwIfAborted();
      };
      const dispatch=async input=>{
        assert.ok(!dispatchBusy,'physical_attempts_must_be_serial');dispatchBusy=true;
        const attempt={attempt_id:randomUUID(),route:input.route,path:input.path,request_sha256:hash(input.raw),
          started_at:new Date().toISOString(),status:'preparing',sent:false};record.attempts.push(attempt);
        try{
          assert.ok(!failureLatched,'physical_attempt_after_terminal_failure');
          assert.ok(['messages','strict_chat','chat'].includes(input.route),'physical_route_unknown');
          const raw=String(input.raw),body=JSON.parse(raw);
          assert.ok(body.model==='deepseek-flash'&&body.temperature===0
            &&body.thinking?.type==='disabled'&&(body.top_p===undefined||body.top_p===1),'actual_controls_changed');
          assert.ok(!('budgetBound'in body)&&!('problem_budget'in body),'body_budget_self_attestation_rejected');
          const prompt={system:body.system??body.messages?.filter(m=>m.role==='system'),messages:body.messages};
          attempt.prompt_sha256=hash(prompt);attempt.schema_sha256=hash(body.tools??body.response_format??null);
          attempt.controls={model:body.model,max_tokens:body.max_tokens??'omitted',temperature:body.temperature,top_p:body.top_p??'omitted',
            thinking:body.thinking,stop:body.stop??body.stop_sequences??null,retry:0};
          const binding=fixed({problem_id:this.#ports.budget.problemId,attempt_id:attempt.attempt_id,arm:run.arm,
            run_id:run.run_id,scope:clone(run.scope),source_commit:run.commit,candidate_commit:this.#ports.plan.new_commit,
            case_sha256:run.case_sha256,request_sha256:attempt.request_sha256,prompt_sha256:attempt.prompt_sha256,
            schema_sha256:attempt.schema_sha256,server_source_sha256:original.source_sha256,lease_generation:original.lease_generation,
            source_snapshot_sha256:hash(this.#source),route:input.route,path:input.path});
          const request=fixed({raw,body:clone(body),path:input.path,route:input.route});
          assert.equal(await this.#ports.supplier.validate({request,binding}),true,'supplier_pre_reservation_validation_failed');
          await recheck(binding);
          const reservation=await this.#ports.budget.reserve(binding);attempt.reservation=clone(reservation);attempt.status='reserved';
          let capability,called=false;
          const beforeWrite=async actualRaw=>{
            assert.ok(!called,'send_guard_capability_already_used');called=true;
            const ack=await this.#ports.budget.ack(reservation);assert.equal(hash(ack),hash(reservation),'root_reservation_ack_mismatch');
            assert.equal(reservation.binding_sha256,hash(binding),'root_reservation_binding_mismatch');
            await recheck(binding);assert.equal(hash(actualRaw),binding.request_sha256,'request_bytes_changed');
            input.signal?.throwIfAborted();signal.throwIfAborted();
            capability=Object.freeze({nonce:randomUUID(),attempt_id:attempt.attempt_id,request_sha256:binding.request_sha256});
            attempt.send_authorized=true;attempt.sent=null;attempt.send_authorized_at=new Date().toISOString();return capability;
          };
          const result=await this.#ports.supplier.send({request,
            binding,reservation,beforeWrite,signal});
          assert.ok(called&&capability&&result?.send_ack===capability,'supplier_send_ack_missing');
          assert.equal(result.physical_attempted,true,'supplier_physical_attempt_receipt_required');attempt.sent=true;
          assert.ok(['complete','failed','unknown'].includes(result.terminal_status),'supplier_terminal_unknown');
          Object.assign(attempt,{status:result.terminal_status,response_sha256:result.response_sha256??null,
            response_model:result.response_model??'unknown',response_fingerprint:result.response_fingerprint??'unknown',
            usage:result.usage??null,cost:result.cost??null});
          if(result.terminal_status!=='complete')throw Error('supplier_response_not_complete');
          return result;
        }catch(error){failureLatched=true;attempt.status=signal.aborted?'cancelled':attempt.send_authorized?'unknown':'failed';attempt.error_code=errorCode(error);throw error;}
        finally{attempt.finished_at=new Date().toISOString();dispatchBusy=false;}
      };
      const output=await session.run(dispatch,signal);
      assert.ok(['succeeded','failed','cancelled','unknown'].includes(output.terminal_status),'business_terminal_unknown');
      Object.assign(record,output);
      record.durable_accounting_matches=output.audit?.persisted_physical_count===record.attempts.filter(a=>a.sent).length;
      assert.ok(record.durable_accounting_matches,'durable_physical_accounting_mismatch');
      record.five_phase_evidence=output.five_phase_evidence??{complete:false,unknown_reason:'public_five_phase_boundaries_not_all_observed'};
    }catch(error){record.terminal_status=signal.aborted?'cancelled':'failed';record.error_code=errorCode(error);}
    finally{
      try{await session?.close();}catch(error){record.cleanup_error=error.message;record.terminal_status='failed';}
      record.elapsed_ms=performance.now()-started;
    }
    return record;
  }
  report(){
    return clone({schema_version:'nonreply-formal-executor-v1',records:this.#records,
      population:{nonreply_planned:1056,unified_planned:1152,observed:this.#records.length,not_run:1056-this.#records.length,
        reply_not_run_by_this_executor:96},overall:'undetermined',formal_quality_runs:0,
      independent_reviews:0,tickets_25_26_approved:false});
  }
}
