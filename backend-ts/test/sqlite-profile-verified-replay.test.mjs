import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {profileReplayFixture} from './fixtures/memory-documents/profile-replay-support.mjs';

test('旧L3逐项拒绝结果显式零模型重放，保留原调用与失败尝试',{timeout:20000},async t=>{
 const f=await profileReplayFixture(t),scope={scopeKind:'contact',contactId:f.a};
 const before=await f.documents.readTask(f.taskId);assert.equal(before.errorCode,'document_profile_unverified');
 const oldEffects=await f.storage.execute('fixture.effectScopes',{ownerId:f.owner}),oldCalls=f.modelCalls.length;
 const result=await f.documents.replayVerifiedProfile(f.taskId);assert.equal(result.outcome,'completed',JSON.stringify(result));
 assert.equal(f.modelCalls.length,oldCalls,'重放不能访问物理模型端口');
 assert.deepEqual(await f.storage.execute('fixture.effectScopes',{ownerId:f.owner}),oldEffects,'旧调用、结算、操作与已释放占位保持原样');
 const current=await f.documents.read(scope),profile=current.documents.find(item=>item.kind==='profile');assert.ok(profile);assert.equal(profile.statements.length,1);assert.equal(profile.statements[0].kind,'fact');
 const after=await f.documents.readTask(f.taskId),stage=after.stages.find(item=>item.kind==='profile');assert.equal(stage.status,'succeeded');
 const facts=await f.storage.execute('fixture.profileReplayFacts',{ownerId:f.owner,taskId:f.taskId});
 assert.equal(facts.attempts[0].state,'failed');assert.equal(facts.attempts[0].error_code,'document_profile_unverified');assert.equal(facts.attempts[1].state,'succeeded');
 const original=facts.events.filter(event=>event.attempt_no===1n&&['document_input','document_output'].includes(event.kind));
 const replayed=facts.events.filter(event=>event.attempt_no===2n&&['document_input','document_output'].includes(event.kind));
 assert.equal(replayed.length,original.length);for(let i=0;i<original.length;i++){assert.equal(replayed[i].payload,original[i].payload);assert.equal(replayed[i].originated_call_id,null);assert.equal(replayed[i].reused_call_id,original[i].originated_call_id);}
 const again=await f.documents.replayVerifiedProfile(f.taskId);assert.equal(again.publicationId,after.publicationId);assert.equal(f.modelCalls.length,oldCalls);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('旧L3首次核验坏引文后完整有效的重试回执仍可零模型重放',{timeout:20000},async t=>{
 const f=await profileReplayFixture(t,{retryFirstQuote:true}),scope={scopeKind:'contact',contactId:f.a};
 const before=await f.documents.readTask(f.taskId);assert.equal(before.errorCode,'document_profile_unverified');
 const facts=await f.storage.execute('fixture.profileReplayFacts',{ownerId:f.owner,taskId:f.taskId}),oldCalls=f.modelCalls.length;
 const packets=facts.events.filter(event=>event.kind==='document_output').flatMap(event=>JSON.parse(event.payload).blocks.filter(block=>block.name==='ProfileVerificationOutput').map(block=>JSON.parse(block.arguments)));
 assert.equal(packets.length,2,'正式核验先报告工具错误，再接受第二份完整混合结果');
 assert.equal(packets[0].results[0].evidence[0].quote,'这句合成引文不在任何记忆里。');assert.deepEqual(packets[1].results.map(item=>item.supported),[true,false]);
 const result=await f.documents.replayVerifiedProfile(f.taskId);assert.equal(result.outcome,'completed');
 assert.equal(f.modelCalls.length,oldCalls);assert.deepEqual((await f.documents.read(scope)).profileSelection,{accepted:1,rejected:1,retained:0});
 const after=await f.storage.execute('fixture.profileReplayFacts',{ownerId:f.owner,taskId:f.taskId});
 assert.deepEqual(after.events.filter(event=>event.attempt_no===1n),facts.events,'中间错误和最终有效原包都不得改写');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('旧L3同轮主题合并后按正式替换集合重建核验场景',{timeout:20000},async t=>{
 const f=await profileReplayFixture(t,{initialSceneCount:2,initialOldGuard:false}),scope={scopeKind:'contact',contactId:f.a};
 const initial=await f.documents.read(scope),priorScenes=initial.documents.filter(item=>item.kind==='scene');assert.equal(priorScenes.length,2);
 f.setOldGuard(true);f.setMergeScenes(true);
 await f.add(f.a,[f.record('2',{text:'我周末也喜欢合成园艺。',sentAt:'1700000002000'})]);
 const run=await f.extraction.start('synthetic-profile-replay-merged-scenes');await f.extraction.waitForIdle(run.runId);
 const task=(await f.extraction.read(run.runId)).tasks.find(item=>item.scopeKind==='contact'&&item.contactId===f.a);assert.ok(task);
 const before=await f.documents.readTask(task.taskId);assert.deepEqual(before.stages.map(item=>[item.kind,item.status]),[['scene','succeeded'],['profile','failed']]);assert.equal(before.errorCode,'document_profile_unverified');
 f.setOldGuard(false);const oldCalls=f.modelCalls.length,result=await f.documents.replayVerifiedProfile(task.taskId);assert.equal(result.outcome,'completed');assert.equal(f.modelCalls.length,oldCalls);
 const current=await f.documents.read(scope),scenes=current.documents.filter(item=>item.kind==='scene');assert.equal(scenes.length,1,'合并替换的另一份旧主题不得被补回核验材料');
 assert.ok(priorScenes.some(item=>item.id===scenes[0].id));assert.deepEqual(current.profileSelection,{accepted:1,rejected:1,retained:0});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('旧L3重放逐项拒绝缺失回执、证据与未知占位，事务不留下新尝试',{timeout:30000},async t=>{
 const expected={receipt_missing:'document_replay_receipt_invalid',receipt_json:'document_replay_receipt_invalid',receipt_dispatch:'document_replay_receipt_invalid',receipt_outcome:'document_replay_receipt_invalid',receipt_identity:'document_replay_receipt_invalid',input_seal:'document_input_incomplete',event_source:'document_input_incomplete',execution_input:'document_input_incomplete',scope_missing:'document_scope_stale',ledger_scope_missing:'document_model_scope_incomplete',effect_missing:'document_model_scope_incomplete',call_unknown:'document_model_unknown',commit_forbidden:'document_model_unknown',effect_occupied:'document_model_unknown'};
 for(const [kind,code] of Object.entries(expected))await t.test(kind,async t=>{
  const f=await profileReplayFixture(t);await f.storage.execute('fixture.profileReplayFault',{ownerId:f.owner,taskId:f.taskId,kind});
  const count=f.modelCalls.length,before=await f.storage.execute('fixture.profileReplayFacts',{ownerId:f.owner,taskId:f.taskId});
  await assert.rejects(f.documents.replayVerifiedProfile(f.taskId),error=>error.code===code);
  assert.equal(f.modelCalls.length,count);assert.deepEqual(await f.storage.execute('fixture.profileReplayFacts',{ownerId:f.owner,taskId:f.taskId}),before);
  assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 });
});

test('旧L3来源版本变化或撤权后拒绝重放且不调用模型',{timeout:20000},async t=>{
 for(const kind of ['source_revision','revoke'])await t.test(kind,async t=>{
  const f=await profileReplayFixture(t);
  if(kind==='source_revision')await f.storage.execute('fixture.profileReplayFault',{ownerId:f.owner,taskId:f.taskId,kind});
  else {const binding=f.saved.find(item=>item.contact_id===f.a);await f.contacts.revoke(f.a,binding.binding_id,binding.selection_generation);}
  const count=f.modelCalls.length;await assert.rejects(f.documents.replayVerifiedProfile(f.taskId));
  assert.equal(f.modelCalls.length,count);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 });
});

test('旧L3基础记忆变化后拒绝重放且不调用模型',{timeout:20000},async t=>{
 const f=await profileReplayFixture(t),scope={scopeKind:'contact',contactId:f.a};
 const memory=(await f.management.read(scope)).memories[0];assert.ok(memory);
 await f.management.decide({requestKey:randomUUID(),action:'correct',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body:'联系人长期喜欢合成温室。'});
 const count=f.modelCalls.length;
 await assert.rejects(f.documents.replayVerifiedProfile(f.taskId),error=>['document_publication_conflict','document_memory_stale','document_preceding_stage_incomplete'].includes(error.code));
 assert.equal(f.modelCalls.length,count);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('独立后续L3代数的已知旧失败可本地重放并结清原调度',{timeout:20000},async t=>{
 const f=await profileReplayFixture(t),scope={scopeKind:'contact',contactId:f.a};await f.documents.replayVerifiedProfile(f.taskId);
 f.setOldGuard(true);const memory=(await f.management.read(scope)).memories[0];await f.management.decide({requestKey:randomUUID(),action:'correct',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body:'联系人长期喜欢合成温室。'});
 const scheduled=await f.documents.readSchedule(scope);assert.equal(scheduled.scene.state,'scheduled');
 await f.documents.runDueStages(scheduled.scene.dueAt);
 let failed=await f.documents.readSchedule(scope);if(failed.profile.state==='scheduled'){await f.documents.runDueStages(failed.profile.dueAt);failed=await f.documents.readSchedule(scope);}assert.equal(failed.profile.state,'failed',JSON.stringify(failed));assert.equal(failed.profile.errorCode,'document_profile_unverified');
 const oldEffects=await f.storage.execute('fixture.effectScopes',{ownerId:f.owner}),count=f.modelCalls.length;
 f.setOldGuard(false);const result=await f.documents.replayVerifiedProfile(failed.profile.taskId);assert.equal(result.outcome,'completed');
 assert.equal(f.modelCalls.length,count);assert.deepEqual(await f.storage.execute('fixture.effectScopes',{ownerId:f.owner}),oldEffects);
 const after=await f.documents.readSchedule(scope);assert.equal(after.profile.generation,failed.profile.generation);assert.equal(after.profile.state,'succeeded');
 assert.equal((await f.documents.read(scope)).documents.find(item=>item.kind==='profile').statements.length,1);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('清除原资料后旧L3不可通过重放恢复，删除闭包完整',{timeout:20000},async t=>{
 const f=await profileReplayFixture(t),count=f.modelCalls.length;
 const plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'contact',contactId:f.a}}),done=await f.deletion.advance({ownerId:f.owner,operationId:plan.operationId});assert.equal(done.state,'completed');
 await assert.rejects(f.documents.replayVerifiedProfile(f.taskId));assert.equal(f.modelCalls.length,count);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const paused of [false,true])test(`主题合并后${paused?'暂停再继续':'正常推进'}的画像只使用当前替换集合与真实变更`,{timeout:20000},async t=>{
 let phase='first',firstPayload,profilePayload,runId,pauseRequested=false;const started=Promise.withResolvers();
 const f=await profileReplayFixture(t,{initialSceneCount:2,initialOldGuard:false,beforeDocumentCall:async({request,input,payload,fixture})=>{
  if(input.scope.contact_id!==fixture.a)return;
  if(payload.layer==='l3'&&request.messages.length===1){if(phase==='first')firstPayload=payload;else profilePayload=payload;}
  if(paused&&phase==='second'&&payload.layer==='l2'&&!pauseRequested){
   pauseRequested=true;await started.promise;await fixture.extraction.pause(runId);
  }
 }}),scope={scopeKind:'contact',contactId:f.a};
 assert.equal(firstPayload.scenarios.length,2);f.setMergeScenes(true);
 await f.add(f.a,[f.record('2',{text:'我周末也喜欢合成园艺。',sentAt:'1700000002000'})]);
 phase='second';const run=await f.extraction.start(`document-unified-merge-${paused}`);runId=run.runId;started.resolve();await f.extraction.waitForIdle(runId);
 if(paused){
  assert.ok(pauseRequested);assert.equal(profilePayload,undefined,'暂停边界不启动画像');
  const state=await f.extraction.read(runId);assert.equal(state.state,'paused');
  await f.extraction.continue(runId);await f.extraction.waitForIdle(runId);
 }
 assert.ok(profilePayload,'必须进入真实画像模型入口');
 assert.equal(profilePayload.scenarios.length,1,'被合并替换的旧主题不得在恢复路径重新加入');
 assert.deepEqual(profilePayload.changed_scenario_ids,profilePayload.scenarios.map(scene=>scene.scenario_id));
 assert.deepEqual([...profilePayload.removed_scenario_version_ids].sort(),firstPayload.scenarios.map(scene=>scene.version_id).sort());
 const current=await f.documents.read(scope);assert.equal(current.documents.filter(item=>item.kind==='scene').length,1);assert.ok(current.publication);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
