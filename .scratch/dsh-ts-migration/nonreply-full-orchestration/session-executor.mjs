/** 冻结执行器的显式新版本；原件 SHA256：0d3d7f333df64d72b57d453f68cd7b018642ff50a67b89dc2d778d3cac3cbcc3。
 * 业务与物理尝试逐次复验；阶段缺失保持 unknown。 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sha as hash} from '../nonreply-persistent-broker/attempt-journal.mjs';
const clone=value=>structuredClone(value);
function fixed(value){if(value&&typeof value==='object'){Object.values(value).forEach(fixed);Object.freeze(value);}return value;}
function needHash(value,code){assert.match(value??'',/^[a-f0-9]{64}$/,code);}
function errorCode(error){const line=String(error.message??'executor_failed').split('\n')[0];return /^[a-z][a-z0-9_:.-]{1,160}$/i.test(line)?line:'executor_contract_failed';}
export async function executeSession(run,ports,source,signal){
    const started=performance.now(),record={run_id:run.run_id,case_id:run.case_id,case_sha256:run.case_sha256,arm:run.arm,
      commit:run.commit,domain:run.domain,repeat:run.repeat,scope:clone(run.scope),attempts:[],terminal_status:'unknown',
      response_model:'unknown',response_fingerprint:'unknown',formal_quality:false,started_at:new Date().toISOString()};
    let session,dispatchBusy=false,failureLatched=false;
    try{
      signal.throwIfAborted();session=await ports.business.open(run);
      assert.equal(session.evidence?.inner_problem_budget_bound,false,'inner_problem_budget_would_double_reserve');
      assert.equal(session.evidence.source_commit,run.commit,'business_source_pin_changed');
      assert.equal(session.evidence.runtime,run.arm==='new'?'typescript':'isolated_python','business_runtime_ownership_invalid');
      needHash(session.evidence.profile_sha256,'actual_profile_hash_required');
      assert.ok(session.evidence.model_host,'model_host_evidence_required');record.execution=clone(session.evidence);
      const original=fixed(clone(await session.assertCurrent()));
      assert.deepEqual(original.scope,run.scope,'server_scope_mismatch');needHash(original.source_sha256,'server_source_required');
      if(['taskless','observed_terminal'].includes(original.execution_kind)){
        const zeroGuard=async()=>{
          signal.throwIfAborted();assert.ok(Date.now()<ports.budget.deadline,'root_budget_deadline_expired');
          assert.equal(hash(await ports.source.assertCurrent()),hash(source),'source_snapshot_drift');
          assert.equal(await ports.permission.assertAllowed({phase:'zero_call',run_id:run.run_id,scope:run.scope,problem_id:ports.budget.problemId}),true,'root_permission_denied');
          signal.throwIfAborted();
        };
        await zeroGuard();
        record.taskless=original.execution_kind==='taskless';record.zero_call=true;
        if(record.taskless)assert.equal(original.task_id,null,'taskless_fake_task_forbidden');
        else assert.ok(original.task_id,'observed_terminal_actual_task_required');
        assert.equal(original.lease_generation,null,'taskless_fake_lease_forbidden');
        assert.equal(typeof ports.tasklessEvidence?.verify,'function','taskless_public_evidence_verifier_required');
        const before=await ports.tasklessEvidence.verify({run,current:original,session,phase:'before'});
        assert.equal(before?.verified,true,'taskless_public_evidence_unverified');
        await zeroGuard();
        let attempted=false;
        const output=await session.run(async()=>{attempted=true;throw Error('taskless_model_dispatch_forbidden');},signal);
        assert.equal(attempted,false,'taskless_model_dispatch_forbidden');
        const afterCurrent=await session.assertCurrent();
        assert.equal(hash(afterCurrent),hash(original),'taskless_business_snapshot_changed');
        const proof=await ports.tasklessEvidence.verify({run,current:afterCurrent,session,output,phase:'after'});
        await zeroGuard();
        for(const evidence of [before,proof]){
          assert.equal(evidence.verified,true,'taskless_public_evidence_unverified');
          assert.deepEqual(evidence.scope,run.scope,'taskless_scope_changed');
          assert.equal(evidence.source_sha256,original.source_sha256,'taskless_source_changed');
          if(record.taskless)assert.equal(evidence.task_count,0,'taskless_actual_task_exists');
          else assert.ok(evidence.task_count>0&&evidence.terminal_task_ids?.includes(original.task_id),'actual_terminal_task_evidence_required');
          assert.equal(evidence.ledger_count,0,'taskless_actual_ledger_exists');
          needHash(evidence.public_response_sha256,'taskless_public_response_required');
          assert.ok(typeof evidence.authorization?.allowed==='boolean','taskless_authorization_required');
          assert.ok(['empty','disabled','rejected','not_ready','cancelled'].includes(evidence.status),'taskless_business_status_required');
        }
        assert.ok(['idle','rejected','cancelled'].includes(output.terminal_status),'taskless_terminal_invalid');
        assert.equal(output.audit?.persisted_physical_count,0,'taskless_physical_count_changed');
        if(output.terminal_status==='rejected')assert.equal(proof.status,'rejected','taskless_rejection_not_observed');
        assert.ok(!['run_id','case_id','case_sha256','arm','commit','domain','repeat','scope','attempts'].some(key=>key in output),'business_record_identity_override');
      Object.assign(record,output);record.taskless_evidence=proof;record.durable_accounting_matches=true;
        record.five_phase_evidence=output.five_phase_evidence??{complete:false,unknown_reason:'zero_call_business_terminal_no_model_phases'};
        return record;
      }
      assert.ok(original.task_id&&Number.isSafeInteger(original.lease_generation),'server_lease_required');
      const recheck=async binding=>{
        signal.throwIfAborted();assert.ok(Date.now()<ports.budget.deadline,'root_budget_deadline_expired');
        assert.equal(hash(await ports.source.assertCurrent()),hash(source),'source_snapshot_drift');
        assert.equal(await ports.permission.assertAllowed(binding),true,'root_permission_denied');
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
          const binding=fixed({problem_id:ports.budget.problemId,attempt_id:attempt.attempt_id,arm:run.arm,
            run_id:run.run_id,scope:clone(run.scope),source_commit:run.commit,candidate_commit:ports.plan.new_commit,
            case_sha256:run.case_sha256,request_sha256:attempt.request_sha256,prompt_sha256:attempt.prompt_sha256,
            schema_sha256:attempt.schema_sha256,server_source_sha256:original.source_sha256,lease_generation:original.lease_generation,
            source_snapshot_sha256:hash(source),route:input.route,path:input.path});
          const request=fixed({raw,body:clone(body),path:input.path,route:input.route});
          assert.equal(await ports.supplier.validate({request,binding}),true,'supplier_pre_reservation_validation_failed');
          await recheck(binding);
          const reservation=await ports.budget.reserve(binding);attempt.reservation=clone(reservation);attempt.status='reserved';
          let capability,called=false;
          const beforeWrite=async actualRaw=>{
            assert.ok(!called,'send_guard_capability_already_used');called=true;
            const ack=await ports.budget.ack(reservation);assert.equal(hash(ack),hash(reservation),'root_reservation_ack_mismatch');
            assert.equal(reservation.binding_sha256,hash(binding),'root_reservation_binding_mismatch');
            await recheck(binding);assert.equal(hash(actualRaw),binding.request_sha256,'request_bytes_changed');
            input.signal?.throwIfAborted();signal.throwIfAborted();
            capability=Object.freeze({nonce:randomUUID(),attempt_id:attempt.attempt_id,request_sha256:binding.request_sha256});
            attempt.send_authorized=true;attempt.sent=null;attempt.send_authorized_at=new Date().toISOString();return capability;
          };
          const result=await ports.supplier.send({request,
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
      assert.ok(!['run_id','case_id','case_sha256','arm','commit','domain','repeat','scope','attempts'].some(key=>key in output),'business_record_identity_override');
      Object.assign(record,output);
      record.durable_accounting_matches=output.audit?.persisted_physical_count===record.attempts.filter(a=>a.sent).length;
      assert.ok(record.durable_accounting_matches,'durable_physical_accounting_mismatch');
      record.five_phase_evidence=output.five_phase_evidence??{complete:false,unknown_reason:'public_five_phase_boundaries_not_all_observed'};
    }catch(error){record.terminal_status=signal.aborted?'cancelled':'failed';record.error_code=errorCode(error);}
    finally{
      try{await session?.close();}catch(error){record.cleanup_error=error.message;record.terminal_status='failed';}
      record.elapsed_ms=performance.now()-started;record.ended_at=new Date().toISOString();
    }
    return record;
  }
