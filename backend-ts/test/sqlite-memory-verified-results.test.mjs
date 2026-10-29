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
function supplier({negative=false}={}){
 const windows=[],sources=new Map(),purposes=[];
 const respond=async(request,input)=>{
  purposes.push({contactId:input.scope.contact_id,purpose:request.purpose});const payload=JSON.parse(request.user);let value;
  if(request.purpose==='extraction'){
   assert.equal(request.tool.name,'DirectMemoryExtractionOutput');
   windows.push({contactId:input.scope.contact_id,payload});
   for(const message of payload.messages)sources.set(message.message_id,{...message,contactId:input.scope.contact_id});
   value={scenes:[{scene_name:'合成长期资料',memories:payload.messages.map(fact)}]};
  }else{
   assert.equal(request.tool.name,'SourceVerificationOutput');
   value={request_fingerprint:payload.request_fingerprint,results:payload.candidates.map((candidate,candidate_index)=>{
    const message=sources.get(candidate.source_message_ids[0]);assert.equal(message.contactId,input.scope.contact_id);
    return {candidate_index,verdict:'supported',issues:[],evidence:[{message_id:message.message_id,quote:message.text}],
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

test('语义核验逐项证据不足保留失败事实，已知模型返回不能被计为无产出成功',async t=>{
 const f=await fixture(t);const contactId=f.saved[0].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期住在高雄。'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.contacts.setReading(false);
 const external=supplier({negative:true});let memory;const model=modelPort(()=>memory.accounting,external.respond);memory=new SqliteMemoryExtraction(f.storage,owner,model);t.after(()=>memory.close());
 const started=await memory.start('source-insufficient-is-not-empty-success');await memory.waitForIdle();const done=await memory.read(started.runId);
 assert.equal(done.total,1);assert.equal(done.succeeded,0);assert.equal(done.failed,1);assert.equal(done.unknown,0);assert.equal(done.candidates.length,0);
 const task=done.tasks.find(task=>task.scopeKind==='contact');assert.equal(task.state,'failed');assert.equal(task.errorCode,'memory_extraction_source_insufficient',JSON.stringify({task,calls:model.calls,trace:(await memory.trace(task.taskId)).events.map(event=>event.kind)}));
 const trace=await memory.trace(task.taskId);assert.equal(model.calls,2);assert.ok(trace.calls.every(call=>call.state==='succeeded'));
 const verification=trace.events.find(event=>event.kind==='verification');assert.ok(verification);assert.equal(verification.payload.result.verification_mode,'complete-claim-v1');
 assert.equal(verification.payload.result.model_verdict,'supported');assert.equal(verification.payload.result.verdict,'uncertain');assert.equal(verification.payload.result.claim_validation.semantic_support,'uncertain');
 assert.ok(trace.events.some(event=>event.kind==='extraction_return'));assert.ok(trace.events.some(event=>event.kind==='verification_return'));
 assert.equal(trace.events.some(event=>event.kind==='stage_result'&&event.payload.outcome==='no_new_memory'),false);
 assert.equal(trace.events.some(event=>event.kind==='verified_output'),false);
 assert.equal(done.laterStages,'pending');assert.notEqual(done.state,'completed');assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
