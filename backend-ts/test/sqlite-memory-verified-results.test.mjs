import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';

// 与 complete-claim-verification / semantic-scope 的供应商响应合同一致；仅替换外部返回。
const semanticFields=['category','topic','scene_name','alternatives','interpretation_reason','valid_at','invalid_at','speech_act','assertion_status','figurative_type','event','conditions'];
const facet=(verdict='supported')=>({verdict,evidence_indices:[0]});
function fact(message){
 const subject=message.sender==='self'?'self':'contact';
 return {text:message.text.replace(/^我/,subject==='self'?'用户':'联系人'),subject,category:'common_fact',topic:'other',source_message_ids:[message.message_id],
  confidence:0.8,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],
  interpretation_reason:'保留合成原句明确陈述。',event:null,conditions:null};
}
function supplier({negative=false,eventQuote=false}={}){
 const windows=[],sources=new Map(),purposes=[];
 const respond=async(request,input)=>{
  purposes.push({contactId:input.scope.contact_id,purpose:request.purpose});const payload=JSON.parse(request.user);let value;
  if(request.purpose==='extraction'){
   assert.equal(request.tool.name,'DirectMemoryExtractionOutput');
   windows.push({contactId:input.scope.contact_id,payload});
   for(const message of payload.messages)sources.set(message.message_id,{...message,contactId:input.scope.contact_id});
   value={scenes:[{scene_name:'合成长期资料',memories:payload.messages.map(message=>{
    const candidate=fact(message);
    if(eventQuote)candidate.event={version:2,stage:'cancelled',stage_evidence:[],occurrence_start:null,occurrence_end:null,
     occurrence_evidence:[],occurrence_precision:'unknown',occurrence_expression:null,anchor_message_id:null};
    return candidate;
   })}]};
  }else{
   assert.equal(request.tool.name,'SourceVerificationOutput');
   value={request_fingerprint:payload.request_fingerprint,results:payload.candidates.map((candidate,candidate_index)=>{
    const message=sources.get(candidate.source_message_ids[0]);assert.equal(message.contactId,input.scope.contact_id);
    return {candidate_index,verdict:'supported',issues:[],evidence:[{message_id:message.message_id,quote:message.text}],
     ...(eventQuote?{event_verification:{stage_verdict:'supported',occurrence_verdict:'uncertain',
      stage_evidence:[{message_id:message.message_id,quote:message.text}],occurrence_evidence:[]}}:{}),
     claim_check:{version:2,field_checks:Object.fromEntries(semanticFields.map(field=>[field,facet()])),parts:[{
      candidate_span:{start:0,end:[...candidate.text].length},attribution:{...facet(),scope_subject:candidate.subject,actor_kind:candidate.subject,resolution:'explicit',
       subject_mentions:[{kind:'first_person',evidence_index:0,source_span:{start:0,end:1},candidate_span:{start:0,end:candidate.subject==='self'?2:3}}]},
      arguments_and_relation:facet(),temporal_and_modality:facet(negative?'uncertain':'supported'),
     }]}};
   })};
  }
  const blocks=[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify(value)}];
  await request.validateOutput(blocks);return {blocks};
 };
 return {respond,windows,sources,purposes};
}

test('正常提取逐项来源语义核验保持两位联系人输入隔离，并登记真实本人贡献而不冒充正式记忆',async t=>{
 const f=await fixture(t);const [a,b]=f.saved.map(binding=>binding.contact_id);
 const sourceRows={
  [a]:[record('1',{text:'我长期住在高雄。'}),record('2',{sender:'owner',text:'我长期偏好绿茶。'})],
  [b]:[record('1',{text:'我长期住在台南。'}),record('2',{sender:'owner',text:'我长期偏好红茶。'})],
 };
 f.channel.page=async scope=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:sourceRows[scope.token.contact_id],completedPartitions:['shard-a'],exhausted:true});
 for(const contactId of [a,b])await f.service.synchronize(contactId);
 const messages=new Map();for(const contactId of [a,b])messages.set(contactId,(await f.service.read(contactId)).messages);
 await f.contacts.setReading(false);
 const external=supplier();let memory;const model=modelPort(()=>memory.accounting,external.respond);memory=new SqliteMemoryExtraction(f.storage,owner,model);t.after(()=>memory.close());
 const started=await memory.start('verified-two-contacts-and-self');await memory.waitForIdle();const done=await memory.read(started.runId);
 const diagnostic=await Promise.all(done.tasks.filter(task=>task.scopeKind==='contact').map(async task=>({state:task.state,error:task.errorCode,trace:await memory.trace(task.taskId)})));
 assert.equal(done.total,4);assert.equal(done.succeeded,4,JSON.stringify(diagnostic.map(d=>({state:d.state,error:d.error,kinds:d.trace.events.map(e=>e.kind),calls:d.trace.calls.map(c=>({state:c.state,purpose:c.purpose}))}))));assert.equal(done.failed,0);assert.equal(done.unknown,0);assert.equal(done.candidates.length,4);
 assert.equal(model.calls,4,'每个联系人仅执行一次提取和一次核验，本人贡献不拼接所有人的聊天再调用');
 assert.equal(external.windows.length,2);
 for(const window of external.windows){
  assert.deepEqual(new Set(window.payload.messages.map(message=>message.message_id)),new Set(messages.get(window.contactId).map(message=>message.id)));
  assert.deepEqual(new Set(window.payload.target_message_ids),new Set(messages.get(window.contactId).map(message=>message.id)));
 }
 assert.deepEqual(done.candidates.filter(candidate=>candidate.scopeKind==='contact').map(candidate=>candidate.body).sort(),['联系人长期住在台南。','联系人长期住在高雄。'].sort());
 const self=done.candidates.filter(candidate=>candidate.scopeKind==='self');assert.deepEqual(self.map(candidate=>candidate.body).sort(),['用户长期偏好红茶。','用户长期偏好绿茶。'].sort());assert.ok(self.every(candidate=>candidate.contactId===null&&candidate.fact.subject==='self'));
 assert.ok(done.candidates.every(candidate=>candidate.state==='verified_pending_decision'&&candidate.origin==='auto'));
 assert.equal(done.laterStages,'pending');assert.notEqual(done.state,'completed');
 for(const task of done.tasks.filter(task=>task.scopeKind==='contact')){
  const trace=await memory.trace(task.taskId);const verified=trace.events.filter(event=>event.kind==='verification');
  assert.equal(verified.length,2);assert.ok(verified.every(event=>event.payload.result.verification_mode==='complete-claim-v1'&&event.payload.result.verdict==='supported'&&event.payload.result.claim_validation.status==='checked'&&event.payload.result.claim_validation.semantic_support==='supported'));
  assert.ok(trace.events.every(event=>event.sources.every(source=>source.contactId===task.contactId)));
  const ownerMessage=messages.get(task.contactId).find(message=>message.senderRole==='owner'||message.sender==='owner');
  const contribution=trace.events.find(event=>event.kind==='verified_self_contribution'&&event.payload.scopeKind==='self');assert.ok(contribution);assert.equal(contribution.payload.fact.subject,'self');
  assert.deepEqual(contribution.payload.fact.source_message_ids,[ownerMessage.id]);
  assert.deepEqual(new Set(contribution.sources.map(source=>source.recordId)),new Set(messages.get(task.contactId).flatMap(message=>message.sourceRecordIds)));
 }
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('语义核验逐项拒绝按内容跳过完成本轮，已知模型返回仍保留拒绝事实且不阻断',async t=>{
 const f=await fixture(t);const contactId=f.saved[0].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期住在高雄。'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.contacts.setReading(false);
 const external=supplier({negative:true});let memory;const model=modelPort(()=>memory.accounting,external.respond);memory=new SqliteMemoryExtraction(f.storage,owner,model);t.after(()=>memory.close());
 const started=await memory.start('content-rejection-is-not-a-failure');await memory.waitForIdle();const done=await memory.read(started.runId);
 assert.equal(done.total,1);assert.equal(done.succeeded,1);assert.equal(done.failed,0);assert.equal(done.unknown,0);assert.equal(done.candidates.length,0);
 const task=done.tasks.find(task=>task.scopeKind==='contact');assert.equal(task.state,'succeeded');assert.equal(task.errorCode,null,JSON.stringify({task,calls:model.calls,trace:(await memory.trace(task.taskId)).events.map(event=>event.kind)}));
 const trace=await memory.trace(task.taskId);assert.equal(model.calls,2);assert.ok(trace.calls.every(call=>call.state==='succeeded'));
 const verification=trace.events.find(event=>event.kind==='verification');assert.ok(verification);assert.equal(verification.payload.result.verification_mode,'complete-claim-v1');
 assert.equal(verification.payload.result.model_verdict,'supported');assert.equal(verification.payload.result.verdict,'uncertain');assert.equal(verification.payload.result.claim_validation.semantic_support,'uncertain');
 assert.ok(trace.events.some(event=>event.kind==='extraction_return'));assert.ok(trace.events.some(event=>event.kind==='verification_return'));
 const staged=trace.events.find(event=>event.kind==='stage_result');assert.ok(staged,'逐条拒绝的真实结果仍要保留在执行记录中');
 assert.equal(staged.payload.outcome,'no_new_memory');assert.equal(staged.payload.rejected,1);
 assert.equal(trace.events.some(event=>event.kind==='verified_output'),false);
 assert.equal(done.laterStages,'pending');assert.notEqual(done.state,'completed');assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('整批候选全被拒按已处理收尾并继续后续批次，后续目标不再排队',async t=>{
 const f=await fixture(t);const contactId=f.saved[0].contact_id;
 const texts=Array.from({length:25},(_,index)=>`我长期住在合成城市${index+1}。`);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:texts.map((text,index)=>record(String(index+1),{text})),completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.contacts.setReading(false);
 // 第一批（20条）核验逐条拒绝，第二批（5条）恢复正常：拒绝不能阻塞后续目标。
 const normal=supplier();let verifications=0;
 const respond=async(request,input)=>{
  if(request.purpose!=='verification'||verifications++>0)return normal.respond(request,input);
  // 第一次核验整批判为语义不确定；同一 block 必须先构造再统一走 validateOutput，不能事后改写。
  const payload=JSON.parse(request.user);
  const value={request_fingerprint:payload.request_fingerprint,results:payload.candidates.map((candidate,index)=>{
   const message=normal.sources.get(candidate.source_message_ids[0]);
   return {candidate_index:index,verdict:'supported',issues:[],evidence:[{message_id:message.message_id,quote:message.text}],
    claim_check:{version:2,field_checks:Object.fromEntries(semanticFields.map(field=>[field,facet()])),parts:[{
     candidate_span:{start:0,end:[...candidate.text].length},
     attribution:{...facet(),scope_subject:candidate.subject,actor_kind:candidate.subject,resolution:'explicit',
      subject_mentions:[{kind:'first_person',evidence_index:0,source_span:{start:0,end:1},candidate_span:{start:0,end:candidate.subject==='self'?2:3}}]},
     arguments_and_relation:facet(),temporal_and_modality:facet('uncertain'),
    }]}};
  })};
  const blocks=[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify(value)}];
  await request.validateOutput(blocks);return {blocks};
 };
 let memory;const model=modelPort(()=>memory.accounting,respond);memory=new SqliteMemoryExtraction(f.storage,owner,model);t.after(()=>memory.close());
 const started=await memory.start('content-rejection-continues-next-batch');await memory.waitForIdle();const done=await memory.read(started.runId);
 assert.equal(done.total,25);assert.equal(done.succeeded,25);assert.equal(done.failed,0);assert.equal(done.unknown,0);assert.equal(done.pending,0);
 assert.equal(done.candidates.length,5,'第一批20条全部内容拒绝，第二批5条正常产生候选');
 const task=done.tasks.find(task=>task.scopeKind==='contact');
 assert.equal(task.state,'succeeded');assert.equal(task.errorCode,null);
 const trace=await memory.trace(task.taskId);
 const staged=trace.events.filter(event=>event.kind==='stage_result');
 assert.deepEqual(staged.map(event=>[event.payload.outcome,event.payload.rejected]),[['no_new_memory',20],['verified_pending_decision',0]],'第一批保留真实拒绝条数并按已处理收尾，第二批继续');
 const schedule=await memory.readSchedule();assert.equal(schedule.blockedContacts,0,'内容拒绝不能让该联系人继续排队');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('SQLite提取窗口为事件逐字引文提供文字表示，完整核验可接纳已取消事件',async t=>{
 const f=await fixture(t);const contactId=f.saved[0].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我把周末聚会取消了。'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.contacts.setReading(false);
 const external=supplier({eventQuote:true});let memory;const model=modelPort(()=>memory.accounting,external.respond);memory=new SqliteMemoryExtraction(f.storage,owner,model);t.after(()=>memory.close());
 const started=await memory.start('sqlite-event-quote-needs-text-representation');await memory.waitForIdle();const done=await memory.read(started.runId);
 const task=done.tasks.find(task=>task.scopeKind==='contact'),trace=await memory.trace(task.taskId);
 const diagnostic=JSON.stringify({state:task.state,error:task.errorCode,verification:trace.events.filter(event=>event.kind==='verification').map(event=>event.payload.result)});
 assert.equal(done.total,1);assert.equal(done.succeeded,1,diagnostic);assert.equal(done.failed,0);assert.equal(done.unknown,0);assert.equal(done.candidates.length,1);
 assert.equal(model.calls,2);assert.equal(external.windows.length,1);
 const verificationInput=trace.events.find(event=>event.kind==='verification_input');assert.ok(verificationInput);
 assert.equal(verificationInput.payload.window.messages[0].text_representation,'text');
 const verification=trace.events.find(event=>event.kind==='verification');assert.ok(verification);
 assert.equal(verification.payload.result.verdict,'supported');assert.equal(verification.payload.result.event.stage,'cancelled');
 assert.equal(verification.payload.result.event.stage_verified,true);assert.deepEqual(verification.payload.result.event.stage_evidence,[{message_id:verification.payload.result.event.stage_evidence[0].message_id,char_start:0,char_end:'我把周末聚会取消了。'.length}]);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('完成后撤销一位贡献者授权使完整本人混合任务候选失效，另一联系人合法结果保持可读',async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-sqlite/verified-output-registry.mjs',import.meta.url).href});const [a,b]=f.saved;
 f.channel.page=async scope=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[
  record('1',{text:scope.token.contact_id===a.contact_id?'我长期住在高雄。':'我长期住在台南。'}),
  record('2',{sender:'owner',text:scope.token.contact_id===a.contact_id?'我长期偏好绿茶。':'我长期偏好红茶。'}),
 ],completedPartitions:['shard-a'],exhausted:true});
 for(const contactId of [a.contact_id,b.contact_id])await f.service.synchronize(contactId);
 await f.contacts.setReading(false);
 const external=supplier();let memory;const model=modelPort(()=>memory.accounting,external.respond);memory=new SqliteMemoryExtraction(f.storage,owner,model);t.after(()=>memory.close());
 const requestKey='revoke-completed-self-contributor',started=await memory.start(requestKey);await memory.waitForIdle();
 const before=await memory.read(started.runId),self=before.tasks.find(task=>task.scopeKind==='self'),kept=before.candidates.find(candidate=>candidate.contactId===b.contact_id);
 assert.equal(before.succeeded,4);assert.equal(before.candidates.length,4);assert.equal(before.candidates.filter(candidate=>candidate.scopeKind==='self').length,2);assert.ok(kept);assert.equal(model.calls,4);
 const keptSelf=before.candidates.find(candidate=>candidate.scopeKind==='self'&&candidate.body==='用户长期偏好红茶。');assert.ok(keptSelf);
 const eligibleSelf=await f.storage.execute('fixture.verifiedExtractionOutput',{ownerId:owner,eventId:keptSelf.id});assert.equal(eligibleSelf.proposedBody,keptSelf.body);assert.ok(eligibleSelf.sources.every(source=>source.contactId===b.contact_id));
 await f.contacts.revoke(a.contact_id,a.binding_id,a.selection_generation);
 const after=await memory.read(started.runId);assert.equal(after.tasks.find(task=>task.taskId===self.taskId).state,'revoked');
 await assert.rejects(memory.trace(self.taskId),{code:'memory_extraction_scope_stale'});
 await assert.rejects(f.storage.execute('fixture.verifiedExtractionOutput',{ownerId:owner,eventId:keptSelf.id}),{code:'memory_extraction_scope_stale'},'08准入须复验整个本人任务的固定贡献资格');
 assert.equal(after.candidates.filter(candidate=>candidate.scopeKind==='self').length,0,'本人混合任务任一贡献者失效后不得保留另一人的单条本人产物');
 assert.deepEqual(after.candidates,[kept]);assert.equal(after.tasks.find(task=>task.contactId===b.contact_id).state,'succeeded');
 await assert.rejects(memory.trace(before.tasks.find(task=>task.contactId===a.contact_id).taskId),{code:'memory_extraction_scope_stale'});
 const keptTrace=await memory.trace(after.tasks.find(task=>task.contactId===b.contact_id).taskId);
 assert.deepEqual(keptTrace.events.filter(event=>event.kind==='verified_output').map(event=>event.payload.fact.text),['联系人长期住在台南。']);
 assert.equal((await f.storage.execute('fixture.verifiedExtractionOutput',{ownerId:owner,eventId:kept.id})).proposedBody,kept.body);
 assert.deepEqual((await memory.start(requestKey)).candidates,[kept]);assert.equal(model.calls,4);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
