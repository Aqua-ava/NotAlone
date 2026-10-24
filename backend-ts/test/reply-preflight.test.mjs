import test from 'node:test';
import assert from 'node:assert/strict';
import {startReplyPreflightHost} from './reply-preflight-runtime-support.mjs';
test('官方Agent完整system/tools进入预算，成功及超限均零模型HTTP',{timeout:30000},async t=>{
 const host=await startReplyPreflightHost(t),first=await host.request('/preflight',{});
 assert.equal(host.requests.length,0);assert.equal(first.executed,0);assert.ok(first.checks>=2);assert.ok(first.receipt.serialized_bytes>1000);
 const larger=await host.request('/preflight',{largeTool:true});assert.ok(larger.receipt.serialized_bytes>first.receipt.serialized_bytes+10000);assert.notEqual(larger.receipt.request_sha256,first.receipt.request_sha256);
 await assert.rejects(host.request('/preflight',{exceeded:true}),/budget_exceeded/);assert.equal(host.requests.length,0);
 const fitted=await host.request('/preflight',{fit:true});assert.deepEqual(fitted.steps,['full','contact']);assert.equal(fitted.status,'budget_omitted');await assert.rejects(host.request('/preflight',{fit:true,frozen:true}),/budget_exceeded/);assert.equal(host.requests.length,0);
});
