import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {supplier} from './fixtures/memory-management/supplier.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {adjudicationFixture,adjudicationSupplier} from './fixtures/memory-management/adjudication-support.mjs';

async function prepared(t,options={}){
 const f=await fixture(t,{registryModule:options.registryModule??new URL('./fixtures/memory-management/registry.mjs',import.meta.url).href}),[a,b]=f.saved.map(x=>x.contact_id);
 f.channel.page=async scope=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:scope.token.contact_id===a?'我长期住在高雄。':'我长期住在台南。',...options.contactTiming?.(scope.token.contact_id===a)}),record('2',{sender:'owner',text:'我长期偏好绿茶。'})],completedPartitions:['shard-a'],exhausted:true});
 for(const id of [a,b])await f.service.synchronize(id);await options.afterHistory?.(f,a,b);await f.contacts.setReading(false);
 let extraction;const external=supplier();extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,external.respond));t.after(()=>extraction.close());
 const started=await extraction.start('management-normal-output');await extraction.waitForIdle();
 const done=await extraction.read(started.runId);assert.equal(done.succeeded,4,JSON.stringify(done.tasks));
 const management=new SqliteMemoryManagement(f.storage,owner);return {...f,a,b,management,extraction,runId:started.runId};
}
test('正常核验原稿经真实修改采纳形成独立版本，原稿不变且重试返回原决定',async t=>{
 const f=await prepared(t);await f.management.importRun(f.runId);
 const before=await f.management.read({scopeKind:'contact',contactId:f.a});
 assert.equal(before.candidates.length,1);assert.equal(before.memories.length,0);
 const candidate=before.candidates[0];assert.equal(candidate.body,'联系人长期住在高雄。');assert.ok(candidate.sources.every(s=>s.contactId===f.a));
 const request={requestKey:'manual-adoption',action:'edit_accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision],body:'联系人说自己长期住在高雄。'};
 const result=await f.management.decide(request);const replay=await f.management.decide(request);assert.deepEqual(replay,result);
 const after=await f.management.read({scopeKind:'contact',contactId:f.a});
 assert.equal(after.candidates.length,0);const original=(await f.management.read({scopeKind:'contact',contactId:f.a},{candidateId:candidate.id})).candidates[0];assert.equal(original.body,candidate.body);assert.equal(original.state,'adopted');
 assert.equal(after.memories[0].current.body,request.body);assert.equal(after.memories[0].current.adoptionMode,'user');assert.equal(after.memories[0].current.versionNo,'1');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('记忆来源时间沿核验消息投影，未知时间不借用决定或其他联系人日期',async t=>{
 const f=await prepared(t,{contactTiming:isA=>isA?{sentAt:'1700000000123',timePrecision:'millisecond'}:{sentAt:null,timePrecision:null}});
 await f.management.importRun(f.runId);
 for(const [contactId,sentAt,timePrecision] of [[f.a,'1700000000123','millisecond'],[f.b,null,null]]){
  const scope={scopeKind:'contact',contactId},before=await f.management.read(scope),candidate=before.candidates[0];
  assert.ok(candidate.sources.length>0);assert.ok(candidate.sources.every(source=>source.contactId===contactId));
  for(const source of candidate.sources){assert.equal(source.sentAt,sentAt);assert.equal(source.timePrecision,timePrecision);}
  await f.management.decide({requestKey:`source-time-${contactId}`,action:'accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});
  const memory=(await f.management.read(scope)).memories[0];assert.ok((await f.management.readHistory(scope,memory.id)).decisions[0].createdAt);
  assert.deepEqual(memory.current.sources,candidate.sources);assert.deepEqual(memory.versions[0].sources,candidate.sources);
 }
});

test('自动更新撤销追加恢复版本，保护变化令旧CAS失败且不会恢复旧保护',async t=>{
 const f=await adjudicationFixture(t);await f.extract(['我长期住在高雄。'],{publish:true});
 f.setRespond(adjudicationSupplier({action:'update'}));await f.extract(['我现在长期住在台南。'],{publish:true});
 let memory=(await f.read()).memories[0];assert.equal(memory.current.versionNo,'2');
 assert.equal(memory.current.body,'联系人现在长期住在台南。');assert.equal(memory.current.adoptionMode,'auto');
 const restore={requestKey:'undo',action:'restore',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,restoredFromVersionNo:'1',expectedMergedParents:[]};
 await f.management.decide({requestKey:'protect',action:'protect',memoryId:memory.id,expectedVersionNo:'2',expectedHeadRevision:memory.headRevision});
 await assert.rejects(f.management.decide(restore),{code:'memory_head_conflict'});
 memory=(await f.read()).memories[0];
 await assert.rejects(f.management.decide({...restore,expectedHeadRevision:memory.headRevision}),{code:'memory_protected'});
 await f.management.decide({requestKey:'unprotect',action:'unprotect',memoryId:memory.id,expectedVersionNo:'2',expectedHeadRevision:memory.headRevision});
 memory=(await f.read()).memories[0];
 await f.management.decide({...restore,expectedHeadRevision:memory.headRevision});
 memory=(await f.read()).memories[0];
 assert.equal(memory.current.versionNo,'3');assert.equal(memory.current.previousVersionNo,'2');assert.equal(memory.current.restoredFromVersionNo,'1');assert.equal(memory.current.body,'联系人长期住在高雄。');assert.equal(memory.manualProtection,false);
 assert.equal(memory.versions[1].body,'联系人现在长期住在台南。');assert.equal(memory.versions[1].adoptionMode,'auto');assert.equal(memory.current.adoptionMode,'auto');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('05来源删除清候选、版本及敏感决定，本人跨联系人闭包和晚到采纳均不复活',async t=>{
 const f=await prepared(t);await f.management.importRun(f.runId);
 const aScope={scopeKind:'contact',contactId:f.a},selfScope={scopeKind:'self',contactId:null};
 const candidate=(await f.management.read(aScope)).candidates[0];
 const adopted=await f.management.decide({requestKey:'before-delete',action:'edit_accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision],body:'保留必要来源的人工改写'});
 const selfBefore=await f.management.read(selfScope);assert.equal(selfBefore.candidates.length,2);
 const affectedSelf=selfBefore.candidates.find(c=>c.sources.every(s=>s.contactId===f.a));await f.management.automatic({requestKey:'self-auto',action:'auto_accept',candidateIds:[affectedSelf.id],candidateRevisions:[affectedSelf.stateRevision]});
 await f.management.decide({requestKey:'independent-self',action:'manual',scope:selfScope,body:'独立手录仍然合法'});
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts');
 const {ActiveHolders}=await import('../src/storage/sqlite/deletion/holders.ts');const {ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(f.storage,new ActiveHolders(),new ManagedFiles(f.root));
 const plan=await deletion.plan({ownerId:owner,requestKey:'delete-memory-source',scope:{kind:'source',contactId:f.a,sourceId:candidate.sources[0].recordId}});
 const clearing=await f.management.read(aScope);assert.deepEqual(clearing.candidates,[]);assert.deepEqual(clearing.memories,[]);assert.equal(clearing.page.nextCursor,null);
 const done=await deletion.advance({ownerId:owner,operationId:plan.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
 const after=await f.management.read(aScope);assert.equal(after.candidates.length,0);assert.equal(after.memories.find(m=>m.id===adopted.memoryId)?.current??null,null);assert.ok(after.memories.every(m=>m.versions.every(v=>v.body===null)));
 const selfAfter=await f.management.read(selfScope);assert.equal(selfAfter.candidates.length,0);assert.deepEqual(selfAfter.memories.flatMap(m=>m.current?[m.current.body]:[]),['独立手录仍然合法']);
 await assert.rejects(f.management.decide({requestKey:'late',action:'accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]}));
 await assert.rejects(f.management.decide({requestKey:'before-delete',action:'edit_accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision],body:'保留必要来源的人工改写'}));
 assert.equal((await f.management.read({scopeKind:'contact',contactId:f.b})).candidates.length,1);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('新自动采纳可明确撤回，修正与变化保留不同版本来历且旧正文不参与当前读取',async t=>{
 const f=await prepared(t);await f.management.importRun(f.runId);const s={scopeKind:'contact',contactId:f.a};
 const candidate=(await f.management.read(s)).candidates[0];const adopted=await f.management.automatic({requestKey:'auto-first',action:'auto_accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});
 let m=(await f.management.read(s)).memories[0];await f.management.decide({requestKey:'withdraw',action:'withdraw',memoryId:m.id,expectedVersionNo:'1',expectedHeadRevision:m.headRevision});
 assert.equal((await f.management.read(s)).memories[0].current,null);
 const manual=await f.management.decide({requestKey:'manual',action:'manual',scope:s,body:'原来记错'});
 m=(await f.management.read(s)).memories.find(m=>m.id===manual.memoryId);
 await f.management.decide({requestKey:'correction',action:'correct',memoryId:m.id,expectedVersionNo:'1',expectedHeadRevision:m.headRevision,body:'修正错误'});
 m=(await f.management.read(s)).memories.find(m=>m.id===manual.memoryId);
 await f.management.decide({requestKey:'change',action:'change',memoryId:m.id,expectedVersionNo:'2',expectedHeadRevision:m.headRevision,body:'后来发生变化'});
 m=(await f.management.read(s)).memories.find(m=>m.id===manual.memoryId);
 assert.equal(m.current.body,'后来发生变化');assert.deepEqual((await f.management.readHistory(s,m.id)).versions.map(v=>v.formationKind),['manual','correction','change']);assert.equal(adopted.versionNo,'1');
});

test('正式知识读取只返回当前版，未确认独立标注并复验头修订、本人及联系人隔离',async t=>{
 const f=await prepared(t);await f.management.importRun(f.runId);const s={scopeKind:'contact',contactId:f.a};
 const discussion={ownerId:owner,contactId:f.a,discussionId:'synthetic-consumer'};
 const initial=await f.storage.execute('fixture.memoryKnowledge',discussion);assert.ok(initial.every(k=>k.kind==='memory_candidate'&&k.qualification==='unconfirmed'));
 assert.ok(initial.filter(k=>k.scopeKind==='contact').every(k=>k.contactId===f.a&&k.sources.every(s=>s.contactId===f.a)));
 const c=(await f.management.read(s)).candidates[0];const accepted=await f.management.decide({requestKey:'knowledge-accept',action:'accept',candidateIds:[c.id],candidateRevisions:[c.stateRevision]});
 const items=await f.storage.execute('fixture.memoryKnowledge',discussion),item=items.find(k=>k.id===accepted.memoryId);assert.equal(item.kind,'memory');assert.equal(item.qualification,'confirmed');
 assert.equal(await f.storage.execute('fixture.memoryRequireCurrent',{scope:discussion,item}),true);
 const m=(await f.management.read(s)).memories[0];await f.management.decide({requestKey:'knowledge-protect',action:'protect',memoryId:m.id,expectedVersionNo:m.current.versionNo,expectedHeadRevision:m.headRevision});
 await assert.rejects(f.storage.execute('fixture.memoryRequireCurrent',{scope:discussion,item}),{code:'memory_knowledge_stale'});
 const rejected=(await f.management.read({scopeKind:'contact',contactId:f.b})).candidates[0];await f.management.decide({requestKey:'reject-b',action:'reject',candidateIds:[rejected.id],candidateRevisions:[rejected.stateRevision]});
 assert.equal((await f.storage.execute('fixture.memoryKnowledge',{...discussion,contactId:f.b})).filter(k=>k.scopeKind==='contact').length,0);
});
test('历史状态重新认证不会复活旧候选或旧记忆的冻结来源资格',async t=>{
 const f=await prepared(t);await f.management.importRun(f.runId);const scope={scopeKind:'contact',contactId:f.a};
 const candidate=(await f.management.read(scope)).candidates[0];
 const adopted=await f.management.decide({requestKey:'before-state-change',action:'accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});
 const discussion={ownerId:owner,contactId:f.a,discussionId:'synthetic-state-recovery'};
 const before=await f.storage.execute('fixture.memoryKnowledge',discussion);assert.ok(before.some(item=>item.id===adopted.memoryId));
 await f.contacts.setReading(true);const old=(await f.service.read(f.a)).messages.find(message=>message.sender==='contact');
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{stateAssurance:'unverified',sender:'unknown',text:null}),record('2',{sender:'owner',text:'我长期偏好绿茶。'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(f.a);assert.equal((await f.storage.execute('fixture.memoryKnowledge',discussion)).some(item=>item.id===adopted.memoryId),false);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期住在高雄。'}),record('2',{sender:'owner',text:'我长期偏好绿茶。'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(f.a);assert.equal((await f.service.read(f.a)).messages.find(message=>message.sender==='contact').id,old.id);
 const after=await f.storage.execute('fixture.memoryKnowledge',discussion);assert.equal(after.some(item=>item.id===adopted.memoryId||item.id===candidate.id),false);
 assert.equal((await f.management.read(scope)).memories.find(memory=>memory.id===adopted.memoryId).current,null);
 assert.ok((await f.storage.execute('fixture.memoryKnowledge',{...discussion,contactId:f.b})).some(item=>item.scopeKind==='contact'));
});
test('新的关系资料提取固定当前来源，不选择同消息的旧代次实际捕获',async t=>{
 let legacy;
 const f=await prepared(t,{registryModule:new URL('./fixtures/memory-management/legacy-scope-registry.mjs',import.meta.url).href,
  afterHistory:async(f,a)=>{const current=(await f.service.read(a)).messages.find(message=>message.sender==='contact');
   legacy=await f.storage.execute('fixture.seedLegacyScope',{ownerId:owner,contactId:a,recordId:current.sourceRecordIds[0],oldOnly:true});}});
 await f.management.importRun(f.runId);const view=await f.management.read({scopeKind:'contact',contactId:f.a});
 assert.equal(view.candidates.length,1);assert.ok(view.candidates[0].sources.every(source=>source.recordId!==legacy.recordId));
});

test('本人完整授权归属与实际消息依赖分开，删除未参与来源保留合法修正版本',async t=>{
 const f=await prepared(t);await f.management.importRun(f.runId);const self={scopeKind:'self',contactId:null};
 const candidate=(await f.management.read(self)).candidates.find(c=>c.sources.every(s=>s.contactId===f.b));assert.ok(candidate);
 const accepted=await f.management.automatic({requestKey:'mixed-self-auto',action:'auto_accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});
 const knowledge=(await f.storage.execute('fixture.memoryKnowledge',{ownerId:owner,contactId:f.b,discussionId:'synthetic'})).find(k=>k.id===accepted.memoryId);
 assert.deepEqual(new Set(knowledge.qualificationSources.map(s=>s.contactId)),new Set([f.b]));assert.ok(knowledge.citationSources.every(s=>s.contactId===f.b));assert.deepEqual(new Set(knowledge.sources.map(s=>s.contactId)),new Set([f.b]));
 const m=(await f.management.read(self)).memories.find(m=>m.id===accepted.memoryId);await f.management.decide({requestKey:'mixed-self-correct',action:'correct',memoryId:m.id,expectedVersionNo:'1',expectedHeadRevision:m.headRevision,body:'修正后的本人资料'});
 const source=(await f.management.read({scopeKind:'contact',contactId:f.a})).candidates[0].sources[0];
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts');const {ActiveHolders}=await import('../src/storage/sqlite/deletion/holders.ts');const {ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(f.storage,new ActiveHolders(),new ManagedFiles(f.root));const plan=await deletion.plan({ownerId:owner,requestKey:'delete-other-contribution',scope:{kind:'source',contactId:f.a,sourceId:source.recordId}});
 assert.equal((await deletion.advance({ownerId:owner,operationId:plan.operationId})).state,'completed');
 const after=(await f.management.read(self)).memories.find(row=>row.id===accepted.memoryId);assert.equal(after.current.body,'修正后的本人资料');assert.equal(after.current.verificationState,'pending');assert.ok(after.versions.every(v=>v.body!==null));assert.deepEqual(new Set(after.current.contributingContactIds),new Set([f.a,f.b]));
});

test('处理结束窄hook从07正常核验输出自动发布，重试不重复决定或洗成人工确认',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期住在高雄。'})],completedPartitions:['shard-a'],exhausted:true});await f.service.synchronize(contactId);await f.contacts.setReading(false);
 const management=new SqliteMemoryManagement(f.storage,owner);let extraction;
 extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,supplier().respond),undefined,runId=>management.publishRun(runId));t.after(()=>extraction.close());
 const run=await extraction.start('normal-hook-auto');await extraction.waitForIdle();
 const before=await management.read({scopeKind:'contact',contactId});assert.equal(before.memories.length,1);assert.equal(before.memories[0].current.adoptionMode,'auto');assert.equal(before.candidates.length,0);assert.equal((await management.readHistory({scopeKind:'contact',contactId},before.memories[0].id)).versions[0].originalCandidates[0].state,'adopted');
 assert.equal((await management.readHistory({scopeKind:'contact',contactId},before.memories[0].id)).decisions[0].actorKind,'system');await management.publishRun(run.runId);const after=await management.read({scopeKind:'contact',contactId});assert.deepEqual(after,before);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('已有记忆和人工保护时默认发布不能另建身份绕过旧新关系裁决',async t=>{
 const f=await prepared(t),s={scopeKind:'contact',contactId:f.a};await f.management.importRun(f.runId);
 const manual=await f.management.decide({requestKey:'protected-old',action:'manual',scope:s,body:'联系人长期住在台北。'});let m=(await f.management.read(s)).memories[0];
 await f.management.decide({requestKey:'protect-old',action:'protect',memoryId:m.id,expectedVersionNo:'1',expectedHeadRevision:m.headRevision});
 await f.management.publishRun(f.runId);const after=await f.management.read(s);assert.equal(after.memories.length,1);assert.equal(after.memories[0].id,manual.memoryId);assert.equal(after.candidates[0].state,'pending');assert.equal(after.memories[0].current.body,'联系人长期住在台北。');
});
