import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {supplier} from './fixtures/memory-management/supplier.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
const registryModule=new URL('./fixtures/memory-management/adjudication-upgrade-registry.mjs?mode=current',import.meta.url).href;
async function prepared(t){
 const f=await fixture(t,{registryModule}),[a,b]=f.saved.map(c=>c.contact_id),self={scopeKind:'self',contactId:null};
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{sender:'owner',text:'我长期偏好绿茶。'})],completedPartitions:['shard-a'],exhausted:true});
 let extraction;extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,supplier().respond));t.after(()=>extraction.close());
 const management=new SqliteMemoryManagement(f.storage,owner);
 await f.service.synchronize(a);await f.contacts.setReading(false);
 const first=await extraction.start('ancestor-a');await extraction.waitForIdle();await management.importRun(first.runId);
 const ancestor=(await management.read(self)).candidates[0],old=await management.decide({requestKey:'ancestor-a-adopt',action:'accept',candidateIds:[ancestor.id],candidateRevisions:[ancestor.stateRevision]});
 await f.contacts.setReading(true);await f.service.synchronize(b);await f.contacts.setReading(false);
 const second=await extraction.start('candidate-only-b');await extraction.waitForIdle();await management.importRun(second.runId);
 assert.deepEqual(second.tasks.filter(t=>t.scopeKind==='contact').map(t=>t.contactId),[b]);
 const candidate=(await management.read(self)).candidates.find(c=>c.state==='pending');assert.ok(candidate.sources.every(s=>s.contactId===b));
 const source=ancestor.sources[0],messages=[source,...candidate.sources];
 const execution=await f.storage.execute('fixture.typedAdjudication',{owner,candidateId:candidate.id,memoryId:old.memoryId,messages});
 const published=await f.storage.execute('fixture.typedPublish',{owner,candidateId:candidate.id,execution});
 let head=(await management.read(self)).memories.find(m=>m.id===published.memoryId);
 await management.decide({requestKey:'derived-correction',action:'correct',memoryId:head.id,expectedVersionNo:'1',expectedHeadRevision:head.headRevision,body:'合成后继版本'});
 head=(await management.read(self)).memories.find(m=>m.id===published.memoryId);
 await f.storage.execute('fixture.typedAdjudication',{owner,candidateId:candidate.id,memoryId:published.memoryId,messages,kind:'relation_verification',skipCandidate:true});
 const discussions=new SqliteDiscussionService(f.storage,owner),reply=new SqliteReplyCandidateService(f.storage,owner),discussion=await discussions.newDiscussion(b),requestKey=randomUUID();
 const confirmationId=await f.storage.execute('identity.manualConfirm',{ownerId:owner,contactId:b,contextToken:requestKey,id:randomUUID(),at:Date.now()});
 const accepted=await reply.begin({contactId:b,discussionId:discussion.id,requestKey,text:'合成回复请求',identity:{kind:'manual',confirmationId}}),contextId=randomUUID();
 const scope={...accepted.attempt,contextId},query='合成后继版本';
 const initial=await f.storage.execute('reply.freezeInput',{...scope,skillRun:{packages:[],eligible:[]},items:[],workspace:{action:'suggest',draftText:'',contextText:'',includeRelationshipContext:true,selectedPackageId:null,carriedSelectionId:null},at:Date.now()});
 const ticket=await f.storage.execute('reply.beginSearch',{...scope,kind:'memory',query});assert.equal(ticket.status,'accepted');
 const result=await f.storage.execute('reply.finishSearch',{...scope,ticketId:ticket.ticketId,query});assert.equal(result.status,'ok');
 const frozen=[...initial,...result.items];
 assert.ok(frozen.some(item=>item.identity.id===published.memoryId),'回复冻结必须实际取到本次要验证删除依赖的资料');
 return {...f,a,b,source,self,management,execution,published,head,contextId,accepted,frozen,deletion:new DeletionService(f.storage,new ActiveHolders(),new ManagedFiles(f.root))};
}
test('旧A仅作历史资格前文，B当前裁决产生的新身份与后继版本及回复均随A来源删除',async t=>{
 const f=await prepared(t),before=await f.storage.execute('fixture.upgradeInspect',{});
 assert.ok(before.data.memory_citation.filter(c=>c.memory_id===f.published.memoryId).every(c=>c.source_contact_id===f.b));
 const plan=await f.deletion.plan({ownerId:owner,requestKey:'typed-history-a',scope:{kind:'source',contactId:f.a,sourceId:f.source.recordId}});
 assert.ok(plan.targets.some(t=>t.target?.domain==='memory_management'&&t.target.key.memory_id===f.published.memoryId),'系统execution_id实际typedmessage来源传播到新身份');
 const done=await f.deletion.advance({ownerId:owner,operationId:plan.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
 const after=await f.storage.execute('fixture.upgradeInspect',{}),derived=after.data.memory_version.filter(v=>v.memory_id===f.published.memoryId);
 assert.equal(derived.length,2);assert.ok(derived.every(v=>v.body===null&&v.provenance_state==='invalidated'));
 assert.ok(!after.data.processing_step.some(s=>s.id===f.execution.step));assert.ok(!after.data.execution_event.some(e=>e.id===f.execution.event));
 assert.ok(!after.data.reply_context.some(c=>c.id===f.contextId));assert.ok(f.frozen.find(i=>i.identity.id===f.published.memoryId)?.sources.some(s=>s.contactId===f.a));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 for(const scope of [{kind:'contact',contactId:f.a},{kind:'account'}]){
  const next=await f.deletion.plan({ownerId:owner,requestKey:`after-source-${scope.kind}`,scope});
  assert.equal((await f.deletion.advance({ownerId:owner,operationId:next.operationId})).state,'completed');
 }
});
test('typed消费者先清痕迹与输入，整联系人和账号硬删除没有FK阻塞',async t=>{
 for(const kind of ['contact','account'])await t.test(kind,async sub=>{
  const f=await prepared(sub),scope=kind==='contact'?{kind,contactId:f.a}:{kind};
  const plan=await f.deletion.plan({ownerId:owner,requestKey:`typed-hard-${kind}`,scope});
  const done=await f.deletion.advance({ownerId:owner,operationId:plan.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
  const after=await f.storage.execute('fixture.upgradeInspect',{});assert.ok(!after.data.step_input.some(s=>s.step_id===f.execution.step));assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 });
});

test('真实同execution主更新后逐父retire不产版不消费候选，拒绝伪造且删除释放无版本决定',async t=>{
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id,self={scopeKind:'self',contactId:null};
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{sender:'owner',text:'我长期偏好绿茶。'}),record('2',{sender:'owner',text:'我长期住在高雄。'}),record('3',{sender:'owner',text:'我长期喜欢慢跑。'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.contacts.setReading(false);
 let extraction;extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,supplier().respond));t.after(()=>extraction.close());
 const started=await extraction.start('retirement-inputs');await extraction.waitForIdle();
 const management=new SqliteMemoryManagement(f.storage,owner);await management.importRun(started.runId);
 const candidates=(await management.read(self)).candidates;assert.equal(candidates.length,3);
 const parents=[];for(const c of candidates.slice(0,2))parents.push(await management.decide({requestKey:`retire-parent-${c.id}`,action:'accept',candidateIds:[c.id],candidateRevisions:[c.stateRevision]}));
 const candidate=candidates[2],messages=[...new Map(candidates.flatMap(c=>c.sources).map(s=>[s.recordId,s])).values()];
 const execution=await f.storage.execute('fixture.typedAdjudication',{owner,candidateId:candidate.id,memoryIds:parents.map(p=>p.memoryId),messages});
 // 原始 SQL 的退役版本约束留在冻结 v12 测试；当前产品由正式动作决定是否产生版本。
 for(const violation of ['running','missing_primary','protected','call_failed','user','missing_execution','missing_target','missing_expected','stale_head','restored']){
  await assert.rejects(f.storage.execute('fixture.autoRetireCase',{owner,candidateId:candidate.id,execution,primaryId:parents[0].memoryId,secondaryId:parents[1].memoryId,violation}),undefined,violation);
 }
 const done=await f.storage.execute('fixture.autoRetireCase',{owner,candidateId:candidate.id,execution,primaryId:parents[0].memoryId,secondaryId:parents[1].memoryId});
 assert.equal(done.after,done.before+1n);assert.equal(done.retireVersions,0n);assert.equal(done.retireCandidates,0n);
 const deletion=new DeletionService(f.storage,new ActiveHolders(),new ManagedFiles(f.root)),source=messages[0];
 const plan=await deletion.plan({ownerId:owner,requestKey:'retirement-source-clear',scope:{kind:'source',contactId,sourceId:source.recordId}});
 assert.ok(plan.targets.some(t=>t.target?.domain==='memory_management'&&t.target.rowKind==='memory_decision'&&t.target.key.id===done.retirement));
 const cleared=await deletion.advance({ownerId:owner,operationId:plan.operationId});assert.equal(cleared.state,'completed',JSON.stringify(cleared.checks));
 const after=(await f.storage.execute('fixture.upgradeInspect',{})).data;assert.ok(!after.step_attempt.some(a=>a.id===execution.attempt));assert.equal(after.memory_decision.find(d=>d.id===done.retirement)?.execution_id,null);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('21条真实target分两step，删第21条保留首step原稿、正式版、手录与必要run FK',async t=>{
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id,scope={scopeKind:'contact',contactId};
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:21},(_,n)=>record(String(n+1),{text:`我长期保留合成资料${n+1}。`,sentAt:String(1700000000000+(n+1)*1000)})),completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.contacts.setReading(false);
 let extraction;extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,supplier().respond));t.after(()=>extraction.close());
 const run=await extraction.start('precise-21-targets');await extraction.waitForIdle();assert.equal((await extraction.read(run.runId)).succeeded,21,JSON.stringify((await extraction.read(run.runId)).tasks));
 const management=new SqliteMemoryManagement(f.storage,owner);await management.importRun(run.runId);
 const candidates=[];let cursor;do{const page=await management.read(scope,cursor?{cursor}:{});candidates.push(...page.candidates);cursor=page.page.nextCursor;}while(cursor);assert.equal(candidates.length,21);
 const first=candidates.find(c=>c.sources.some(s=>s.quote==='我长期保留合成资料1。')),last=candidates.find(c=>c.sources.some(s=>s.quote==='我长期保留合成资料21。'));assert.ok(first&&last);
 const accepted=await management.decide({requestKey:'first-step-accepted',action:'accept',candidateIds:[first.id],candidateRevisions:[first.stateRevision]});
 const manual=await management.decide({requestKey:'independent-manual-21',action:'manual',scope,body:'独立手录保留'});
 const before=(await f.storage.execute('fixture.upgradeInspect',{})).data,original=before.memory_candidate.find(c=>c.id===first.id),attempt=before.step_attempt.find(a=>a.id===original.produced_attempt_id),step=before.processing_step.find(s=>s.id===attempt.step_id);
 const actual=before.execution_input.filter(x=>x.event_id===original.event_id).flatMap(x=>before.step_input.filter(i=>i.step_id===x.planned_step_id&&i.input_no===x.planned_input_no)).flatMap(i=>before.run_input.filter(r=>r.run_id===i.run_id&&r.input_no===i.run_input_no));
 assert.equal(actual.length,20);assert.ok(actual.every(i=>i.record_id!==last.sources[0].recordId));
 const deletion=new DeletionService(f.storage,new ActiveHolders(),new ManagedFiles(f.root)),plan=await deletion.plan({ownerId:owner,requestKey:'only-target-21',scope:{kind:'source',contactId,sourceId:last.sources[0].recordId}});
 assert.ok(!plan.targets.some(t=>t.target?.domain==='memory_management'&&t.target.key.memory_id===accepted.memoryId));
 const done=await deletion.advance({ownerId:owner,operationId:plan.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
 const after=(await f.storage.execute('fixture.upgradeInspect',{})).data;
 assert.deepEqual(after.memory_candidate.find(c=>c.id===first.id),original);assert.deepEqual(after.step_attempt.find(a=>a.id===attempt.id),attempt);assert.deepEqual(after.processing_step.find(s=>s.id===step.id),step);
 assert.equal(after.run_input.filter(i=>i.run_id===run.runId).length,20);assert.ok(after.run_contact.some(c=>c.run_id===run.runId&&c.contact_id===contactId));
 const view=await management.read(scope);assert.equal(view.memories.find(m=>m.id===accepted.memoryId)?.current?.body,first.body);assert.equal(view.memories.find(m=>m.id===manual.memoryId)?.current?.body,'独立手录保留');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('同self step和attempt的独立A/B事件删A只清实际A与混合stage，B存档及成功证明保留',async t=>{
 const f=await fixture(t,{registryModule}),[a,b]=f.saved.map(c=>c.contact_id),scope={scopeKind:'self',contactId:null};
 f.channel.page=async input=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{sender:'owner',text:input.token.contact_id===a?'我长期偏好绿茶。':'我长期喜欢慢跑。'})],completedPartitions:['shard-a'],exhausted:true});
 for(const contactId of [a,b])await f.service.synchronize(contactId);await f.contacts.setReading(false);
 let extraction;extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,supplier().respond));t.after(()=>extraction.close());
 const run=await extraction.start('independent-self-events');await extraction.waitForIdle();
 const management=new SqliteMemoryManagement(f.storage,owner);await management.importRun(run.runId);
 const candidates=(await management.read(scope)).candidates,ca=candidates.find(c=>c.sources.every(s=>s.contactId===a)),cb=candidates.find(c=>c.sources.every(s=>s.contactId===b));assert.ok(ca&&cb);
 const ma=await management.decide({requestKey:'self-event-a',action:'accept',candidateIds:[ca.id],candidateRevisions:[ca.stateRevision]}),mb=await management.decide({requestKey:'self-event-b',action:'accept',candidateIds:[cb.id],candidateRevisions:[cb.stateRevision]});
 const before=(await f.storage.execute('fixture.upgradeInspect',{})).data,rawA=before.memory_candidate.find(c=>c.id===ca.id),rawB=before.memory_candidate.find(c=>c.id===cb.id);assert.equal(rawA.produced_attempt_id,rawB.produced_attempt_id);
 const attempt=before.step_attempt.find(x=>x.id===rawB.produced_attempt_id),step=before.processing_step.find(s=>s.id===attempt.step_id),event=before.execution_event.find(e=>e.id===rawB.event_id);
 const deletion=new DeletionService(f.storage,new ActiveHolders(),new ManagedFiles(f.root)),plan=await deletion.plan({ownerId:owner,requestKey:'independent-self-delete-a',scope:{kind:'source',contactId:a,sourceId:ca.sources[0].recordId}});
 assert.ok(!plan.targets.some(t=>t.target?.domain==='memory_management'&&t.target.key.memory_id===mb.memoryId));
 const done=await deletion.advance({ownerId:owner,operationId:plan.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
 const after=(await f.storage.execute('fixture.upgradeInspect',{})).data;assert.deepEqual(after.memory_candidate.find(c=>c.id===cb.id),rawB);assert.deepEqual(after.step_attempt.find(x=>x.id===attempt.id),attempt);assert.deepEqual(after.processing_step.find(s=>s.id===step.id),step);assert.deepEqual(after.execution_event.find(e=>e.id===event.id),event);
 assert.ok(!after.execution_event.some(e=>e.id===rawA.event_id));assert.ok(!after.execution_event.some(e=>e.step_attempt_id===attempt.id&&e.kind==='stage_result'));
 const view=await management.read(scope);assert.equal(view.memories.find(m=>m.id===mb.memoryId)?.current?.body,cb.body);assert.equal(view.memories.find(m=>m.id===ma.memoryId)?.current,null);
 const hard=await deletion.plan({ownerId:owner,requestKey:'independent-self-hard-a',scope:{kind:'contact',contactId:a}});assert.equal((await deletion.advance({ownerId:owner,operationId:hard.operationId})).state,'completed');
 assert.equal((await management.read(scope)).memories.find(m=>m.id===mb.memoryId)?.current?.body,cb.body);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
