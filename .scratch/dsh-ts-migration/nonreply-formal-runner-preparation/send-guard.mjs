/** 根注入预算与许可的发送接缝；本交付永远拒绝真实供应商。 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export function createSendGuard({mode='offline',budget,permission}={}){
  assert.equal(mode,'loopback_fake','real_transport_disabled');
  assert.ok(budget&&typeof budget.reserve==='function'&&budget.problemId,'root_budget_required');
  assert.ok(Number.isFinite(budget.deadline)&&budget.deadline>0,'root_budget_deadline_required');
  assert.ok(permission&&typeof permission.assertAllowed==='function','root_permission_required');
  return {async send(input,transmit){
    const url=new URL(input.endpoint);
    assert.ok(url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)
      &&!url.username&&!url.password,'loopback_only');
    assert.match(input.candidate_commit??'',/^[a-f0-9]{40}$/,'candidate_pin_required');
    assert.match(input.request_sha256??'',/^[a-f0-9]{64}$/,'request_hash_required');
    assert.match(input.case_sha256??'',/^[a-f0-9]{64}$/,'case_hash_required');
    assert.match(input.source_commit??'',/^[a-f0-9]{40}$/,'arm_source_pin_required');
    assert.ok(['old','new'].includes(input.arm)&&input.run_id,'planned_run_binding_required');
    assert.ok(input.scope?.owner_id&&input.scope?.contact_id,'scope_required');
    assert.ok(Date.now()<budget.deadline,'root_budget_deadline_expired');
    input.signal?.throwIfAborted();
    assert.equal(await permission.assertAllowed({...input,problem_id:budget.problemId}),true,'root_permission_denied');
    const reservation=await budget.reserve({...input,attempt_id:randomUUID(),problem_id:budget.problemId});
    assert.ok(reservation?.reservation_id&&typeof reservation.assertCurrent==='function'
      &&typeof reservation.markSent==='function'&&typeof reservation.settle==='function','root_reservation_invalid');
    let sent=false;
    try{
      input.signal?.throwIfAborted();
      assert.equal(await permission.assertAllowed({...input,problem_id:budget.problemId}),true,'root_permission_denied');
      assert.ok(Date.now()<budget.deadline,'root_budget_deadline_expired');
      await reservation.assertCurrent(input);await reservation.markSent(input);sent=true;
      const value=await transmit(input);
      await reservation.settle({status:'succeeded',sent:true});return value;
    }catch(error){
      await reservation.settle({status:input.signal?.aborted?'cancelled':'failed',sent,error_code:error.code??error.message});
      throw error;
    }
  }};
}

/** 只供本机替身探针的共享额度，不能替代根持久问题账本。 */
export function syntheticBudget({limit,problemId,deadline=Date.now()+300000}){
  assert.ok(Number.isSafeInteger(limit)&&limit>0&&problemId?.startsWith('synthetic-'),'synthetic_budget_invalid');
  const attempts=[];
  return {problemId,deadline,async reserve(input){
    assert.ok(attempts.length<limit,'synthetic_budget_exhausted');
    const row={reservation_id:randomUUID(),attempt_id:input.attempt_id,status:'reserved',sent:false};attempts.push(row);
    return {...row,assertCurrent:async()=>true,markSent:async()=>{row.sent=true;},
      settle:async result=>{Object.assign(row,result);}};
  },snapshot:()=>({synthetic_only:true,persistent:false,formal_budget:false,limit,reserved:attempts.length,attempts:structuredClone(attempts)})};
}
