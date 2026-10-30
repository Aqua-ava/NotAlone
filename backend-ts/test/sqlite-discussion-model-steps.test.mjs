import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {skillAnchor} from '../src/skills/sqlite/library.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';

const budget={provider:'synthetic-official',model:'synthetic-model',maxTokens:512,input_tokens:12,serialized_bytes:128,measurement_kind:'approximate',measurement_id:'synthetic-estimate',request_sha256:'a'.repeat(64)};
async function prepared(t){
 const f=await fixture(t),contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId),requestKey=randomUUID();
 const confirmationId=await f.storage.execute('identity.manualConfirm',{ownerId:f.owner,contactId,contextToken:requestKey,id:randomUUID(),at:Date.now()});
 const {attempt}=await f.discussions.begin(contactId,requestKey,'合成多步骤请求',{kind:'manual',confirmationId},d.id);
 const input={...attempt,contextId:randomUUID(),callId:randomUUID()},skillRun={packages:[],eligible:[]};
 await f.storage.execute('discussion.freezeContext',{...input,skillRun,items:[],at:Date.now()});
 await f.storage.execute('discussion.prepareCall',{...input,operationId:randomUUID(),provider:budget.provider,requestKey:input.callId,inputSeal:'b'.repeat(64),model:budget.model,configurationId:'c'.repeat(64),inputCap:1024,outputCap:512});
 return {...f,input,skillRun};
}
async function withinRuntime(f,work){
 const stopped=new Error('合成存储边界检查结束');
 await assert.rejects(f.runtime.run(f.input,'c'.repeat(64),async run=>{
  const input={...f.input,copyId:run.copy.id};
  await f.storage.execute('runtime.incorporate',input);
  await work(input);
  throw stopped;
 }),error=>error===stopped);
}

test('同一回复的每次物理出站独立记录输入与用量，末调用不覆盖首调用',async t=>{
 const f=await prepared(t);
 await withinRuntime(f,async input=>{
  const second=randomUUID();
  await f.storage.execute('discussion.dispatchCall',{...input,physicalCallId:input.callId,skillRun:f.skillRun,budget,requestPayload:{messages:['选择合成策略']}});
  await f.storage.execute('discussion.settleStep',{...input,physicalCallId:input.callId,usage:{inputTokens:7,outputTokens:2},seq:1,reason:'tool-calls'});
  await f.storage.execute('discussion.dispatchCall',{...input,physicalCallId:second,skillRun:f.skillRun,budget,requestPayload:{messages:['已加载的合成策略']}});
  await f.storage.execute('discussion.settleStep',{...input,physicalCallId:second,usage:{inputTokens:15,outputTokens:4},seq:2,reason:'stop'});
  const event={type:'assistant/message',seq:2,data:{message:{source:{provider:budget.provider,model:budget.model},content:[{type:'text',text:'合成最终讨论'}]},usage:{inputTokens:15,outputTokens:4},interrupted:false}};
  await f.storage.execute('discussion.commitAssistant',{...input,physicalCallId:second,skillRun:f.skillRun,text:'合成最终讨论',sessionEvent:event});
  const trace=await f.discussions.trace(input.contactId,input.discussionId,input.requestId);
  assert.equal(trace.calls.length,2);assert.ok(trace.calls.every(call=>call.state==='succeeded'));
  assert.deepEqual(trace.calls.map(call=>call.actual_budget_units),[9n,19n]);
  assert.deepEqual(trace.events.filter(e=>e.kind==='model_request').map(e=>e.originated_call_id),[input.callId,second]);
  assert.deepEqual(trace.events.filter(e=>e.kind==='model_step_receipt').map(e=>JSON.parse(e.payload).usage),[{inputTokens:7,outputTokens:2},{inputTokens:15,outputTokens:4}]);
 });
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

async function preparedReply(t,options={}){
 const f=await fixture(t,options),contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId),requestKey=randomUUID();
 if(options.knowledge)await f.storage.execute('synthetic.publishReplyKnowledge',{ownerId:f.owner,contactId,sourceContactId:contactId,mode:'document'});
 const service=new SqliteReplyCandidateService(f.storage,f.owner),confirmationId=await f.storage.execute('identity.manualConfirm',{ownerId:f.owner,contactId,contextToken:requestKey,id:randomUUID(),at:Date.now()});
 const {attempt}=await service.begin({contactId,discussionId:d.id,requestKey,text:'合成候选降级请求',identity:{kind:'manual',confirmationId}});
 const input={...attempt,contextId:randomUUID(),callId:randomUUID()},skillRun={packages:[],eligible:[]};
 const messages=await f.storage.execute('discussion.messages',{...attempt,messageIds:f.messages[0].map(message=>message.id)});
 await f.storage.execute('reply.freezeInput',{...input,skillRun,items:messages.map(message=>({kind:'message',sourceContactId:contactId,messageId:message.id,recordId:message.record_id,acceptedRevision:message.interpretation_revision})),at:Date.now()});
 await f.storage.execute('discussion.prepareCall',{...input,operationId:randomUUID(),provider:budget.provider,requestKey:input.callId,inputSeal:'b'.repeat(64),model:budget.model,configurationId:'c'.repeat(64),inputCap:1024,outputCap:512});
 return {...f,input,skillRun,service};
}

test('候选降级复制原编号资料与来源，新候选依据仍可核验且通用入口不能绕过候选保护',async t=>{
 const f=await preparedReply(t);
 await assert.rejects(f.storage.execute('discussion.dropSkill',f.input),{code:'discussion_skill_fallback_scope'});
 const fallback=await f.storage.execute('reply.dropSkill',f.input);f.input={...f.input,contextId:fallback.contextId};f.skillRun=fallback.newRevision;
 await f.storage.execute('reply.assertInput',{...f.input});
 await withinRuntime(f,async input=>{
  const text=JSON.stringify({candidates:[{parts:['无Skill的合成候选'],basis:[1]}]});
  await f.storage.execute('discussion.dispatchCall',{...input,skillRun:f.skillRun,budget,requestPayload:{messages:['仅含仍合法的合成资料']}});
  await f.storage.execute('discussion.settleStep',{...input,usage:{inputTokens:5,outputTokens:3},reason:'stop'});
  await f.storage.execute('reply.commitCandidates',{...input,skillRun:f.skillRun,text,sessionEvent:{type:'assistant/message',seq:1,data:{message:{source:{provider:budget.provider,model:budget.model},content:[{type:'text',text}]},usage:{inputTokens:5,outputTokens:3},interrupted:false}}});
 });
 const view=(await f.service.view(f.input.contactId,f.input.discussionId))[0];
 assert.equal(view.candidates[0].basis[0].itemNo,1);assert.equal(view.candidates[0].basis[0].verification,'actual_input');
 assert.match(view.candidates[0].basis[0].text,/已保存聊天/);assert.equal(f.requests.length,0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('精确知识资料撤销时，降级不能建立新上下文',async t=>{
 const registryModule=new URL('./fixtures/sqlite-reply-candidates/knowledge-registry.mjs',import.meta.url).href;
 const f=await preparedReply(t,{registryModule,knowledge:true});
 await f.storage.execute('synthetic.invalidateReplyKnowledge',{ownerId:f.owner});
 await assert.rejects(f.storage.execute('reply.dropSkill',f.input),{code:'reply_input_stale'});
 assert.deepEqual((await f.discussions.trace(f.input.contactId,f.input.discussionId,f.input.requestId)).events,[]);
 assert.equal(f.requests.length,0);
});

test('本次生成取消时，降级不能恢复已失效的请求',async t=>{
 const f=await preparedReply(t);
 await f.storage.execute('discussion.cancel',{...f.input,at:Date.now()});
 await assert.rejects(f.storage.execute('reply.dropSkill',f.input));
 assert.equal(f.requests.length,0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('有界物理调用要求前一步已结算，至多五次且取消不重写已确认用量',async t=>{
 const f=await prepared(t);
 await withinRuntime(f,async input=>{
  await f.storage.execute('discussion.dispatchCall',{...input,skillRun:f.skillRun,budget,requestPayload:{messages:['第一步']}});
  await assert.rejects(f.storage.execute('discussion.dispatchCall',{...input,physicalCallId:randomUUID(),skillRun:f.skillRun,budget,requestPayload:{messages:['不得抢先']}}),{code:'discussion_step_not_settled'});
  await f.storage.execute('discussion.settleStep',{...input,usage:{inputTokens:1,outputTokens:1},reason:'tool-calls'});
  for(let index=2;index<=5;index++){
   const physicalCallId=randomUUID();
   await f.storage.execute('discussion.dispatchCall',{...input,physicalCallId,skillRun:f.skillRun,budget,requestPayload:{messages:[`合成步骤${index}`]}});
   await f.storage.execute('discussion.settleStep',{...input,physicalCallId,usage:{inputTokens:index,outputTokens:1},reason:'tool-calls'});
  }
  await assert.rejects(f.storage.execute('discussion.dispatchCall',{...input,physicalCallId:randomUUID(),skillRun:f.skillRun,budget,requestPayload:{messages:['第六步不得出站']}}),{code:'discussion_call_limit'});
  await f.storage.execute('discussion.failCall',{...input,dispatched:true});
  const trace=await f.discussions.trace(input.contactId,input.discussionId,input.requestId);
  assert.equal(trace.calls.length,5);assert.ok(trace.calls.every(call=>call.state==='succeeded'&&call.settlement_state==='settled'));
  assert.deepEqual(trace.calls.map(call=>call.actual_budget_units),[2n,3n,4n,5n,6n]);
 });
});

test('Skill失效后仅从仍有效的非Skill输入建立新上下文，旧修订与选择不能恢复',async t=>{
 const f=await fixture(t);await mkdir(join(f.skillRoot,'gentle'));
 await writeFile(join(f.skillRoot,'gentle/SKILL.md'),'---\nname: gentle\ndescription: 合成策略\n---\n合成策略正文。\n');
 let skill=await f.library.discover('gentle');skill=await f.library.setEnabled(skill.id,skill.headRevision,'enabled');
 const contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId),requestKey=randomUUID();
 const confirmationId=await f.storage.execute('identity.manualConfirm',{ownerId:f.owner,contactId,contextToken:requestKey,id:randomUUID(),at:Date.now()});
 const {attempt}=await f.discussions.begin(contactId,requestKey,'技能失效的合成请求',{kind:'manual',confirmationId},d.id);
 const input={...attempt,contextId:randomUUID(),callId:randomUUID()},anchor=skillAnchor(skill),skillRun={packages:[{id:skill.id,headRevision:skill.headRevision}],eligible:[anchor]};
 await f.storage.execute('discussion.freezeContext',{...input,skillRun,items:[],at:Date.now()});
 await f.storage.execute('discussion.prepareCall',{...input,operationId:randomUUID(),provider:budget.provider,requestKey:input.callId,inputSeal:'b'.repeat(64),model:budget.model,configurationId:'c'.repeat(64),inputCap:1024,outputCap:512});
 await f.storage.execute('discussion.skillSelection',{...input,selected:anchor});
 await f.library.setEnabled(skill.id,skill.headRevision,'disabled');
 const fallback=await f.storage.execute('discussion.dropSkill',input);
 assert.notEqual(fallback.contextId,input.contextId);assert.deepEqual(fallback.newRevision.eligible,[]);
 await f.storage.execute('discussion.assertSkillCall',{...input,contextId:fallback.contextId,runRevision:fallback.newRevision});
 await assert.rejects(f.storage.execute('discussion.assertSkillCall',{...input,runRevision:skillRun}));
 const trace=await f.discussions.trace(contactId,d.id,input.requestId);
 assert.deepEqual(trace.events.map(e=>e.kind),['skill_unavailable']);
 assert.equal(trace.events.some(e=>e.payload.includes('合成策略正文')),false);
 await assert.rejects(f.storage.execute('discussion.dropSkill',{...input,contextId:fallback.contextId}),{code:'discussion_skill_fallback_used'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
