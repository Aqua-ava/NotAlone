/** 根注入的统一供应商入口：唯一 reserve、单次 ACK、原字节发送与持久结果。 */
import assert from 'node:assert/strict';
import {AttemptJournal,sha} from './attempt-journal.mjs';
import {ENDPOINTS,PATHS,createOfficialTransport} from './transport.mjs';
const copy=v=>structuredClone(v),terminal=new Set(['responded','failed','unknown']);
const safeError=e=>/^[a-z][a-z0-9_:.-]{1,120}$/.test(e?.message??'')?e.message:'broker_boundary_failed';
function validateRequest(request,binding,controls){
  assert.ok(Object.hasOwn(ENDPOINTS,request.route),'broker_route_not_verified');
  const paths=request.route==='chat'?[PATHS.chat,'/python/chat/completions']:[PATHS[request.route]];
  assert.ok(paths.includes(request.path)&&request.route===binding.route&&request.path===binding.path,'broker_path_changed');
  assert.equal(typeof request.raw,'string','broker_raw_utf8_required');assert.equal(sha(request.raw),binding.request_sha256,'broker_raw_sha_changed');
  const body=JSON.parse(request.raw);assert.deepEqual(body,request.body,'broker_body_raw_changed');
  assert.equal(body.model,controls.model,'broker_model_changed');assert.equal(body.temperature,controls.temperature,'broker_temperature_changed');
  assert.deepEqual(body.thinking,{type:controls.thinking},'broker_thinking_changed');
  assert.ok(body.top_p===undefined||body.top_p===1,'broker_top_p_changed');
  assert.ok(body.max_tokens===undefined||Number.isSafeInteger(body.max_tokens)&&body.max_tokens>0,'broker_actual_output_configuration_invalid');
  assert.ok(Array.isArray(body.messages)&&body.messages.length>0,'broker_messages_missing');
  const keys=request.route==='messages'?['model','stream','messages','max_tokens','thinking','output_config','system','temperature','stop_sequences','tools','tool_choice']:
    ['model','stream','messages','max_tokens','thinking','reasoning_effort','temperature','top_p','stop','tools','tool_choice','response_format'];
  assert.ok(Object.keys(body).every(k=>keys.includes(k)),'broker_unverified_request_field');
  if(request.route==='messages')assert.equal(body.stream,true,'broker_messages_stream_required');
  if(request.route==='strict_chat'){
    assert.equal(body.stream,false,'broker_strict_nonstream_required');assert.equal(body.reasoning_effort,'none','broker_strict_reasoning_changed');
    assert.equal(body.tools?.length,1,'broker_strict_tool_changed');assert.equal(body.tools[0]?.function?.name,'SourceVerificationOutput','broker_strict_tool_changed');
    assert.equal(body.tools[0]?.function?.strict,true,'broker_strict_flag_missing');
    assert.deepEqual(body.tool_choice,{type:'function',function:{name:'SourceVerificationOutput'}},'broker_strict_tool_choice_changed');
  }
  return body;
}
export async function createPersistentBroker({directory,budget:rootBudget,source,permission,assertCurrent,controls,
  transport,resolveCredential,recoverStaleLock}){
  assert.equal(rootBudget?.persistent,true,'root_persistent_budget_required');assert.equal(rootBudget.reservationOwner,'outer_broker','unique_reservation_owner_required');
  for(const k of ['reserve','ack','inspect'])assert.equal(typeof rootBudget[k],'function','root_budget_port_required');
  assert.equal(typeof source?.assertCurrent,'function','root_source_required');assert.equal(typeof permission?.assertAllowed,'function','root_permission_required');
  assert.equal(typeof assertCurrent,'function','root_source_and_lease_guard_required');
  assert.ok(controls?.model==='deepseek-flash'&&controls.temperature===0&&controls.thinking==='disabled','root_verified_controls_required');
  const pinnedControls=Object.freeze(copy(controls)),sourceSnapshot=copy(await source.assertCurrent()),snapshotSha=sha(sourceSnapshot);
  const initial=await rootBudget.inspect();assert.equal(initial.problemId,rootBudget.problemId,'root_problem_changed');assert.equal(initial.deadline,rootBudget.deadline,'root_deadline_changed');
  assert.ok(initial.deadline>Date.now(),'root_deadline_expired');
  assert.ok(Number.isSafeInteger(initial.used)&&initial.used>=0,'root_used_counter_required');
  const wire=transport??createOfficialTransport({resolveCredential});
  assert.ok(['official','loopback_synthetic'].includes(wire.mode)&&typeof wire.prepare==='function','root_transport_invalid');
  const journal=await AttemptJournal.open({directory,problemId:rootBudget.problemId,recoverStaleLock});
  let context;try{context=journal.bindBroker({snapshot_sha256:snapshotSha,deadline:rootBudget.deadline,observed_used:initial.used});}
  catch(e){await journal.close();throw e;}
  const initialUsed=context.initial_used,known=new Map(),validated=new Map();let active=null,sending=null,closed=false,lastUsed=initial.used;
  async function guard(binding,signal){
    assert.ok(!closed,'broker_closed');signal?.throwIfAborted();assert.ok(Date.now()<rootBudget.deadline,'root_deadline_expired');
    assert.equal(binding.problem_id,rootBudget.problemId,'root_problem_changed');assert.equal(binding.source_snapshot_sha256,snapshotSha,'broker_source_binding_changed');
    assert.equal(sha(await source.assertCurrent()),snapshotSha,'broker_source_snapshot_drift');
    assert.equal(await permission.assertAllowed(binding),true,'root_permission_denied');
    await assertCurrent(binding);signal?.throwIfAborted();
  }
  const finishRejected=(id,error,state='failed')=>{const row=journal.get(id);if(row&&!terminal.has(row.state))journal.finish(id,state,
    {outcome_reason:safeError(error),physical_attempted:row.state==='dispatching'?null:false,usage:null,cost:null});};
  const budget=Object.freeze({persistent:true,reservationOwner:'outer_broker',problemId:rootBudget.problemId,deadline:rootBudget.deadline,maxReservations:rootBudget.maxReservations,
    async inspect(){const status=await rootBudget.inspect();assert.equal(status.problemId,rootBudget.problemId,'root_problem_changed');assert.equal(status.deadline,rootBudget.deadline,'root_deadline_changed');
      assert.ok(status.used>=lastUsed,'root_used_counter_decreased');return status;},
    async reserve(binding){
      const id=binding.attempt_id;let invoked=false,claimed=false;
      try{
        assert.ok(!active,'broker_concurrent_dispatch_rejected');active=id;claimed=true;
        const input=validated.get(id);assert.ok(input&&sha(binding)===input.bindingSha,'broker_validation_required');
        assert.equal(journal.get(id)?.state,'ready','journal_ready_required');await guard(binding);
        const before=await budget.inspect();assert.equal(before.used,lastUsed,'root_unaccounted_reservation');
        journal.reserving(id);invoked=true;const reservation=await rootBudget.reserve(binding);
        assert.equal(reservation.binding_sha256,sha(binding),'root_reservation_binding_changed');assert.equal(reservation.problemId,rootBudget.problemId,'root_reservation_problem_changed');
        assert.equal(reservation.ordinal,lastUsed+1,'root_fresh_reservation_required');assert.equal(reservation.deadline,rootBudget.deadline,'root_reservation_deadline_changed');
        assert.equal(reservation.reservation_owner,'outer_broker','root_reservation_owner_changed');
        lastUsed=reservation.ordinal;known.set(id,reservation);journal.reserved(id,reservation);return reservation;
      }catch(e){if(claimed||active!==id)finishRejected(id,e,invoked?'unknown':'failed');if(claimed)active=null;throw e;}
    },
    async ack(reservation){
      const entry=[...known].find(([,r])=>r===reservation);assert.ok(entry,'root_reservation_unrecognized');const [id]=entry;
      try{
        assert.equal(active,id,'root_ack_attempt_changed');assert.equal(journal.get(id)?.state,'reserved','journal_reserved_required');
        assert.equal(sha(reservation),sha(journal.get(id).reservation),'root_reservation_persisted_bytes_changed');
        const ack=await rootBudget.ack(reservation);assert.equal(ack,reservation,'root_reservation_ack_identity_changed');assert.equal(sha(ack),sha(reservation),'root_reservation_ack_changed');
        const status=await budget.inspect();assert.equal(status.used,reservation.ordinal,'root_ack_not_fresh');
        journal.acknowledge(id,ack);return ack;
      }catch(e){finishRejected(id,e,'unknown');if(!sending&&active===id)active=null;throw e;}
    },
  });
  const supplier=Object.freeze({async validate({request,binding}){
    assert.ok(!closed,'broker_closed');validateRequest(request,binding,pinnedControls);assert.equal(binding.source_snapshot_sha256,snapshotSha,'broker_source_binding_changed');
    journal.ready(binding);validated.set(binding.attempt_id,{bindingSha:sha(binding),raw:request.raw,route:request.route,path:request.path});return true;
  },async send({request,binding,reservation,beforeWrite,signal}){
    const id=binding.attempt_id;let authorized=false,claimedSend=false;
    try{
      assert.equal(active,id,'broker_dispatch_without_reservation');assert.equal(known.get(id),reservation,'broker_reservation_identity_changed');
      assert.equal(journal.get(id)?.state,'reserved','journal_reserved_required');
      assert.ok(!sending,'broker_concurrent_send_rejected');sending=id;claimedSend=true;
      const input=validated.get(id);assert.ok(input&&input.bindingSha===sha(binding)&&input.raw===request.raw,'broker_actual_request_changed');
      const body=validateRequest(request,binding,pinnedControls);
      const prepared=await wire.prepare({route:request.route});await guard(binding,signal);
      const send_ack=await beforeWrite(request.raw);assert.ok(send_ack&&typeof send_ack==='object','broker_send_ack_missing');
      assert.equal(send_ack.attempt_id,id,'broker_send_ack_attempt_changed');assert.equal(send_ack.request_sha256,binding.request_sha256,'broker_send_ack_request_changed');
      assert.equal(journal.get(id)?.state,'reserved','journal_reserved_required');assert.ok(journal.get(id).ack_sha256,'broker_fresh_ack_required');
      await guard(binding,signal);await budget.ack(reservation);signal?.throwIfAborted();assert.equal(sha(request.raw),binding.request_sha256,'broker_actual_raw_sha_changed');
      journal.dispatching(id,{ack_sha256:sha(reservation),endpoint:ENDPOINTS[request.route],actual_controls:{model:body.model,max_tokens:body.max_tokens??'omitted',
        configured_max_tokens:pinnedControls.maxTokens??null,output_configuration_matches:body.max_tokens===pinnedControls.maxTokens,temperature:body.temperature,thinking:body.thinking,retry:0},
        transport_mode:wire.mode});authorized=true;
      const result=await prepared.send({raw:request.raw,signal});
      assert.equal(typeof result.physical_attempted,'boolean','broker_transport_receipt_missing');
      assert.ok(['complete','failed','unknown'].includes(result.terminal_status),'broker_transport_terminal_missing');
      journal.finish(id,result.terminal_status==='complete'?'responded':result.terminal_status,
        {physical_attempted:result.physical_attempted,http_status:result.http_status??null,response_sha256:result.response_sha256??null,
          response_model:result.response_model??'unknown',response_fingerprint:result.response_fingerprint??'unknown',usage:result.usage??null,cost:result.cost??null,
          cost_unknown_reason:result.cost_unknown_reason??'no_verified_price_snapshot_injected',usage_unknown_reason:result.usage_unknown_reason??null,
          transport_timeline:result.transport_timeline??null,outcome_reason:result.transport_error??null});
      active=null;sending=null;return {...result,send_ack};
    }catch(e){if(claimedSend){finishRejected(id,e,authorized?'unknown':'failed');active=null;sending=null;}throw e;}
  }});
  return {budget,supplier,journal,sourceSnapshot:copy(sourceSnapshot),
    reconcileExecutorReport(report){
      const value=copy(report),rows=journal.list();
      for(const record of value.records??[]){
        const attempts=rows.filter(row=>row.run_id===record.run_id),failed=attempts.some(row=>row.state==='failed'),unknown=attempts.some(row=>['ready','reserved','dispatching','unknown'].includes(row.state));
        record.reported_terminal_status=record.terminal_status;
        record.broker_attempt_states=attempts.map(row=>({attempt_id:row.attempt_id,state:row.state,physical_attempted:row.physical_attempted}));
        if(record.terminal_status!=='cancelled'&&(failed||unknown)){
          record.terminal_status=failed?'failed':'unknown';record.error_code??=failed?'persistent_broker_failed':'persistent_broker_unknown';
        }
      }
      return value;
    },
    async summary(){const current=await budget.inspect(),rows=journal.list();return {schema_version:'persistent-nonreply-broker-v1',transport:wire.mode,
      initial_used:initialUsed,current_used:current.used,new_reservations:current.used-initialUsed,attempts:rows.length,
      journal_reserved:rows.filter(r=>r.reservation).length,physical_attempts:rows.filter(r=>r.physical_attempted===true).length,
      physical_unknown:rows.filter(r=>r.physical_attempted===null).length,states:Object.fromEntries(['ready','reserved','dispatching','responded','failed','unknown'].map(s=>[s,rows.filter(r=>r.state===s).length])),
      automatic_retries:0,output_capacity_gate:false,cost_gate:false,five_phase_evidence:{complete:false,unknown_reason:'business_start_prepare_and_final_persistence_not_observed_by_transport'},journal_chain:journal.verify()};},
    async close(){if(closed)return;closed=true;await journal.close();},
  };
}
