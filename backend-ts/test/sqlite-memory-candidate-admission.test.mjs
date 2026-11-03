import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {supplier} from './fixtures/memory-management/supplier.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';

async function prepared(t,{legacy=false,partialQuote=false,archive=false,modernNonreviewable=false,reuse=false,timeline=false}={}){
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-management/admission-registry.mjs',import.meta.url).href}),contactId=f.saved[0].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:legacy||modernNonreviewable?'我长期住在高雄吗？':partialQuote?'🙂旁白。我长期住在高雄。附带说明。':'我长期住在高雄。',...(timeline?{sentAt:'1600000000000'}:{})}),record('2',{sender:'owner',text:'我长期偏好绿茶。',...(timeline?{sentAt:'1800000000000'}:{})}),...(timeline?[record('3',{text:'我长期喜欢慢跑。',sentAt:'1700000000000'})]:[])],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.contacts.setReading(false);
 const normal=supplier(),respond=async(request,input)=>{
  const result=await normal.respond(partialQuote?{...request,validateOutput:()=>{}}:request,input);
  if((legacy||modernNonreviewable)&&request.purpose==='extraction'){
   const value=JSON.parse(result.blocks[0].arguments);for(const scene of value.scenes)for(const fact of scene.memories){if(fact.subject==='self')fact.figurative_type='joke';else fact.speech_act='question';}
   return {blocks:[{...result.blocks[0],arguments:JSON.stringify(value)}]};
  }
  if(partialQuote){
   const value=JSON.parse(result.blocks[0].arguments);
   if(request.purpose==='extraction'){for(const scene of value.scenes)for(const fact of scene.memories)if(fact.subject==='contact')fact.text='联系人长期住在高雄。';}
   else {for(const checked of value.results)if(checked.evidence[0].quote.startsWith('🙂'))checked.evidence[0].quote='我长期住在高雄。';}
   const blocks=[{...result.blocks[0],arguments:JSON.stringify(value)}];await request.validateOutput(blocks);return {blocks};
  }return result;
 };
 let interrupted=false;
 const transport=archive||reuse?{execute:async(name,input)=>{
  if(reuse&&name==='memoryExtraction.finish'&&!interrupted){interrupted=true;await f.storage.execute('fixture.recoverKnownAttempt',{ownerId:owner,attemptId:input.attemptId});throw new Error('合成已知核验回执后的阶段中断');}
  return f.storage.execute(name,archive&&name==='memoryExtraction.finish'?{...input,verificationRefs:undefined}:input);
 }}:f.storage;
 let extraction;extraction=new SqliteMemoryExtraction(transport,owner,modelPort(()=>extraction.accounting,respond));t.after(()=>extraction.close());
 let run;
 if(legacy){await extraction.initialize();run=await f.storage.execute('memoryExtraction.start',{ownerId:owner,requestKey:'legacy-unreviewed',policyConfig:{version:1,mode:'legacy',rule_set_sha256:null}});await extraction.continue(run.runId);}
 else run=await extraction.start('normal-narrow-evidence');
 await extraction.waitForIdle();if(reuse){await extraction.continue(run.runId);await extraction.waitForIdle();}const done=await extraction.read(run.runId);assert.ok(done.tasks.filter(x=>x.scopeKind==='contact'&&x.contactId===contactId).every(x=>x.state==='succeeded'),JSON.stringify(done.tasks));
 const management=new SqliteMemoryManagement(f.storage,owner);await management.importRun(run.runId);return {...f,contactId,extraction,management,runId:run.runId,normal};
}

test('正常07真实核验引句只引用事实来源，完整窗口仍保留为资格依赖',async t=>{
 const f=await prepared(t),candidate=(await f.management.read({scopeKind:'contact',contactId:f.contactId})).candidates[0];assert.ok(candidate);
 assert.deepEqual(candidate.sources.map(s=>s.quote),['我长期住在高雄。']);
 assert.equal(candidate.verificationState,'verified');
 const original=await f.storage.execute('fixture.archiveState',{ownerId:owner});assert.equal(original.required.filter(r=>r.candidate_id===candidate.id).length,1);
 const knowledge=await f.storage.execute('fixture.memoryKnowledge',{ownerId:owner,contactId:f.contactId,discussionId:'synthetic-admission'}),item=knowledge.find(x=>x.id===candidate.id);
 assert.equal(item.qualificationSources.length,2);assert.equal(item.citationSources.length,1);
 const self=(await f.management.read({scopeKind:'self',contactId:null})).candidates[0];assert.equal(self.verificationState,'verified');assert.deepEqual(self.sources.map(s=>s.quote),['我长期偏好绿茶。']);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('合法旧配置无逐事实核验的候选可人工查看采纳，自动发布必须等待核验',async t=>{
 const f=await prepared(t,{legacy:true}),scope={scopeKind:'contact',contactId:f.contactId},candidate=(await f.management.read(scope)).candidates[0];assert.ok(candidate);
 assert.equal(f.normal.purposes.filter(x=>x.purpose==='verification').length,0);
 assert.equal(candidate.verificationState,'pending');
 await assert.rejects(f.management.automatic({requestKey:'unverified-auto',action:'auto_accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]}),{code:'memory_verification_pending'});
 await f.management.publishRun(f.runId);assert.equal((await f.management.read(scope)).memories.length,0);
 await f.management.decide({requestKey:'reviewed-by-user',action:'accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});
 const after=await f.management.read(scope);assert.equal(after.memories[0].current.adoptionMode,'user');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});


test('核验子串保留Unicode代码点引句范围，不扩大到整条消息',async t=>{
 const f=await prepared(t,{partialQuote:true}),candidate=(await f.management.read({scopeKind:'contact',contactId:f.contactId})).candidates[0];
 assert.ok(candidate);assert.equal(candidate.verificationState,'verified');assert.deepEqual(candidate.sources.map(s=>s.quote),['我长期住在高雄。']);
});

test('旧存档即使同attempt有相同事实的核验事件，无具名产物引用仍待核验',async t=>{
 const f=await prepared(t,{archive:true}),scope={scopeKind:'contact',contactId:f.contactId},candidate=(await f.management.read(scope)).candidates[0];
 assert.ok(candidate);assert.equal(f.normal.purposes.filter(x=>x.purpose==='verification').length,1);assert.equal(candidate.verificationState,'pending');
 await assert.rejects(f.management.automatic({requestKey:'archive-auto',action:'auto_accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]}),{code:'memory_verification_pending'});
});


test('正常v2配置疑问与玩笑均逐事实核验并沿各自真实producer准入',async t=>{
 const f=await prepared(t,{modernNonreviewable:true}),contact=(await f.management.read({scopeKind:'contact',contactId:f.contactId})).candidates[0],self=(await f.management.read({scopeKind:'self',contactId:null})).candidates[0];
 assert.equal(f.normal.purposes.filter(x=>x.purpose==='verification').length,1);assert.equal(contact.verificationState,'verified');assert.equal(self.verificationState,'verified');
 assert.deepEqual(contact.sources.map(s=>s.quote),['我长期住在高雄吗？']);assert.deepEqual(self.sources.map(s=>s.quote),['我长期偏好绿茶。']);
});

test('非requires_all_sources合法核验证据可为直接来源子集，必要消息准确且完整资格依赖仍保存',async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-management/admission-registry.mjs',import.meta.url).href}),contactId=f.saved[0].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期住在高雄。'}),record('2',{sender:'owner',text:'我长期偏好绿茶。'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.contacts.setReading(false);
 const {anySourceProducer}=await import('./fixtures/memory-management/any-source-producer.mjs');const run=await anySourceProducer(t,f.storage,contactId);
 const management=new SqliteMemoryManagement(f.storage,owner);await management.importRun(run.runId);const candidate=(await management.read({scopeKind:'contact',contactId})).candidates[0];
 assert.equal(candidate.verificationState,'verified');assert.deepEqual(candidate.sources.map(s=>s.quote),['我长期住在高雄。']);
 const item=(await f.storage.execute('fixture.memoryKnowledge',{ownerId:owner,contactId,discussionId:'synthetic-any-source'})).find(i=>i.id===candidate.id);
 assert.equal(item.qualificationSources.length,2);assert.equal(item.citationSources.length,1);
 const saved=await f.storage.execute('fixture.archiveState',{ownerId:owner});assert.equal(saved.required.filter(r=>r.candidate_id===candidate.id).length,1);
 const uncited=item.qualificationSources.find(s=>!item.citationSources.some(c=>c.messageId===s.messageId));
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts'),{ActiveHolders}=await import('../src/storage/sqlite/deletion/holders.ts'),{ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(f.storage,new ActiveHolders(),new ManagedFiles(f.root)),plan=await deletion.plan({ownerId:owner,requestKey:'delete-uncited-required',scope:{kind:'source',contactId,sourceId:uncited.recordId}});
 assert.equal((await management.read({scopeKind:'contact',contactId})).candidates.length,0);assert.equal((await deletion.advance({ownerId:owner,operationId:plan.operationId})).state,'completed');
 await assert.rejects(management.automatic({requestKey:'late-subset',action:'auto_accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]}));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});


test('旧候选与版本整窗citation只投影真实来源，原事件原稿required和存档均不改写',async t=>{
 const f=await prepared(t,{archive:true}),scope={scopeKind:'contact',contactId:f.contactId},candidate=(await f.management.read(scope)).candidates[0];
 const adopted=await f.management.decide({requestKey:'archive-user-review',action:'accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});
 await f.storage.execute('fixture.archiveWholeWindow',{ownerId:owner,candidateId:candidate.id,memoryId:adopted.memoryId});
 const original=await f.storage.execute('fixture.archiveState',{ownerId:owner});assert.ok(original.citations.length>=4);assert.ok(original.required.length>=4);
 const view=await f.management.read(scope);assert.deepEqual(view.candidates[0].sources.map(s=>s.quote),['我长期住在高雄。']);
 assert.deepEqual(view.memories[0].current.sources.map(s=>s.quote),['我长期住在高雄。']);assert.equal(view.memories[0].current.verificationState,'pending');
 const item=(await f.storage.execute('fixture.memoryKnowledge',{ownerId:owner,contactId:f.contactId,discussionId:'archive-projection'})).find(i=>i.id===adopted.memoryId);assert.equal(item.citationSources.length,1);assert.equal(item.qualificationSources.length,2);
 assert.deepEqual(await f.storage.execute('fixture.archiveState',{ownerId:owner}),original);
});

test('旧source_stamp的已完成存档继续可读，未完成固定任务不伪成功也不调用模型',async t=>{
 const completed=await prepared(t),scope={scopeKind:'contact',contactId:completed.contactId};
 await completed.storage.execute('fixture.oldSourceStamp',{ownerId:owner,runId:completed.runId});assert.equal((await completed.management.read(scope)).candidates[0].verificationState,'verified');
 const f=await fixture(t),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);await f.contacts.setReading(false);
 let extraction;const port=modelPort(()=>extraction.accounting);extraction=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>extraction.close());await extraction.initialize();
 const run=await f.storage.execute('memoryExtraction.start',{ownerId:owner,requestKey:'old-incomplete-policy',policyConfig:{version:2,mode:'legacy',rule_set_sha256:null,verification_policy:'complete-claim-v1',source_stamp:'0'.repeat(64)}});
 await extraction.continue(run.runId);await extraction.waitForIdle();const after=await extraction.read(run.runId);assert.equal(port.calls,0);assert.equal(after.succeeded,0);assert.equal(after.candidates.length,0);
});


test('旧source_stamp的unknown回执继续保守占用，不伪成功、不重发',async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-management/admission-registry.mjs',import.meta.url).href}),contactId=f.saved[0].contact_id;
 await f.service.synchronize(contactId);await f.contacts.setReading(false);
 let extraction;const port=modelPort(()=>extraction.accounting,async()=>{throw new Error('合成未知回执');});extraction=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>extraction.close());
 const run=await extraction.start('old-stamp-unknown');await extraction.waitForIdle();assert.equal((await extraction.read(run.runId)).unknown,1);assert.equal(port.calls,1);
 await f.storage.execute('fixture.oldSourceStamp',{ownerId:owner,runId:run.runId});await extraction.continue(run.runId);await extraction.waitForIdle();
 const after=await extraction.read(run.runId);assert.equal(after.unknown,1);assert.equal(after.succeeded,0);assert.equal(after.candidates.length,0);assert.equal(port.calls,1);
});


test('已知核验回执恢复复用真实call，新的逐fact事件仍可沿原回复准入而不重发',async t=>{
 const f=await prepared(t,{reuse:true}),candidate=(await f.management.read({scopeKind:'contact',contactId:f.contactId})).candidates[0];
 assert.equal(f.normal.purposes.filter(x=>x.purpose==='extraction').length,1);assert.equal(f.normal.purposes.filter(x=>x.purpose==='verification').length,1);
 assert.equal(candidate.verificationState,'verified');assert.deepEqual(candidate.sources.map(s=>s.quote),['我长期住在高雄。']);
});


test('事实A的必要消息和精准引用仅A，真实role=context的B留在完整资格与删除闭包',async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-management/admission-registry.mjs',import.meta.url).href}),contactId=f.saved[0].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{sender:'owner',text:'我长期偏好绿茶。'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.contacts.setReading(false);let baseline;
 baseline=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>baseline.accounting));t.after(()=>baseline.close());await baseline.start('context-baseline');await baseline.waitForIdle();
 await f.contacts.setReading(true);f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{sender:'owner',text:'我长期偏好绿茶。'}),record('2',{text:'我长期住在高雄。'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.contacts.setReading(false);
 const external=supplier();let extraction;
 const respond=async(request,input)=>{const result=await external.respond(request.purpose==='extraction'?{...request,validateOutput:()=>{}}:request,input);if(request.purpose!=='extraction')return result;
  const targets=JSON.parse(request.user).target_message_ids,value=JSON.parse(result.blocks[0].arguments);for(const scene of value.scenes)scene.memories=scene.memories.filter(f=>f.source_message_ids.some(id=>targets.includes(id)));
  const blocks=[{...result.blocks[0],arguments:JSON.stringify(value)}];await request.validateOutput(blocks);return {blocks};};
 extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,respond));t.after(()=>extraction.close());const run=await extraction.start('context-with-new-fact');await extraction.waitForIdle();
 const done=await extraction.read(run.runId);assert.equal(done.inputs.filter(i=>i.role==='context').length,1);assert.equal(done.inputs.filter(i=>i.role==='target').length,1);
 const management=new SqliteMemoryManagement(f.storage,owner);await management.importRun(run.runId);const candidate=(await management.read({scopeKind:'contact',contactId})).candidates[0];
 assert.equal(candidate.verificationState,'verified');assert.deepEqual(candidate.sources.map(s=>s.quote),['我长期住在高雄。']);
 const saved=await f.storage.execute('fixture.archiveState',{ownerId:owner});assert.deepEqual(saved.required.filter(r=>r.candidate_id===candidate.id).map(r=>r.message_id),[candidate.sources[0].messageId]);assert.equal(saved.eventSources.filter(s=>s.event_id===candidate.eventId).length,2);
 const item=(await f.storage.execute('fixture.memoryKnowledge',{ownerId:owner,contactId,discussionId:'real-context'})).find(i=>i.id===candidate.id);assert.equal(item.qualificationSources.length,2);assert.equal(item.citationSources.length,1);
 const context=item.qualificationSources.find(s=>s.messageId!==candidate.sources[0].messageId),{DeletionService}=await import('../src/storage/sqlite/deletion/service.ts'),{ActiveHolders}=await import('../src/storage/sqlite/deletion/holders.ts'),{ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(f.storage,new ActiveHolders(),new ManagedFiles(f.root)),plan=await deletion.plan({ownerId:owner,requestKey:'delete-real-context',scope:{kind:'source',contactId,sourceId:context.recordId}});
 assert.equal((await management.read({scopeKind:'contact',contactId})).candidates.length,0);assert.equal((await deletion.advance({ownerId:owner,operationId:plan.operationId})).state,'completed');
 await assert.rejects(management.automatic({requestKey:'late-context-output',action:'auto_accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]}));
});


test('跨memory typed历史存档父引用参与旧citation投影及verificationState',async t=>{
 const f=await prepared(t,{archive:true}),self={scopeKind:'self',contactId:null},aCandidate=(await f.management.read(self)).candidates[0];
 const a=await f.management.decide({requestKey:'typed-old-parent',action:'accept',candidateIds:[aCandidate.id],candidateRevisions:[aCandidate.stateRevision]});
 const b=f.saved[1].contact_id;await f.contacts.setReading(true);await f.service.synchronize(b);await f.contacts.setReading(false);
 let current;current=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>current.accounting,supplier().respond));t.after(()=>current.close());const run=await current.start('typed-new-candidate');await current.waitForIdle();await f.management.importRun(run.runId);
 const bCandidate=(await f.management.read(self)).candidates.find(c=>c.state==='pending');assert.equal(bCandidate.verificationState,'verified');assert.ok(bCandidate.sources.every(s=>s.contactId===b));
 const execution=await f.storage.execute('fixture.typedAdjudication',{owner,candidateId:bCandidate.id,memoryId:a.memoryId,messages:[...aCandidate.sources,...bCandidate.sources],onlyContact:b});
 const archived=await f.storage.execute('fixture.typedPublish',{owner,candidateId:bCandidate.id,execution});
 await f.storage.execute('fixture.archiveWholeWindow',{ownerId:owner,candidateId:aCandidate.id,memoryId:archived.memoryId});
 const original=await f.storage.execute('fixture.archiveState',{ownerId:owner}),version=(await f.management.read(self)).memories.find(m=>m.id===archived.memoryId).current;
 assert.ok(version);assert.equal(version.verificationState,'pending');assert.deepEqual(version.sources.map(s=>[s.contactId,s.quote]),[[f.contactId,'我长期偏好绿茶。']]);
 assert.deepEqual(await f.storage.execute('fixture.archiveState',{ownerId:owner}),original);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('人工edit_accept/correct/change正文保留用户确认但来源语义不继承祖先verified',async t=>{
 const f=await prepared(t),scope={scopeKind:'contact',contactId:f.contactId},candidate=(await f.management.read(scope)).candidates[0];
 const accepted=await f.management.decide({requestKey:'human-edited',action:'edit_accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision],body:'人工重新表述的关系资料'});
 let memory=(await f.management.read(scope)).memories.find(m=>m.id===accepted.memoryId);assert.equal(memory.current.verificationState,'pending');assert.equal(memory.current.adoptionMode,'user');
 for(const action of ['correct','change']){await f.management.decide({requestKey:`human-${action}`,action,memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body:`人工${action}后的资料`});memory=(await f.management.read(scope)).memories.find(m=>m.id===accepted.memoryId);assert.equal(memory.current.verificationState,'pending');}
 const item=(await f.storage.execute('fixture.memoryKnowledge',{ownerId:owner,contactId:f.contactId,discussionId:'human-confirmed-pending-proof'})).find(i=>i.id===accepted.memoryId);assert.equal(item.qualification,'confirmed');assert.equal(f.normal.purposes.filter(c=>c.purpose==='verification').length,1);
});

test('取消后reconcile与重选保留contact/self已采纳和拒绝存档，pending仍拒绝旧grant',async t=>{
 for(const scopeKind of ['contact','self'])for(const action of ['accept','reject'])await t.test(`${scopeKind}/${action}`,async sub=>{
  const f=await prepared(sub),scope={scopeKind,contactId:scopeKind==='contact'?f.contactId:null},other={scopeKind:scopeKind==='contact'?'self':'contact',contactId:scopeKind==='contact'?null:f.contactId};
  const candidate=(await f.management.read(scope)).candidates[0];await f.management.decide({requestKey:`archived-${scopeKind}-${action}`,action,candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});
  const before=await f.management.read(scope),binding=f.saved.find(s=>s.contact_id===f.contactId);await f.contacts.revoke(f.contactId,binding.binding_id,binding.selection_generation);
  await f.extraction.pause(f.runId);await f.extraction.continue(f.runId);await f.extraction.waitForIdle();
  const after=await f.management.read(scope);assert.equal(after.candidates.length,1);assert.equal(after.candidates[0].state,action==='accept'?'adopted':'rejected');assert.equal(after.candidates[0].verificationState,'verified');assert.deepEqual(after.candidates[0].sources,before.candidates[0].sources);assert.equal((await f.management.read(other)).candidates.length,0);
  if(action==='accept'){assert.equal(after.memories[0].current.verificationState,'verified');assert.deepEqual(after.memories[0].current.sources,before.memories[0].current.sources);}
  const snapshot=await f.contacts.candidates(true),choice=snapshot.sessions.find(s=>s.known_contact_id===f.contactId||s.bound_contact_id===f.contactId);assert.ok(choice);await f.contacts.confirm(snapshot.snapshot_token,[{locator:choice.username,observed_display_name:choice.display_name,expected_selection_generation:choice.selection_generation}]);
  assert.equal((await f.management.read(scope)).candidates[0].verificationState,'verified');assert.equal((await f.management.read(other)).candidates.length,0);assert.equal(f.normal.purposes.length,2);
 });
});

test('本人原A+B冻结任务保持混合归属，单事件A消息资格与存档取消互不扩张',async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-management/admission-registry.mjs',import.meta.url).href}),[a,b]=f.saved.map(c=>c.contact_id),self={scopeKind:'self',contactId:null};
 f.channel.page=async scope=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{sender:'owner',text:scope.token.contact_id===a?'我长期偏好绿茶。':'我长期偏好红茶。'})],completedPartitions:['shard-a'],exhausted:true});
 for(const contactId of [a,b])await f.service.synchronize(contactId);await f.contacts.setReading(false);
 let extraction;extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,supplier().respond));t.after(()=>extraction.close());const run=await extraction.start('frozen-contribution-display');await extraction.waitForIdle();
 const management=new SqliteMemoryManagement(f.storage,owner);await management.importRun(run.runId);const candidate=(await management.read(self)).candidates.find(c=>c.sources.every(s=>s.contactId===a));assert.ok(candidate);
 assert.deepEqual(new Set(candidate.contributingContactIds),new Set([a,b]));
 const before=(await f.storage.execute('fixture.memoryKnowledge',{ownerId:owner,contactId:a,discussionId:'precise-source-mixed-owner'})).find(i=>i.id===candidate.id);assert.deepEqual(before.qualificationSources.map(s=>s.contactId),[a]);assert.deepEqual(before.citationSources.map(s=>s.contactId),[a]);
 const adopted=await management.decide({requestKey:'mixed-task-user-accept',action:'accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});let version=(await management.read(self)).memories.find(m=>m.id===adopted.memoryId).current;assert.deepEqual(new Set(version.contributingContactIds),new Set([a,b]));
 const binding=f.saved.find(c=>c.contact_id===b);await f.contacts.revoke(b,binding.binding_id,binding.selection_generation);await extraction.pause(run.runId);await extraction.continue(run.runId);await extraction.waitForIdle();
 const archived=await management.read(self);assert.deepEqual(new Set(archived.candidates.find(c=>c.id===candidate.id).contributingContactIds),new Set([a,b]));version=archived.memories.find(m=>m.id===adopted.memoryId).current;assert.deepEqual(new Set(version.contributingContactIds),new Set([a,b]));
 await management.decide({requestKey:'mixed-task-correction',action:'correct',memoryId:adopted.memoryId,expectedVersionNo:version.versionNo,expectedHeadRevision:archived.memories.find(m=>m.id===adopted.memoryId).headRevision,body:'人工修正本人绿茶资料'});
 version=(await management.read(self)).memories.find(m=>m.id===adopted.memoryId).current;assert.equal(version.versionNo,'2');assert.deepEqual(new Set(version.contributingContactIds),new Set([a,b]));
 const after=(await f.storage.execute('fixture.memoryKnowledge',{ownerId:owner,contactId:a,discussionId:'precise-source-mixed-owner'})).find(i=>i.id===adopted.memoryId);assert.deepEqual(after.qualificationSources.map(s=>s.contactId),[a]);
 const manual=await management.decide({requestKey:'no-origin-task',action:'manual',scope:self,body:'独立手录资料'});assert.deepEqual((await management.read(self)).memories.find(m=>m.id===manual.memoryId).current.contributingContactIds,[]);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const scenario of ['active','withdrawn','replaced_memory_id','merged_memory_ids','merged_text'])test(`正常07同源重复候选：${scenario}保持真实终态、不复活或伪成功`,async t=>{
 const malformed=!['active','withdrawn'].includes(scenario);
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-management/adjudication-registry.mjs',import.meta.url).href}),contactId=f.saved[0].contact_id,scope={scopeKind:'contact',contactId};
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期住在高雄。'})],completedPartitions:['shard-a'],exhausted:true});await f.service.synchronize(contactId);await f.contacts.setReading(false);
 const normal=supplier();let extraction;
 const sourcePort=modelPort(()=>extraction.accounting,async(request,input)=>{
  if(request.purpose!=='extraction')return normal.respond(request,input);
  const result=await normal.respond({...request,validateOutput:()=>{}},input),value=JSON.parse(result.blocks[0].arguments);value.scenes[0].memories.push(structuredClone(value.scenes[0].memories[0]));
  const blocks=[{...result.blocks[0],arguments:JSON.stringify(value)}];await request.validateOutput(blocks);return {blocks};
 });
 extraction=new SqliteMemoryExtraction(f.storage,owner,sourcePort);t.after(()=>extraction.close());const run=await extraction.start('normal-duplicate-source');await extraction.waitForIdle();
 const management=new SqliteMemoryManagement(f.storage,owner);await management.importRun(run.runId);const candidates=(await management.read(scope)).candidates;assert.equal(candidates.length,2);assert.ok(candidates.every(c=>c.verificationState==='verified'));assert.deepEqual(candidates[0].sources,candidates[1].sources);
 const first=await f.storage.execute('memoryAdjudication.claim',{ownerId:owner,candidateId:candidates[0].id});await f.storage.execute('memoryAdjudication.finish',{ownerId:owner,attemptIds:[first.attemptId]});
 let memory=(await management.read(scope)).memories[0];await management.decide({requestKey:'before-noop',action:scenario==='withdrawn'?'withdraw':'protect',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision});memory=(await management.read(scope)).memories[0];
 const pending=(await management.read(scope)).candidates.find(c=>c.state==='pending'),request={requestKey:'public-noop-rejected',action:'auto_noop',candidateIds:[pending.id],candidateRevisions:[pending.stateRevision],memoryId:memory.id,expectedVersionNo:'1',expectedHeadRevision:memory.headRevision};
 await assert.rejects(management.decide(request),{code:'memory_request_invalid'});await assert.rejects(f.storage.execute('memory.applyAutomaticDecision',{ownerId:owner,request}),{code:'memory_relationship_pending'});
 const purposes=[],respond=async request=>{
  purposes.push(request.purpose);const payload=JSON.parse(request.user);let value;
  if(request.purpose==='adjudication'){const candidate=payload.new_memories[0],prior=payload.existing_memories[0];value={decisions:[{candidate_index:candidate.candidate_index,action:'noop',replaced_memory_id:null,merged_memory_ids:[],merged_text:null,duplicate_memory_id:prior.memory_id,relation:{kind:'supplement',related_memory_ids:[prior.memory_id],explanation:'同来源同事实没有新信息。',evidence:candidate.source_texts.map(s=>({message_id:s.message_id,quote:s.text})),claim_changed:false,condition_changed:false}}]};}
  else value={results:payload.map(p=>({candidate_index:p.candidate_index,supported:true,evidence:[...p.sources.candidate,...p.sources.prior.flatMap(s=>s.sources)].map(s=>({message_id:s.message_id,quote:s.text})),claim_changed:false,condition_changed:false}))};
  if(malformed&&request.purpose==='adjudication'){const d=value.decisions[0];d[scenario]=scenario==='merged_memory_ids'?[d.duplicate_memory_id]:scenario==='replaced_memory_id'?d.duplicate_memory_id:'夹带无关正文';}
  const blocks=[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify(value)}];await request.validateOutput(blocks);return {blocks};
 };
 const {SqliteMemoryAdjudication}=await import('../src/memory/sqlite/management/adjudication-service.ts'),{ActiveHolders}=await import('../src/storage/sqlite/deletion/holders.ts');
 const runtime=new SqliteMemoryAdjudication(f.storage,owner,modelPort(()=>extraction.accounting,respond),new ActiveHolders());t.after(()=>runtime.close());await runtime.initialize();await runtime.publishRun(run.runId);
 const view=await management.read(scope),after=view.memories[0],history=await management.readHistory(scope,after.id);assert.equal(view.memories.length,1);assert.equal(after.versions.length,1);assert.deepEqual(after.current,memory.current);assert.equal(after.headRevision,memory.headRevision);assert.equal(after.manualProtection,memory.manualProtection);assert.equal(after.state,memory.state);
 if(malformed){assert.equal(view.candidates.find(c=>c.id===pending.id).state,'pending');assert.equal(history.decisions.filter(d=>d.action==='auto_noop').length,0);assert.deepEqual(purposes,['adjudication']);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});return;}
 assert.equal(view.candidates.find(c=>c.id===pending.id).state,'duplicate');assert.equal(view.candidates.filter(c=>c.state==='adopted').length,1);if(scenario==='withdrawn')assert.equal(after.current,null);
 const knowledge=await f.storage.execute('fixture.memoryKnowledge',{ownerId:owner,contactId,discussionId:`duplicate-${scenario}`});
 assert.ok(!knowledge.some(item=>item.kind==='memory_candidate'&&item.id===pending.id));assert.equal(knowledge.some(item=>item.kind==='memory'&&item.id===memory.id),scenario==='active');
 assert.deepEqual(purposes,['adjudication','relation_verification']);assert.equal(history.decisions.filter(d=>d.action==='auto_noop'&&d.actorKind==='system').length,1);
 const trace=await f.storage.execute('fixture.adjudicationTrace',{ownerId:owner}),noop=trace.decisions.find(d=>d.action==='auto_noop');assert.ok(noop.execution_id);assert.equal(noop.expected_version_no,1n);assert.equal(noop.expected_head_revision,BigInt(memory.headRevision));
 await runtime.publishRun(run.runId);assert.deepEqual(await management.read(scope),view);assert.equal(purposes.length,2);
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts'),{ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(f.storage,new ActiveHolders(),new ManagedFiles(f.root)),source=pending.sources[0],plan=await deletion.plan({ownerId:owner,requestKey:`duplicate-source-${scenario}`,scope:{kind:'source',contactId,sourceId:source.recordId}});
 assert.equal((await deletion.advance({ownerId:owner,operationId:plan.operationId})).state,'completed');assert.equal((await management.read(scope)).candidates.length,0);assert.equal((await management.read(scope)).memories[0].current,null);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});


test('旧整窗引文的分页时间序只按实际展示来源，不借用同窗较晚消息',{timeout:10000},async t=>{
 const f=await prepared(t,{archive:true,timeline:true}),scope={scopeKind:'contact',contactId:f.contactId};
 const candidates=(await f.management.read(scope)).candidates,city=candidates.find(candidate=>candidate.body.includes('高雄')),running=candidates.find(candidate=>candidate.body.includes('慢跑'));
 const a=await f.management.decide({requestKey:'legacy-timeline-city',action:'accept',candidateIds:[city.id],candidateRevisions:[city.stateRevision]});
 const b=await f.management.decide({requestKey:'legacy-timeline-running',action:'accept',candidateIds:[running.id],candidateRevisions:[running.stateRevision]});
 await f.storage.execute('fixture.archiveWholeWindow',{ownerId:owner,candidateId:city.id,memoryId:a.memoryId});
 const archived=await f.storage.execute('fixture.archiveState',{ownerId:owner});
 const page=await f.management.read(scope);assert.deepEqual(page.memories.map(memory=>memory.id),[b.memoryId,a.memoryId]);
 assert.deepEqual(page.memories.map(memory=>memory.current.sources.map(source=>source.sentAt)),[['1700000000000'],['1600000000000']]);
 assert.deepEqual(await f.storage.execute('fixture.archiveState',{ownerId:owner}),archived,'重建排序不改原事件、引文和来源');
});
