import test from 'node:test';
import assert from 'node:assert/strict';
import {deletionFixture} from './fixtures/memory-documents/deletion-support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';

async function failed(t,stage='scene'){
 let reject=true;
 const f=await deletionFixture(t,{twoContacts:true,laterScheduling:true,documentResponse:async({request,payload})=>{
  const names=request.tools.map(tool=>tool.name);
  if(reject&&stage==='scene'&&names.includes('ScenarioVerificationOutput'))return {blocks:[{type:'tool-call',id:'synthetic-scene-rejection',name:'ScenarioVerificationOutput',arguments:JSON.stringify({results:payload.proposal.scenarios.flatMap((scene,scenario_index)=>scene.paragraphs.map((_,paragraph_index)=>({scenario_index,paragraph_index,supported:false,evidence:[]})))})}]};
  if(reject&&stage==='profile'&&names.includes('ProfileVerificationOutput'))return {blocks:[{type:'tool-call',id:'synthetic-profile-rejection',name:'ProfileVerificationOutput',arguments:JSON.stringify({results:'synthetic-invalid'})}]};
 }});
 const run=await f.extraction.start('contact-document-known-retry-'+stage);await f.extraction.waitForIdle(run.runId);
 const task=(await f.extraction.read(run.runId)).tasks.find(item=>item.contactId===f.contactId);
 await f.documents.publishRun(run.runId,f.contactId);
 return {...f,runId:run.runId,taskId:task.taskId,allow(){reject=false;},history:()=>f.storage.execute('fixture.documentRetryHistory',{ownerId:f.owner,taskId:task.taskId})};
}

for(const stage of ['scene','profile'])test(`显式单联系人恢复已知${stage}失败并完成发布，保留旧调用且不改变其他范围`,async t=>{
 const f=await failed(t,stage),before=await f.history();
 assert.ok(before.steps.some(step=>step.kind==='document_'+stage&&step.state==='failed'));
 assert.ok(before.calls.length&&before.calls.every(call=>call.state==='succeeded'&&call.settlement_state==='settled'));
 const scopes=[{scopeKind:'contact',contactId:f.otherContactId},{scopeKind:'self',contactId:null}];
 const untouched=await Promise.all(scopes.map(scope=>f.documents.readSchedule(scope))),version=(await f.extraction.read(f.runId)).controlVersion;
 f.allow();await f.documents.publishRun(f.runId,f.contactId);assert.deepEqual(await f.history(),before,'默认重跑不隐式重发已知失败');
 const calls=f.calls.length;await f.documents.publishRun(f.runId,f.contactId,{retryKnownFailures:true});
 const after=await f.history(),view=await f.documents.read({scopeKind:'contact',contactId:f.contactId});
 assert.equal((await f.documents.readTask(f.taskId)).outcome,'completed');assert.equal(view.status,'completed');
 assert.deepEqual(view.documents.map(document=>document.kind).sort(),['profile','scene']);
 assert.deepEqual(after.calls.slice(0,before.calls.length),before.calls);assert.deepEqual(after.attempts.slice(0,before.attempts.length),before.attempts);
 assert.ok(after.steps.some(step=>step.kind==='document_'+stage&&step.state==='failed'),'保留旧步骤失败事实');
 assert.ok(f.calls.slice(calls).every(call=>call.input.scope.contact_id===f.contactId));
 if(stage==='profile')assert.ok(f.calls.slice(calls).every(call=>call.input.claim.step_name==='document_profile'),'主题成功后不重新整理主题');
 assert.deepEqual(await Promise.all(scopes.map(scope=>f.documents.readSchedule(scope))),untouched);
 assert.equal((await f.extraction.read(f.runId)).controlVersion,version);
 assert.equal((await f.extraction.readContact(f.contactId)).run.laterStages,'completed');
 await assert.rejects(f.documents.publishRun(f.runId,undefined,{retryKnownFailures:true}),{code:'document_scope_invalid'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const fault of ['unknown','unsettled','sealed','paused','source','revision'])test(`显式文档重试不绕过${fault}且不改写历史`,async t=>{
 const f=await failed(t);f.allow();
 if(fault==='source'){
  const binding=f.saved.find(item=>item.contact_id===f.contactId);await f.contacts.revoke(binding.contact_id,binding.binding_id,binding.selection_generation);
 }else if(fault==='revision'){
  const management=new SqliteMemoryManagement(f.storage,f.owner),memory=(await management.read({scopeKind:'contact',contactId:f.contactId})).memories[0];
  await management.decide({requestKey:'retry-source-revision',action:'correct',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body:'合成修正后的长期偏好。'});
 }else await f.storage.execute('fixture.documentRetryFault',{ownerId:f.owner,taskId:f.taskId,fault});
 const before=await f.history(),calls=f.calls.length;
 await f.documents.publishRun(f.runId,f.contactId,{retryKnownFailures:true});
 assert.equal(f.calls.length,calls);assert.deepEqual(await f.history(),before,'失效范围不能新建步骤或改写原调用');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
