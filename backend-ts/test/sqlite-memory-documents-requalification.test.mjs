import test from 'node:test';
import assert from 'node:assert/strict';
import {unknownFixture} from './fixtures/memory-documents/unknown-support.mjs';

for(const action of ['protect','correct'])test(`用户${action}使旧文档失效后，新一轮以旧CAS基线重新发布合法集合`,{timeout:20000},async t=>{
 let phase='first',onFirstNewCall;const requests=[];
 const f=await unknownFixture(t,{unknownScope:'none',beforeCall:async({request,input})=>{
  if(input.scope.contact_id!==f.a)return;
  const payload=JSON.parse(request.messages[0].content[0].text);requests.push({phase,stage:input.claim.step_name,payload});
  if(phase==='second'&&!onFirstNewCall)onFirstNewCall={basis:(await f.documents.readTask(input.claim.task_id)).basis,revision:await f.storage.execute('fixture.scopeRevision',{ownerId:f.owner,contactId:f.a})};
 }});
 const scope={scopeKind:'contact',contactId:f.a};
 await f.add(f.a,[f.record('1',{text:'我长期喜欢合成园艺。'})]);
 const first=await f.extraction.start(`requalification-first-${action}`);await f.extraction.waitForIdle(first.runId);
 const old=await f.documents.read(scope),firstCalls=requests.length,oldBase=await f.storage.execute('fixture.scopeRevision',{ownerId:f.owner,contactId:f.a});
 assert.equal(old.documents.length,2);assert.ok(old.publication);assert.equal(oldBase.current_publication_id,old.publication.id);
 const memory=(await f.management.read(scope)).memories.find(item=>item.current?.body==='联系人长期喜欢合成园艺。');
 assert.ok(memory);assert.equal(memory.current.versionNo,'1');
 await f.management.decide({requestKey:`requalification-${action}`,action,memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,...(action==='correct'?{body:'联系人长期喜欢合成园艺与温室。'}:{})});
 const revised=(await f.management.read(scope)).memories.find(item=>item.id===memory.id);
 assert.notEqual(revised.headRevision,memory.headRevision);assert.equal(action==='protect'?revised.manualProtection:revised.current.versionNo==='2',true);
 const unavailable=await f.documents.read(scope),afterDecision=await f.storage.execute('fixture.scopeRevision',{ownerId:f.owner,contactId:f.a});
 assert.equal(unavailable.publication,null);assert.deepEqual(unavailable.documents,[]);assert.equal(unavailable.status,'needs_revalidation');
 assert.equal(afterDecision.current_publication_id,old.publication.id,'旧发布仍是下一轮乐观并发基线');assert.equal(afterDecision.document_revision,oldBase.document_revision);
 assert.equal(requests.length,firstCalls,'用户决定和读取不能自动触发模型整理');
 await f.add(f.a,[f.record('2',{text:'我长期喜欢合成烘焙。'})]);assert.equal(requests.length,firstCalls,'同步新文字不自动触发模型整理');
 phase='second';const second=await f.extraction.start(`requalification-second-${action}`);await f.extraction.waitForIdle(second.runId);
 const run=await f.extraction.read(second.runId),task=run.tasks.find(item=>item.contactId===f.a),state=await f.documents.readTask(task.taskId);
 assert.equal(task.state,'succeeded','本轮07提取和08核验必须先成功');
 const memories=(await f.management.read(scope)).memories;assert.ok(memories.some(item=>item.current?.body==='联系人长期喜欢合成烘焙。'),'本轮存在合法新正式记忆');
 assert.equal(state.outcome,'completed',JSON.stringify(state));
 assert.equal(state.basis.publicationId,old.publication.id,'本轮CAS基线必须保留旧发布身份');
 assert.equal(onFirstNewCall.basis.publicationId,old.publication.id);assert.equal(onFirstNewCall.revision.current_publication_id,old.publication.id,'提交前不能提前切换发布指针');
 const nextCalls=requests.filter(item=>item.phase==='second'),scene=nextCalls.find(item=>item.stage==='document_scene'&&item.payload.layer==='l2'),profile=nextCalls.find(item=>item.stage==='document_profile'&&item.payload.layer==='l3');
 assert.ok(scene&&profile);assert.deepEqual(scene.payload.documents,[],'失效的旧主题不能进入新一轮模型上下文');assert.equal(profile.payload.existing_profile,null,'失效的旧画像不能进入新一轮模型上下文');
 const current=await f.documents.read(scope);assert.equal(current.documents.length,2);assert.equal(current.status,'completed');assert.notEqual(current.publication.id,old.publication.id);
 const priorMembers=new Set(old.publication.members.map(item=>`${item.documentId}:${item.versionNo}`));
 assert.ok(current.publication.members.every(item=>!priorMembers.has(`${item.documentId}:${item.versionNo}`)),'失效旧成员不能进入新发布集合');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const [kind,errorCode] of [['member','document_publication_incomplete'],['basis','document_basis_missing'],['event_source','document_input_incomplete']])test(`旧发布同时过期且${kind}受损时拒绝新一轮重建`,{timeout:20000},async t=>{
 const f=await unknownFixture(t,{unknownScope:'none'}),scope={scopeKind:'contact',contactId:f.a};
 await f.add(f.a,[f.record('1',{text:'我长期喜欢合成园艺。'})]);const first=await f.extraction.start(`corrupt-first-${kind}`);await f.extraction.waitForIdle(first.runId);
 const old=await f.documents.read(scope),memory=(await f.management.read(scope)).memories[0];assert.equal(old.documents.length,2);
 await f.management.decide({requestKey:`corrupt-protect-${kind}`,action:'protect',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision});
 await f.storage.execute('fixture.corruptPublication',{ownerId:f.owner,publicationId:old.publication.id,kind});const firstCalls=f.calls.length;
 await f.add(f.a,[f.record('2',{text:'我长期喜欢合成烘焙。'})]);const second=await f.extraction.start(`corrupt-second-${kind}`);await f.extraction.waitForIdle(second.runId);
 const task=(await f.extraction.read(second.runId)).tasks.find(item=>item.contactId===f.a),state=await f.documents.readTask(task.taskId);
 assert.equal(state.outcome,'incomplete');assert.equal(state.errorCode,errorCode,JSON.stringify(state));assert.equal(f.calls.length,firstCalls,'发布图结构受损时不能触发后续模型调用');
 assert.equal((await f.storage.execute('fixture.scopeRevision',{ownerId:f.owner,contactId:f.a})).current_publication_id,old.publication.id);
});

test('旧依据自然到期后旧集合撤下，下一轮保留CAS并只用未到期记忆',{timeout:20000},async t=>{
 const expiry=new Date(Date.now()+60000).toISOString(),calls=[];let phase='first';
 const f=await unknownFixture(t,{unknownScope:'none',mutateExtraction:fact=>{if(fact.text.includes('合成园艺'))fact.invalid_at=expiry;},beforeCall:async({input,request})=>{if(input.scope.contact_id===f.a)calls.push({phase,stage:input.claim.step_name,payload:JSON.parse(request.messages[0].content[0].text)});}}),scope={scopeKind:'contact',contactId:f.a};
 await f.add(f.a,[f.record('1',{text:`我长期喜欢合成园艺，有效至${expiry}。`})]);
 const first=await f.extraction.start('time-first');await f.extraction.waitForIdle(first.runId);
 const old=await f.documents.read(scope),count=calls.length;assert.equal(old.documents.length,2);assert.ok(old.publication);
 await f.storage.execute('fixture.advanceClock',{milliseconds:90000});
 const expired=await f.documents.read(scope);assert.equal(expired.publication,null);assert.deepEqual(expired.documents,[]);assert.equal(expired.status,'needs_revalidation');
 assert.equal((await f.storage.execute('fixture.scopeRevision',{ownerId:f.owner,contactId:f.a})).current_publication_id,old.publication.id);assert.equal(calls.length,count,'时间经过不能自动整理');
 await f.add(f.a,[f.record('2',{text:'我长期喜欢合成烘焙。'})]);phase='second';const second=await f.extraction.start('time-second');await f.extraction.waitForIdle(second.runId);
 const task=(await f.extraction.read(second.runId)).tasks.find(item=>item.contactId===f.a),state=await f.documents.readTask(task.taskId);
 assert.equal(state.outcome,'completed',JSON.stringify(state));assert.equal(state.basis.publicationId,old.publication.id);
 const scene=calls.find(item=>item.phase==='second'&&item.stage==='document_scene'&&item.payload.layer==='l2');assert.ok(scene);assert.deepEqual(scene.payload.documents,[]);
 assert.ok(scene.payload.memories.some(item=>item.text.includes('合成烘焙')));assert.ok(scene.payload.memories.every(item=>!item.text.includes('合成园艺')),'已到期记忆不能进入模型');
 const current=await f.documents.read(scope);assert.equal(current.documents.length,2);assert.notEqual(current.publication.id,old.publication.id);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('旧成员时间事实损坏不能伪装为自然到期而跳过',{timeout:20000},async t=>{
 const f=await unknownFixture(t,{unknownScope:'none'}),scope={scopeKind:'contact',contactId:f.a};
 await f.add(f.a,[f.record('1',{text:'我长期喜欢合成园艺。'})]);const run=await f.extraction.start('time-corrupt');await f.extraction.waitForIdle(run.runId);
 const old=await f.documents.read(scope),memory=(await f.management.read(scope)).memories[0],task=(await f.extraction.read(run.runId)).tasks.find(item=>item.contactId===f.a);
 assert.equal(old.documents.length,2);await f.storage.execute('fixture.corruptTime',{ownerId:f.owner,memoryId:memory.id});
 await assert.rejects(f.storage.execute('fixture.inspectPrior',{ownerId:f.owner,publicationId:old.publication.id,contactId:f.a,taskId:task.taskId}),{code:'document_time_invalid'});
 const after=await f.documents.read(scope);assert.equal(after.publication,null);assert.deepEqual(after.documents,[]);
 assert.equal((await f.storage.execute('fixture.scopeRevision',{ownerId:f.owner,contactId:f.a})).current_publication_id,old.publication.id);
});

test('首次处理的当前记忆时间损坏不能伪装为无资料而发布空集合',{timeout:20000},async t=>{
 let changed=false;
 const f=await unknownFixture(t,{unknownScope:'none',beforeDocuments:async()=>{
  if(changed)return;changed=true;
  const memory=(await f.management.read({scopeKind:'contact',contactId:f.a})).memories[0];assert.ok(memory);
  await f.storage.execute('fixture.corruptTime',{ownerId:f.owner,memoryId:memory.id});
 }}),scope={scopeKind:'contact',contactId:f.a};
 await f.add(f.a,[f.record('1',{text:'我长期喜欢合成园艺。'})]);const run=await f.extraction.start('time-corrupt-first');await f.extraction.waitForIdle(run.runId);
 const task=(await f.extraction.read(run.runId)).tasks.find(item=>item.contactId===f.a),state=await f.documents.readTask(task.taskId);
 assert.equal(state.outcome,'incomplete',JSON.stringify(state));assert.equal(state.errorCode,'document_time_invalid');
 assert.equal((await f.documents.read(scope)).publication,null);assert.equal((await f.storage.execute('fixture.scopeRevision',{ownerId:f.owner,contactId:f.a})).current_publication_id,null);
 assert.equal(f.calls.length,0);
});
