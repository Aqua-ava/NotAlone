import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {qualityModelFixture} from './quality-model-fixture.mjs';

test('质量case独立租约通过正式provider/Unix许可/PG后实际HTTP；本人NULL范围沿用同一caller', {timeout:30000}, async t=>{
  const f=await qualityModelFixture(t);
  for (const contact of [f.contactId,null]) {
    const active=await f.case(contact);
    const result=await f.call(active);
    assert.equal(result.code,'ok',JSON.stringify(result));
    assert.equal(result.receipt.outcome,'succeeded');
    assert.equal(result.receipt.contact_id,contact);
    assert.equal(result.receipt.scope_kind,contact===null?'owner_memory':'contact');
    const report=await f.store.reportRows(f.ownerId,active.run_id);
    assert.equal(report.run.http_attempts_used,1);
    assert.equal(report.attempts.length,1);
    assert.equal(report.attempts[0].outcome,'succeeded');
    assert.equal(report.attempts[0].id,result.receipt.attempt_id);
    assert.equal(result.receipt.input_budget.request_sha256.length,64);
  }
  assert.equal(f.requests.length,2);
  assert.deepEqual(f.permit.unconfirmedPermitIds(),[]);
});

test('质量冻结source_ref逐attempt从PG实际case和输入摘要复核，错case或摘要零HTTP', {timeout:30000},async t=>{
  const f=await qualityModelFixture(t);
  const wrongCase=await f.case();
  assert.equal((await f.call(wrongCase,{source_ref:`organization-quality-input-v1:${randomUUID()}:${wrongCase.input_sha256}`})).code,'quality_model_reservation_rejected');
  const wrongDigest=await f.case();
  assert.equal((await f.call(wrongDigest,{source_ref:`organization-quality-input-v1:${wrongDigest.id}:${'0'.repeat(64)}`})).code,'quality_model_reservation_rejected');
  assert.equal(f.requests.length,0);
  assert.deepEqual(f.permit.unconfirmedPermitIds(),[]);
});

test('累计问题预算bound取安装时实际guard状态，修改env不能伪造或解除只读状态', {timeout:30000},async t=>{
  const unbound=await qualityModelFixture(t);
  assert.deepEqual(await unbound.call(null,{inspectBudgetBinding:true,injectEnvironment:true}),{provider:false,caller:false});
  const bound=await qualityModelFixture(t,{problemBudget:true});
  assert.deepEqual(await bound.call(null,{inspectBudgetBinding:true,removeEnvironment:true}),{provider:true,caller:true});
  assert.equal(unbound.requests.length,0);assert.equal(bound.requests.length,0);
});

test('质量PG预约后取消仍保存cancelled/not_sent并消费原预留，不遗留孤儿', {timeout:30000},async t=>{
  const f=await qualityModelFixture(t,{problemBudget:true});
  const active=await f.case(),result=await f.call(active,{cancelAtCheck:4});
  assert.equal(result.code,'quality_model_cancelled');
  assert.equal(result.receipt.outcome,'cancelled');
  assert.equal(result.receipt.dispatch,'not_sent');
  const report=await f.store.reportRows(f.ownerId,active.run_id);
  assert.equal(report.run.http_attempts_used,1);
  assert.equal(report.attempts[0].outcome,'cancelled');
  assert.equal(f.requests.length,0);
  assert.deepEqual(f.permit.unconfirmedPermitIds(),[]);
  const ledger=new DatabaseSync(f.ledger);try{assert.equal(ledger.prepare('SELECT used FROM budget').get().used,1);}finally{ledger.close();}
});

test('最终HTTP实体按Unicode字符计数：中文emoji转义实测相等通过，超1拒绝无新PGunknown或孤儿许可', {timeout:30000},async t=>{
  const f=await qualityModelFixture(t,{problemBudget:true});
  const active=await f.case(),text='中文😀\n"反斜线\\与制表\t';
  assert.equal((await f.call(active,{text})).code,'ok');
  const actual=Array.from(f.rawRequests[0]).length;
  assert.equal(actual,189);
  const report=await f.store.reportRows(f.ownerId,active.run_id);
  assert.equal(report.attempts[0].measurements.request_entity_characters,actual);
  assert.notEqual(actual,Buffer.byteLength(f.rawRequests[0],'utf8'));
  assert.equal((await f.call(active,{text,max_request_characters:actual})).code,'ok');
  assert.equal((await f.call(active,{text,max_request_characters:actual-1})).code,'actual_request_budget_exceeded');
  assert.equal(f.requests.length,2);
  assert.equal((await f.store.reportRows(f.ownerId,active.run_id)).run.http_attempts_used,2);
  assert.deepEqual((await f.pool.query("SELECT outcome FROM model_call_receipt WHERE outcome IN ('pending','unknown')")).rows,[]);
  assert.deepEqual(f.permit.unconfirmedPermitIds(),[]);
  const ledger=new DatabaseSync(f.ledger);try{assert.equal(ledger.prepare('SELECT used FROM budget').get().used,3);}finally{ledger.close();}
});

test('strict provider补充边界：实际HTTP原始中文emoji转义实体计数与普通路同口径', {timeout:30000},async t=>{
  const f=await qualityModelFixture(t,{pluginPath:'test/quality-model-metadata-plugin.ts',onRequest:async(_body,_req,res)=>{
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,
      tool_calls:[{id:'synthetic',type:'function',function:{name:'SourceVerificationOutput',arguments:'{"results":[]}'}}]}}],usage:{prompt_tokens:3,completion_tokens:1}}));return true;
  }});
  const request=async body=>(await fetch(`${f.url}/metadata`,{method:'POST',body:JSON.stringify(body)})).json();
  const text='中文😀\n"反斜线\\与制表\t',first=await request({text});
  assert.equal(first.code,'ok');
  const actual=Array.from(f.rawRequests[0]).length;
  assert.equal(first.characters,actual);
  assert.notEqual(actual,Buffer.byteLength(f.rawRequests[0],'utf8'));
  assert.equal((await request({text,limit:actual})).code,'ok');
  assert.equal((await request({text,limit:actual-1})).code,'synthetic_entity_limit');
  assert.equal(f.requests.length,2);
});

test('有效质量预约ACK丢失保留pending/未知permit，不能settle为未发送或换phase重放', {timeout:30000},async t=>{
  const f=await qualityModelFixture(t,{corruptReserveAck:true,problemBudget:true,hostInChild:true});
  const active=await f.case(),attempt=randomUUID();
  const result=await f.call(active,{attempt_id:attempt});
  assert.equal(result.code,'quality_model_ack_unknown');
  assert.equal(f.requests.length,0);
  assert.equal(f.settledAfterCorruptAck(),0);
  const rows=(await f.pool.query('SELECT outcome,dispatch FROM model_call_receipt WHERE attempt_id=$1',[attempt])).rows;
  assert.deepEqual(rows,[{outcome:'pending',dispatch:'authorized_unconfirmed'}]);
  assert.equal(f.permit.unconfirmedPermitIds().length,1);
  assert.equal((await f.accounting.unconfirmedRequests({owner_id:f.ownerId,contact_id:f.contactId})).length,1);
  assert.equal((await f.call(active)).code,'quality_model_recovery_unknown');
  await f.restart();
  assert.equal((await f.call(active,{phase:'l3_proposal'})).code,'quality_model_reservation_rejected');
  assert.deepEqual((await f.pool.query('SELECT outcome FROM model_call_receipt WHERE attempt_id=$1',[attempt])).rows,[{outcome:'pending'}]);
  assert.equal(f.requests.length,0);
  assert.equal(f.settledAfterCorruptAck(),0);
});

test('transport未知结果和HTTP失败均不退款；未知case更换phase仍零新增HTTP', {timeout:30000},async t=>{
  let fail503=true;
  const f=await qualityModelFixture(t,{problemBudget:true,onRequest:async(body,req,res)=>{
    if(fail503){fail503=false;res.writeHead(503);res.end('{}');return true;}
    req.socket.destroy();return true;
  }});
  const active=await f.case();
  const failed=await f.call(active);
  assert.equal(failed.receipt.outcome,'failed');
  assert.equal(failed.receipt.dispatch,'response_observed');
  const unknown=await f.call(active,{phase:'l2_verification'});
  assert.equal(unknown.receipt.outcome,'unknown');
  assert.equal(unknown.receipt.dispatch,'authorized_unconfirmed');
  await f.restart();
  assert.equal((await f.call(active,{phase:'l3_proposal'})).code,'quality_model_reservation_rejected');
  assert.equal(f.requests.length,2);
  const report=await f.store.reportRows(f.ownerId,active.run_id);
  assert.equal(report.run.http_attempts_used,3);
  assert.deepEqual(report.attempts.slice(0,2).map(attempt=>attempt.outcome),['failed','unknown']);
  const ledger=new DatabaseSync(f.ledger);try{assert.equal(ledger.prepare('SELECT used FROM budget').get().used,3);}finally{ledger.close();}
  assert.deepEqual(f.permit.unconfirmedPermitIds(),[]);
});

test('宿主按原case累计上限拒绝换phase扩额，run预约不二扣', {timeout:30000},async t=>{
  const f=await qualityModelFixture(t,{caseLimit:2});
  const active=await f.case();
  assert.equal((await f.call(active,{phase:'l2_proposal'})).code,'ok');
  assert.equal((await f.call(active,{phase:'l2_verification'})).code,'ok');
  assert.equal((await f.call(active,{phase:'l3_proposal'})).code,'quality_model_reservation_rejected');
  assert.equal(f.requests.length,2);
  const report=await f.store.reportRows(f.ownerId,active.run_id);
  assert.equal(report.run.http_attempts_used,3);
  assert.equal(report.attempts.length,3);
  assert.deepEqual(f.permit.unconfirmedPermitIds(),[]);
});

test('PG预约后租约失效与HTTP返回前来源撤销拒绝质量晚写，保留实际消费元数据', {timeout:30000},async t=>{
  let expire=true;
  const f=await qualityModelFixture(t,{afterReserve:async pool=>{
    if(expire){expire=false;await pool.query("UPDATE organization_quality_case SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE execution_state='running'");}
  }});
  const expired=await f.case();
  const before=await f.call(expired);
  assert.equal(before.code,'quality_model_scope_stale');
  assert.equal(before.receipt.dispatch,'not_sent');
  assert.equal(f.requests.length,0);
  const report=await f.store.reportRows(f.ownerId,expired.run_id);
  assert.equal(report.attempts[0].response_payload,null);
  assert.deepEqual(f.permit.unconfirmedPermitIds(),[]);
  const g=await qualityModelFixture(t,{onRequest:async(_body,_req,_res,pool)=>{
    await pool.query('DELETE FROM source_document');return false;
  }});
  const revoked=await g.case();
  const after=await g.call(revoked);
  assert.equal(after.code,'quality_model_scope_stale');
  assert.equal(after.receipt.outcome,'succeeded');
  assert.equal(g.requests.length,1);
  await assert.rejects(g.store.reportRows(g.ownerId,revoked.run_id),/quality_evidence_not_found/);
  assert.deepEqual(g.permit.unconfirmedPermitIds(),[]);
});

test('质量case错误scope/token/稳定请求/过期与generation撤销均零HTTP', {timeout:30000},async t=>{
  const f=await qualityModelFixture(t);
  const wrongScope=await f.case();
  assert.equal((await f.call(wrongScope,{contact_id:randomUUID()})).code,'quality_model_reservation_rejected');
  const wrongOwner=await f.case();
  assert.equal((await f.call(wrongOwner,{owner_id:randomUUID()})).code,'quality_model_reservation_rejected');
  assert.equal((await f.call(wrongScope,{execution_token:randomUUID()})).code,'quality_evidence_not_found');
  assert.equal((await f.call(wrongScope,{request_id:randomUUID()})).code,'quality_model_request_invalid');
  const expired=await f.case();
  await f.pool.query("UPDATE organization_quality_case SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expired.id]);
  assert.equal((await f.call(expired)).code,'quality_evidence_not_found');
  const revoked=await f.case();
  await f.pool.query('UPDATE layered_memory_state SET settings_generation=settings_generation+1 WHERE owner_id=$1 AND contact_id=$2',[f.ownerId,f.contactId]);
  assert.equal((await f.call(revoked)).code,'quality_evidence_not_found');
  assert.equal(f.requests.length,0);
  assert.deepEqual(f.permit.unconfirmedPermitIds(),[]);
});

test('六phase同run累计8次不退款，第九次在实际provider发送处拒绝且零新增HTTP', {timeout:30000},async t=>{
  const f=await qualityModelFixture(t,{problemBudget:true});
  const active=await f.case();
  const phases=['l2_proposal','l2_verification','l3_proposal','l3_verification','l2_challenge','l3_challenge','l2_proposal','l3_proposal'];
  for(const phase of phases)assert.equal((await f.call(active,{phase})).code,'ok');
  const denied=await f.call(active,{phase:'l2_proposal'});
  assert.equal(denied.code,'quality_model_failed');
  assert.equal(f.requests.length,8);
  const report=await f.store.reportRows(f.ownerId,active.run_id);
  assert.equal(report.run.http_attempts_used,8);
  assert.equal(report.attempts.length,8);
  const ledger=new DatabaseSync(f.ledger);try{assert.equal(ledger.prepare('SELECT used FROM budget').get().used,8);}finally{ledger.close();}
  assert.deepEqual(f.permit.unconfirmedPermitIds(),[]);
});
