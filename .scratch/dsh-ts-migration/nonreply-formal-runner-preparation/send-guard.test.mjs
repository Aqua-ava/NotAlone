import test from 'node:test';
import assert from 'node:assert/strict';
import {createSendGuard,syntheticBudget} from './send-guard.mjs';

test('真实开关、缺少根预算或许可在传输之前拒绝，已发送失败不退额度',async()=>{
  let sent=0;
  const request={endpoint:'http://127.0.0.1:1234/v1',scope:{owner_id:'synthetic-owner',contact_id:'synthetic-contact'},
    candidate_commit:'4f89bb976dd4086a02b7ae983fee2760d6e4ff64',source_commit:'4f89bb976dd4086a02b7ae983fee2760d6e4ff64',
    arm:'new',run_id:'synthetic:1:new',case_sha256:'b'.repeat(64),request_sha256:'a'.repeat(64),signal:new AbortController().signal};
  const transmit=async()=>{sent++;throw Error('synthetic_failure');};
  assert.throws(()=>createSendGuard({mode:'real'}),/real_transport_disabled/);
  assert.throws(()=>createSendGuard({mode:'loopback_fake'}),/root_budget_required/);
  const budget=syntheticBudget({limit:1,problemId:'synthetic-shared-both-arms'});
  assert.throws(()=>createSendGuard({mode:'loopback_fake',budget}),/root_permission_required/);
  const guard=createSendGuard({mode:'loopback_fake',budget,permission:{assertAllowed:async()=>true}});
  await assert.rejects(guard.send({...request,endpoint:'https://example.invalid'},transmit),/loopback_only/);
  assert.equal(sent,0);
  await assert.rejects(guard.send(request,transmit),/synthetic_failure/);
  await assert.rejects(guard.send(request,transmit),/synthetic_budget_exhausted/);
  assert.equal(sent,1);assert.equal(budget.snapshot().reserved,1);
  const expired=syntheticBudget({limit:1,problemId:'synthetic-expired',deadline:Date.now()-1});
  const expiredGuard=createSendGuard({mode:'loopback_fake',budget:expired,permission:{assertAllowed:async()=>true}});
  await assert.rejects(expiredGuard.send(request,transmit),/root_budget_deadline_expired/);
  assert.equal(expired.snapshot().reserved,0);assert.equal(sent,1);
});
