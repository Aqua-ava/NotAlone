import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
async function seeded(t){
 const registryModule=new URL('./fixtures/memory-sqlite/shared-execution-deletion-registry.mjs',import.meta.url).href;
 const f=await fixture(t,{registryModule}),contacts=[];
 for(const saved of f.saved){await f.service.synchronize(saved.contact_id);const message=(await f.service.read(saved.contact_id)).messages.find(row=>row.kind==='text');contacts.push({contactId:saved.contact_id,messageId:message.id,recordId:message.sourceRecordIds[0]});}
 const ids=await f.storage.execute('fixture.sharedSeed',{owner,contacts});
 return {...f,...ids,deletion:new DeletionService(f.storage,new ActiveHolders(),new ManagedFiles(f.root)),state:()=>f.storage.execute('fixture.sharedExecutionState',{owner})};
}
test('共享追踪先清真实reply父引用，单来源封存调用后整联系人和账号仍精确清账',async t=>{
 const f=await seeded(t);
 const plan=await f.deletion.plan({ownerId:owner,requestKey:'reply-source',scope:{kind:'source',contactId:f.a.contact,sourceId:f.a.record}});
 assert.ok(plan.targets.some(row=>row.target?.domain==='discussion_calls'&&row.target.rowKind==='model_call'&&row.target.key.id===f.a.call),'11实际reply分支必须进入共享模型与追踪清理闭包');
 assert.ok(plan.targets.flatMap(row=>row.target?.holderKeys??[]).includes(`discussion:${f.a.discussion}`));
 const done=await f.deletion.advance({ownerId:owner,operationId:plan.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
 let state=await f.state();const call=state.calls.find(row=>row.id===f.a.call),operation=state.operations.find(row=>row.id===f.a.operation);
 assert.ok(call);assert.equal(call.reply_attempt_id,null);assert.equal(call.reply_context_id,null);assert.equal(operation.state,'sealed');assert.equal(operation.reply_request_id,null);assert.ok(operation.commit_forbidden_at!==null);
 assert.ok(state.scopes.some(row=>row.operation_id===operation.id&&row.source_contact_id===f.a.contact));assert.ok(!state.events.includes(f.a.event));assert.ok(!state.requests.includes(f.a.request));assert.ok(!state.contexts.includes(f.a.context));
 assert.ok(state.events.includes(f.b.event));assert.ok(state.requests.includes(f.b.request));
 const contact=await f.deletion.plan({ownerId:owner,requestKey:'reply-contact',scope:{kind:'contact',contactId:f.a.contact}});assert.ok(contact.targets.some(row=>row.target?.rowKind==='model_call'&&row.target.key.id===f.a.call));assert.equal((await f.deletion.advance({ownerId:owner,operationId:contact.operationId})).state,'completed');
 state=await f.state();assert.ok(!state.calls.some(row=>row.id===f.a.call));assert.ok(state.calls.some(row=>row.id===f.b.call));
 const account=await f.deletion.plan({ownerId:owner,requestKey:'reply-account',scope:{kind:'account'}});assert.equal((await f.deletion.advance({ownerId:owner,operationId:account.operationId})).state,'completed');
 state=await f.state();assert.equal(state.calls.length,0);assert.equal(state.events.length,0);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('精确讨论删除清共享执行并保留同联系人的独立记忆任务',async t=>{
 const f=await seeded(t);const plan=await f.deletion.plan({ownerId:owner,requestKey:'reply-discussion',scope:{kind:'discussion',contactId:f.a.contact,discussionId:f.a.discussion}});
 assert.ok(plan.targets.some(row=>row.target?.domain==='discussion_calls'&&row.target.rowKind==='model_call'&&row.target.key.id===f.a.call));
 assert.ok(!plan.targets.some(row=>row.target?.rowKind==='model_call'&&row.target.key.id===f.m.call));
 const done=await f.deletion.advance({ownerId:owner,operationId:plan.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
 const state=await f.state();assert.ok(state.tasks.includes(f.m.task));assert.ok(state.events.includes(f.m.event));assert.ok(state.events.includes(f.b.event));assert.ok(!state.events.includes(f.a.event));assert.ok(!state.requests.includes(f.a.request));assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
