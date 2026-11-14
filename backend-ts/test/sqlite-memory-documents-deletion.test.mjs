import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {deletionFixture} from './fixtures/memory-documents/deletion-support.mjs';

test('来源删除立即撤下发布集合并清除文档正文与实际输入追踪',async t=>{
 const f=await deletionFixture(t),scope={scopeKind:'contact',contactId:f.contactId};
 assert.equal((await f.documents.read(scope)).status,'idle','从未发布时应显示尚无资料');
 const run=await f.extraction.start('document-source-deletion');await f.extraction.waitForIdle();
 const before=await f.documents.read(scope);assert.equal(before.documents.length,2);
 const cursorBefore=await f.storage.execute('fixture.documentLaterCursor',{ownerId:f.owner,scopeKey:f.contactId});assert.ok(cursorBefore.last_profile_success_at>0);
 const sourceId=f.message.sourceRecordIds[0];
 const plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactId,sourceId}});
 assert.equal((await f.documents.read(scope)).publication,null);
 const result=await f.deletion.advance({ownerId:f.owner,operationId:plan.operationId});
 assert.equal(result.state,'completed',JSON.stringify(result.checks));
 const after=await f.documents.read(scope);assert.deepEqual(after.documents,[]);
 const queued=await f.documents.readSchedule(scope),cursorAfter=await f.storage.execute('fixture.documentLaterCursor',{ownerId:f.owner,scopeKey:f.contactId});
 assert.equal(queued.scene.state,'scheduled','来源失效后仍保留同事务排入的L2重整');
 assert.equal(cursorAfter.scene_body_digest,null);assert.equal(cursorAfter.profile_scene_body_digest,null);
 assert.equal(cursorAfter.last_profile_success_at,cursorBefore.last_profile_success_at,'来源删除不重置画像24小时频率基线');
 assert.equal(after.status,'needs_revalidation','来源删除后不是从未发布，页面须提示等待重新核验');
 const proof=await f.storage.execute('fixture.documentErasure',{ownerId:f.owner,text:'合成园艺'});
 assert.deepEqual(proof,{statements:0n,versions:0n,blocks:0n,events:0n,references:0n});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('合成删除等待超时')),5000);})]);}finally{clearTimeout(timer);}}

test('来源删除排空在途文档调用，迟到结果不能发布或恢复正文',async t=>{
 const entered=deferred(),aborted=deferred(),release=deferred();let invocation;t.after(()=>release.resolve());
 const f=await deletionFixture(t,{beforeCall:async({input,calls})=>{
  if(calls.length!==1)return;invocation=input;entered.resolve();
  await Promise.race([new Promise(resolve=>{if(input.signal.aborted)resolve();else input.signal.addEventListener('abort',resolve,{once:true});}),release.promise]);
  if(input.signal.aborted)aborted.resolve();await release.promise;throw Error('合成供应商已发送，回执未知');
 }});
 const run=await f.extraction.start('document-source-in-flight');await bounded(entered.promise);
 const old=await f.storage.execute('fixture.documentAttempt',{ownerId:f.owner,stepId:invocation.claim.step_id,callId:invocation.attemptId});
 assert.equal(old.attempt.state,'running');assert.equal(old.call.state,'sending');
 const plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactId,sourceId:f.message.sourceRecordIds[0]}});
 let completed=false;const deletion=f.deletion.advance({ownerId:f.owner,operationId:plan.operationId}).then(result=>{completed=true;return result;});
 await bounded(aborted.promise);assert.equal(completed,false,'删除须等待供应商及处理者真实排空');
 release.resolve();await bounded(f.extraction.waitForIdle(run.runId));const result=await bounded(deletion);
 assert.equal(result.state,'completed',JSON.stringify(result.checks));
 const retained=await f.storage.execute('fixture.documentAttempt',{ownerId:f.owner,stepId:invocation.claim.step_id,callId:old.call.id});
 assert.equal(retained.attempt,null);assert.equal(retained.call.state,'unknown');assert.equal(retained.call.settlement_state,'unknown');assert.equal(retained.call.step_attempt_id,null);
 assert.equal(JSON.parse(retained.call.receipt).input_budget,undefined);assert.equal(retained.operation.state,'sealed');assert.equal(retained.operation.memory_step_id,null);assert.ok(retained.operation.commit_forbidden_at!==null);assert.equal(retained.operation.input_seal,'deleted');assert.ok(retained.occupations.every(item=>item.state==='unknown'));
 await assert.rejects(f.storage.execute('memoryDocuments.output',{ownerId:f.owner,attemptId:old.attempt.id,callId:old.call.id,blocks:[{type:'tool-call',name:'write',arguments:'{}'}]}),{code:'document_attempt_stale'});
 assert.deepEqual((await f.documents.read({scopeKind:'contact',contactId:f.contactId})).documents,[]);
 assert.deepEqual(await f.storage.execute('fixture.documentErasure',{ownerId:f.owner,text:'合成园艺'}),{statements:0n,versions:0n,blocks:0n,events:0n,references:0n});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 const contactPlan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'contact',contactId:f.contactId}});
 assert.ok(contactPlan.targets.some(item=>item.target?.domain==='memory_extraction'&&item.target.rowKind==='model_call'&&item.target.key.id===old.call.id),'整联系人删除须找回先前封存的未知调用');
 const contactDone=await f.deletion.advance({ownerId:f.owner,operationId:contactPlan.operationId});assert.equal(contactDone.state,'completed',JSON.stringify(contactDone.checks));
 const removed=await f.storage.execute('fixture.documentAttempt',{ownerId:f.owner,stepId:invocation.claim.step_id,callId:old.call.id});assert.equal(removed.call,null);assert.equal(removed.operation,null);assert.deepEqual(removed.occupations,[]);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('本人混合资料删除一位实际来源后撤下完整集合，另一联系人独立文档保持可用',async t=>{
 const f=await deletionFixture(t,{twoContacts:true}),run=await f.extraction.start('document-mixed-owner');await f.extraction.waitForIdle(run.runId);
 const self={scopeKind:'self',contactId:null},other={scopeKind:'contact',contactId:f.otherContactId};
 const ownerBefore=await f.documents.read(self),otherBefore=await f.documents.read(other);
 assert.equal(ownerBefore.documents.length,2);assert.equal(otherBefore.documents.length,2);
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});t.after(()=>db.close());
 const audit=()=>db.prepare("SELECT e.* FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task task ON task.owner_id=s.owner_id AND task.id=s.task_id WHERE e.owner_id=? AND task.scope_kind='contact' AND task.contact_id=? ORDER BY e.id").all(f.owner,f.otherContactId),otherAudit=audit();
 assert.ok(otherAudit.length>0,'独立联系人须确实存在需要保留的执行审计');
 assert.ok(db.prepare("SELECT 1 FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task task ON task.owner_id=s.owner_id AND task.id=s.task_id WHERE e.owner_id=? AND task.scope_kind='self' AND e.kind='adjudication_lease_progress' AND NOT EXISTS(SELECT 1 FROM execution_input x WHERE x.owner_id=e.owner_id AND x.event_id=e.id) LIMIT 1").get(f.owner),'覆盖已有无输入边的续期控制事件，不能要求重写旧审计');
 const plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactId,sourceId:f.ownerMessage.sourceRecordIds[0]}});
 const done=await f.deletion.advance({ownerId:f.owner,operationId:plan.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
 assert.deepEqual((await f.documents.read(self)).documents,[]);
 assert.deepEqual(await f.documents.read(other),otherBefore,'独立B的合法发布和正文不能被删除');
 assert.deepEqual(audit(),otherAudit,'无关联系人的执行审计须逐字节保持');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('删除联系人清除该范围文档与本人相关派生，保留另一联系人资料',async t=>{
 const f=await deletionFixture(t,{twoContacts:true}),run=await f.extraction.start('document-contact-delete');await f.extraction.waitForIdle(run.runId);
 const self={scopeKind:'self',contactId:null},other={scopeKind:'contact',contactId:f.otherContactId},prior=await f.documents.read(other);assert.equal(prior.documents.length,2);
 const plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'contact',contactId:f.contactId}});
 const done=await f.deletion.advance({ownerId:f.owner,operationId:plan.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
 assert.deepEqual((await f.documents.read(self)).documents,[]);assert.deepEqual(await f.documents.read(other),prior);
 await assert.rejects(f.documents.read({scopeKind:'contact',contactId:f.contactId}),{code:'memory_scope_stale'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('删除账户清除所有范围的文档和真实输入追踪',async t=>{
 const f=await deletionFixture(t,{twoContacts:true}),run=await f.extraction.start('document-account-delete');await f.extraction.waitForIdle(run.runId);
 assert.equal((await f.documents.read({scopeKind:'self',contactId:null})).documents.length,2);
 const plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'account'}});
 const done=await f.deletion.advance({ownerId:f.owner,operationId:plan.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
 const proof=await f.storage.execute('fixture.documentErasure',{ownerId:f.owner,text:'合成园艺'});assert.deepEqual(proof,{statements:0n,versions:0n,blocks:0n,events:0n,references:0n});
 assert.equal(await f.storage.execute('fixture.documentIdentityCount',{ownerId:f.owner}),0n,'账户删除必须清除无正文基线身份');
 await assert.rejects(f.documents.read({scopeKind:'self',contactId:null}),{code:'memory_scope_stale'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('同一消息的不同可信物理出现保持独立，不能替换旧证明',async t=>{
 async function prepared(sub){
  const f=await deletionFixture(sub,{twoCaptures:true}),run=await f.extraction.start('document-source-exact');await f.extraction.waitForIdle(run.runId);
  const scope={scopeKind:'contact',contactId:f.contactId},before=await f.documents.read(scope);assert.equal(before.documents.length,2);
  const sources=f.message.sourceRecordIds;assert.equal(sources.length,2);
  const selected=(await f.extraction.read(run.runId)).inputs.find(input=>input.messageId===f.message.id).recordId;
  return {f,scope,before,selected,unused:sources.find(id=>id!==selected)};
 }
 await t.test('删除未使用的 record 不影响旧文档',async sub=>{
  const {f,scope,before,unused}=await prepared(sub);
  const op=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactId,sourceId:unused}});
  const done=await f.deletion.advance({ownerId:f.owner,operationId:op.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
  assert.deepEqual(await f.documents.read(scope),before);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 });
 await t.test('实际 record 被删时其他合法来源仍在，但旧文档不得改指',async sub=>{
  const {f,scope,selected,unused}=await prepared(sub);
  const op=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactId,sourceId:selected}});
  const done=await f.deletion.advance({ownerId:f.owner,operationId:op.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
  const retained=(await f.service.read(f.contactId)).messages.find(item=>item.id===f.message.id);assert.deepEqual(retained.sourceRecordIds,[unused]);
  assert.deepEqual((await f.documents.read(scope)).documents,[]);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 });
});

test('画像阶段在途时按同任务初始持有者排空，主题草稿与画像输入均随来源清除',async t=>{
 const entered=deferred(),aborted=deferred(),release=deferred();let invocation;t.after(()=>release.resolve());
 const f=await deletionFixture(t,{beforeCall:async({input})=>{
  if(input.claim.step_name!=='document_profile'||invocation)return;invocation=input;entered.resolve();
  await Promise.race([new Promise(resolve=>{if(input.signal.aborted)resolve();else input.signal.addEventListener('abort',resolve,{once:true});}),release.promise]);
  if(input.signal.aborted)aborted.resolve();await release.promise;throw Error('合成画像调用未知');
 }});
 const run=await f.extraction.start('document-profile-in-flight');await bounded(entered.promise);
 const plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactId,sourceId:f.message.sourceRecordIds[0]}});
 const pending=f.deletion.advance({ownerId:f.owner,operationId:plan.operationId});await bounded(aborted.promise);release.resolve();
 await bounded(f.extraction.waitForIdle(run.runId));const done=await bounded(pending);assert.equal(done.state,'completed',JSON.stringify(done.checks));
 assert.deepEqual((await f.documents.read({scopeKind:'contact',contactId:f.contactId})).documents,[]);
 assert.deepEqual(await f.storage.execute('fixture.documentErasure',{ownerId:f.owner,text:'合成园艺'}),{statements:0n,versions:0n,blocks:0n,events:0n,references:0n});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('删除来源释放零成员发布及不适用阶段的父引用',async t=>{
 const f=await deletionFixture(t,{noMemory:true}),run=await f.extraction.start('document-empty-delete');await f.extraction.waitForIdle(run.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},before=await f.documents.read(scope);assert.equal(before.publication.members.length,0);
 const plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactId,sourceId:f.message.sourceRecordIds[0]}});
 const done=await f.deletion.advance({ownerId:f.owner,operationId:plan.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
 assert.equal((await f.documents.read(scope)).publication,null);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('删除旧来源会穿过后续版本与发布基线，清除跨轮继承的正文',async t=>{
 const {record}=await import('./fixtures/memory-sqlite/support.mjs');
 const f=await deletionFixture(t),first=await f.extraction.start('document-old-round');await f.extraction.waitForIdle(first.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},old=await f.documents.read(scope);assert.equal(old.documents.length,2);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期喜欢合成园艺。'}),record('2',{text:'我长期喜欢合成象棋。',sentAt:'1700000001000'})],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);await f.contacts.setReading(false);
 const second=await f.extraction.start('document-later-round');await f.extraction.waitForIdle(second.runId);
 const task=(await f.extraction.read(second.runId)).tasks.find(item=>item.contactId===f.contactId),state=await f.documents.readTask(task.taskId),current=await f.documents.read(scope);
 assert.equal(state.outcome,'completed',JSON.stringify(state));assert.notEqual(current.publication.id,old.publication.id);
 const op=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactId,sourceId:f.message.sourceRecordIds[0]}});
 const done=await f.deletion.advance({ownerId:f.owner,operationId:op.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
 assert.deepEqual((await f.documents.read(scope)).documents,[]);
 assert.deepEqual(await f.storage.execute('fixture.documentErasure',{ownerId:f.owner,text:'合成园艺'}),{statements:0n,versions:0n,blocks:0n,events:0n,references:0n});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('本人在途任务固定贡献含B即使模型只读A，删除B仍须排空且保留A独立资料',async t=>{
 const entered=deferred(),aborted=deferred(),release=deferred();let invocation;t.after(()=>release.resolve());
 const f=await deletionFixture(t,{twoContacts:true,ownerB:false,beforeCall:async({input})=>{
  if(input.scope.contact_id!==null||invocation)return;invocation=input;entered.resolve();
  await Promise.race([new Promise(resolve=>{if(input.signal.aborted)resolve();else input.signal.addEventListener('abort',resolve,{once:true});}),release.promise]);
  if(input.signal.aborted)aborted.resolve();await release.promise;throw Error('合成本人调用未知');
 }});
 const run=await f.extraction.start('document-owner-mixed-in-flight');await bounded(entered.promise);
 const aScope={scopeKind:'contact',contactId:f.contactId},aBefore=await f.documents.read(aScope);assert.equal(aBefore.documents.length,2);
 const inputs=await f.storage.execute('fixture.documentInputs',{ownerId:f.owner,stepId:invocation.claim.step_id});
 assert.ok(inputs.length);assert.ok(inputs.every(row=>row.source_contact_id===f.contactId),'模型实际记忆输入只依赖A');
 const sourceId=f.otherMessages.find(message=>message.kind==='text').sourceRecordIds[0];
 const plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.otherContactId,sourceId}});
 let finished=false;const deleting=f.deletion.advance({ownerId:f.owner,operationId:plan.operationId}).then(result=>{finished=true;return result;});
 await bounded(aborted.promise);assert.equal(finished,false,'B是任务固定贡献，须等待在途调用排空');release.resolve();
 await bounded(f.extraction.waitForIdle(run.runId));const done=await bounded(deleting);assert.equal(done.state,'completed',JSON.stringify(done.checks));
 assert.deepEqual((await f.documents.read({scopeKind:'self',contactId:null})).documents,[]);
 assert.deepEqual(await f.documents.read(aScope),aBefore);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('缺失09删除处理器时不能把空闭包误判为完成',async t=>{
 const {fixture,owner}=await import('./fixtures/memory-sqlite/support.mjs');
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts');
 const {ActiveHolders}=await import('../src/storage/sqlite/deletion/holders.ts');
 const {ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const registryModule=new URL('./fixtures/memory-documents/missing-domain-registry.mjs',import.meta.url).href;
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);
 const sourceId=(await f.service.read(contactId)).messages.find(m=>m.kind==='text').sourceRecordIds[0];
 const deletion=new DeletionService(f.storage,new ActiveHolders(),new ManagedFiles(f.root));
 await assert.rejects(deletion.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'source',contactId,sourceId}}),{code:'deletion_domain_unavailable'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('场景提案实际看到旧主题目录，独立核验调用不伪记旧文档或原始消息',async t=>{
 const {record}=await import('./fixtures/memory-sqlite/support.mjs');
 const f=await deletionFixture(t),first=await f.extraction.start('document-actual-input-first');await f.extraction.waitForIdle(first.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},old=await f.documents.read(scope);assert.equal(old.documents.length,2);
 const oldScene=old.documents.find(item=>item.kind==='scene');assert.ok(oldScene);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期喜欢合成园艺。'}),record('2',{text:'我长期喜欢合成象棋。',sentAt:'1700000001000'})],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);await f.contacts.setReading(false);
 const second=await f.extraction.start('document-actual-input-second');await f.extraction.waitForIdle(second.runId);
 const task=(await f.extraction.read(second.runId)).tasks.find(item=>item.contactId===f.contactId),state=await f.documents.readTask(task.taskId);assert.equal(state.outcome,'completed',JSON.stringify(state));
 const calls=await f.storage.execute('fixture.documentCalls',{ownerId:f.owner,taskId:task.taskId});
 const proposals=calls.filter(event=>event.kind==='document_input'&&event.payload.tools.some(tool=>tool.name==='write'));
 const firstProposal=proposals[0],proposalPayload=JSON.parse(firstProposal.payload.messages[0].content[0].text);
 assert.ok(proposalPayload.documents.some(item=>item.scenario_id===oldScene.id),'提案的目录真实包含旧场景');
 assert.ok(firstProposal.inputs.some(input=>input.kind==='document'&&input.document_id===oldScene.id),'提案须追踪实际看到的旧场景');
 const verification=calls.find(event=>event.kind==='document_input'&&event.payload.tools.some(tool=>tool.name==='ScenarioVerificationOutput'));assert.ok(verification);
 const verificationPayload=JSON.parse(verification.payload.messages[0].content[0].text);
 assert.ok(!JSON.stringify(verificationPayload).includes(oldScene.id),'独立核验未发送旧场景身份或目录');
 assert.ok(verification.inputs.some(input=>input.kind==='memory'),'实际发送的记忆版本须可追踪');
 assert.ok(verification.inputs.every(input=>input.kind!=='document'),'独立核验不能把冻结但未发送的旧场景伪记为实际输入');
 assert.ok(verification.inputs.every(input=>input.kind!=='message'),'记录号仅是记忆的来源资格，不能伪装成发送的原始消息');
 const response=calls.find(event=>event.kind==='document_output'&&event.originated_call_id===verification.originated_call_id);assert.ok(response);
 assert.ok(response.inputs.every(input=>input.kind!=='document'&&input.kind!=='message'),'输出事件须继承该次调用实际输入而非整步冻结输入');
});

test('撤选B后新的本人A集合不因仅冻结旧发布基线而随B来源删除',async t=>{
 const {record}=await import('./fixtures/memory-sqlite/support.mjs');
 const f=await deletionFixture(t,{twoContacts:true,targetOnly:true,orderOwnerA:true,preferText:'白茶'}),self={scopeKind:'self',contactId:null};
 const first=await f.extraction.start('document-owner-mixed-before-revoke');await f.extraction.waitForIdle(first.runId);
 const old=await f.documents.read(self);assert.equal(old.documents.length,2);
 const oldProof=await f.storage.execute('fixture.publicationInputs',{ownerId:f.owner,publicationId:old.publication.id});
 const oldVersions=oldProof.versions.map(version=>({documentId:version.document_id,versionNo:String(version.version_no),attemptId:version.produced_attempt_id}));
 assert.equal(oldVersions.length,2);assert.ok(oldVersions.every(version=>version.attemptId));
 const present=await f.storage.execute('fixture.documentPhysicalVersions',{ownerId:f.owner,versions:oldVersions});
 for(const version of present){assert.equal(version.versions,1n);for(const key of ['blocks','statements','basis','events'])assert.ok(version[key]>0n,`删除前须存在旧版本的${key}`);}
 assert.ok(oldProof.versions.some(v=>v.inputs.some(i=>i.kind==='message'&&i.source_contact_id===f.contactId)));
 assert.ok(oldProof.versions.some(v=>v.inputs.some(i=>i.kind==='message'&&i.source_contact_id===f.otherContactId)),'旧本人文档实际冻结A+B来源');
 const oldCalls=f.calls.filter(call=>call.input.scope.contact_id===null),oldRequests=JSON.stringify(oldCalls.map(call=>call.request.messages));
 assert.match(oldRequests,/白茶/);assert.match(oldRequests,/蓝茶/,'旧本人文档请求真实发送A+B资料');
 const knowledgeScope={ownerId:f.owner,contactId:f.contactId,discussionId:randomUUID()};
 const oldKnowledge=(await f.storage.execute('fixture.documentKnowledge',knowledgeScope)).filter(item=>item.scopeKind==='owner');
 assert.equal(oldKnowledge.length,2);assert.ok(oldKnowledge.every(item=>item.sources.some(source=>source.contactId===f.otherContactId)),'旧版本的实际输入来源包含B');
 const binding=f.saved.find(item=>item.contact_id===f.otherContactId);
 await f.contacts.revoke(f.otherContactId,binding.binding_id,binding.selection_generation);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期喜欢合成园艺。'}),record('2',{sender:'owner',text:'我长期偏好合成白茶。'}),record('3',{sender:'owner',text:'我长期喜欢合成黑茶。',sentAt:'1700000001000'})],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);await f.contacts.setReading(false);
 const priorCalls=f.calls.length,second=await f.extraction.start('document-owner-a-after-revoke');await f.extraction.waitForIdle(second.runId);
 const secondSnapshot=await f.extraction.read(second.runId),selfTask=secondSnapshot.tasks.find(item=>item.scopeKind==='self');
 const state=await f.documents.readTask(selfTask.taskId),fresh=await f.documents.read(self);
 assert.equal(state.outcome,'completed',JSON.stringify(state));assert.equal(fresh.documents.length,2,JSON.stringify({state,status:fresh.status,publication:fresh.publication,selfTask}));assert.notEqual(fresh.publication.id,old.publication.id);
 const proof=await f.storage.execute('fixture.publicationInputs',{ownerId:f.owner,publicationId:fresh.publication.id});
 assert.equal(proof.task.accepted_publication_id,old.publication.id,'旧集合仅作为并发CAS基线');
 assert.ok(proof.versions.every(v=>v.inputs.filter(i=>i.kind==='message').every(i=>i.source_contact_id===f.contactId)),'新版本的实际记忆资格只来自A');
 assert.ok(proof.versions.every(v=>v.inputs.every(i=>i.publication_id!==old.publication.id)),'新版本未读取或继承旧混合集合成员');
 const nextCalls=f.calls.slice(priorCalls).filter(call=>call.input.scope.contact_id===null);assert.ok(nextCalls.length);
 const nextRequests=JSON.stringify(nextCalls.map(call=>call.request.messages));assert.doesNotMatch(nextRequests,/蓝茶/);
 for(const member of old.publication.members)assert.ok(!nextRequests.includes(member.documentId),'新轮实际调用未发送旧混合文档');
 const independent=(await f.storage.execute('fixture.documentKnowledge',knowledgeScope)).filter(item=>item.scopeKind==='owner');
 assert.equal(independent.length,2);assert.ok(independent.every(item=>item.sources.length&&item.sources.every(source=>source.contactId===f.contactId)));
 const sourceId=f.otherMessages.find(message=>message.text==='我长期偏好合成蓝茶。').sourceRecordIds[0];
 const beforeImpact=await f.storage.execute('fixture.sourceImpact',{ownerId:f.owner,contactId:f.otherContactId,sourceId,taskId:selfTask.taskId,operationId:randomUUID()});
 assert.ok(beforeImpact.taskAffected,'同一任务的08裁决须确实受待删来源影响');
 assert.ok(beforeImpact.events.some(event=>event.kind==='adjudication_input'&&event.contains_source_text),'08实际裁决调用应包含B资料');
 const plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.otherContactId,sourceId}});
 const fencedImpact=await f.storage.execute('fixture.sourceImpact',{ownerId:f.owner,contactId:f.otherContactId,sourceId,taskId:selfTask.taskId,operationId:plan.operationId});
 assert.ok(plan.targets.some(item=>item.target?.domain==='memory_documents'&&item.target.rowKind==='document_publication'&&item.target.key.id===old.publication.id),'旧混合集合必须撤销');
 assert.ok(!plan.targets.some(item=>item.target?.domain==='memory_documents'&&item.target.rowKind==='document_publication'&&item.target.key.id===fresh.publication.id),'仅CAS基线不能使A独立集合进入来源删除闭包');
 const done=await f.deletion.advance({ownerId:f.owner,operationId:plan.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
 const after=await f.documents.read(self);
 assert.deepEqual(after.publication,fresh.publication,'A独立集合须保持完整');assert.deepEqual(after.documents,fresh.documents,'A独立版本须保持完整');
 for(const item of independent)assert.equal(await f.storage.execute('fixture.documentCurrent',{scope:knowledgeScope,item}),true,'旧混合来源删除后，A独立版本仍是可引用资料');
 const oldRetained=await f.storage.execute('fixture.publicationInputs',{ownerId:f.owner,publicationId:old.publication.id});
 assert.ok(oldRetained===null||oldRetained.publication.availability!=='available','旧集合必须撤销');
 if(oldRetained)assert.equal(oldRetained.versions.length,0,'已撤销集合不能保留成员');
 const physical=await f.storage.execute('fixture.documentPhysicalVersions',{ownerId:f.owner,versions:oldVersions});
 for(const version of physical)for(const key of ['versions','blocks','statements','basis','events'])assert.equal(version[key],0n,`旧版本 ${version.documentId}:${version.versionNo} 的${key}须物理清除`);
 const identity=await f.storage.execute('fixture.documentIdentityShape',{ownerId:f.owner,publicationId:old.publication.id});
 assert.deepEqual(identity.columns,['owner_id','id']);assert.deepEqual(identity.identity,{owner_id:f.owner,id:old.publication.id},'仅保留新任务并发基线所需的无内容身份');
 const erased=await f.storage.execute('fixture.documentErasure',{ownerId:f.owner,text:'合成蓝茶'});
 for(const key of ['statements','versions','blocks','events'])assert.equal(erased[key],0n,`应清除B来源的${key}`);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 const diagnostics=await f.storage.execute('fixture.documentTaskDiagnostics',{ownerId:f.owner});
 assert.equal(after.status,'completed',JSON.stringify({expectedTask:selfTask.taskId,beforeImpact,fencedImpact,diagnostics}));
 const account=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'account'}});
 assert.equal((await f.deletion.advance(account)).state,'completed');
 assert.equal(await f.storage.execute('fixture.documentIdentityCount',{ownerId:f.owner}),0n,'后续账户删除也要清除仅为冻结基线保留的身份');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
