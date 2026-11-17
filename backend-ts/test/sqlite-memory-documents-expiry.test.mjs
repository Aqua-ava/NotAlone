import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {modelPort} from './fixtures/memory-sqlite/support.mjs';
import {supplier} from './fixtures/memory-management/supplier.mjs';
import {adjudicationSupplier} from './fixtures/memory-management/adjudication-support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryAdjudication} from '../src/memory/sqlite/management/adjudication-service.ts';
import {SqliteMemoryDocuments} from '../src/memory/sqlite/documents/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';

const initial=Date.parse('2026-01-01T12:00:00Z');
const expiry='2026-01-02T00:00:00Z';
const expiredText='合成花茶';
const first='我在2026-01-02T00:00:00Z之前只喝合成花茶。';
const second='我平时喜欢合成绿茶。';

function documentSupplier(calls){
 return async(request,input)=>{
  const names=request.tools.map(tool=>tool.name),payload=JSON.parse(request.messages[0].content[0].text);
  calls.push({contactId:input.scope.contact_id,messages:structuredClone(request.messages)});
  const memory=payload.memories.find(item=>String(item.text??item.verbatim_text).includes('合成绿茶'))??payload.memories[0];
  const tool=(name,args)=>({blocks:[{type:'tool-call',id:`synthetic-${calls.length}`,name,arguments:JSON.stringify(args)}]});
  if(names.includes('ScenarioVerificationOutput'))return tool('ScenarioVerificationOutput',{results:payload.proposal.scenarios.flatMap((scene,si)=>scene.paragraphs.map((paragraph,pi)=>({scenario_index:si,paragraph_index:pi,supported:true,evidence:paragraph.references.map(ref=>({memory_id:ref.memory_id,quote:payload.memories.find(item=>item.memory_id===ref.memory_id).text}))})))});
  if(names.includes('ProfileVerificationOutput'))return tool('ProfileVerificationOutput',{results:payload.proposal.entries.map((entry,entry_index)=>({entry_index,supported:true,evidence:entry.references.map(ref=>({memory_id:ref.memory_id,quote:payload.memories.find(item=>item.memory_id===ref.memory_id).verbatim_text}))}))});
  if(payload.layer==='l2')return request.messages.length===1?tool('write',{path:memory.text.includes('合成绿茶')?'green.md':'flower.md',content:`<!-- META ${JSON.stringify({topic_key:memory.text.includes('合成绿茶')?'green':'flower',title:'合成饮品',hint:'合成偏好'})} -->\n\n${memory.text}\n<!-- SOURCES ${JSON.stringify([{memory_id:memory.memory_id,revision:memory.revision}])} -->`}):{blocks:[]};
  if(payload.layer==='l3')return request.messages.length===1?tool('write',{path:'profile.md',content:`# 长期背景\n\n<!-- ENTRY ${JSON.stringify({kind:'fact',section:'interests',basis:'合成记忆记载。',temporal_status:'historical',uncertainty:'',references:[{memory_id:memory.memory_id,revision:memory.revision}]})} -->\n${memory.text}`}):tool('ProfileProposalComplete',{});
  throw new Error('unexpected synthetic document call');
 };
}

test('过期记忆及其文档不进入页面、回复材料或后续整理',{timeout:30000},async t=>{
 t.mock.timers.enable({apis:['Date'],now:initial});
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-documents-expiry/registry.mjs',import.meta.url).href,synchronizeHistory:false,
  content:async request=>{
   const match=JSON.stringify(request).match(/\[(\d+)\] (?:document|memory|entry|coverage)\\n/);
   return JSON.stringify({candidates:[{parts:['合成候选'],basis:[Number(match?.[1]??1)]}]});
  }});
 await f.storage.execute('fixture.setTime',{time:initial});
 const contactId=f.ids[0];let records=[{partition:'shard-a',table:'table-instance-1',localId:'1',serverId:'0',sender:'contact',kind:'text',text:first,originalType:'1',sentAt:String(initial),timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified'}];
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records,completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.history.synchronize(contactId);await f.contacts.setReading(false);
 const base=supplier(),documentCalls=[],adjudicationCalls=[];let extraction;
 const extract=async(request,input)=>{
  if(request.purpose!=='extraction')return base.respond(request,input);
  const payload=JSON.parse(request.user),filtered={...payload,messages:payload.messages.filter(message=>payload.target_message_ids.includes(message.message_id))};
  const result=await base.respond({...request,user:JSON.stringify(filtered),validateOutput:()=>{}},input);
  const value=JSON.parse(result.blocks[0].arguments);
  for(const scene of value.scenes)for(const memory of scene.memories)if(memory.text.includes(expiredText))memory.invalid_at=expiry;
  const blocks=[{...result.blocks[0],arguments:JSON.stringify(value)}];await request.validateOutput(blocks);return {blocks};
 };
 const adjudicate=adjudicationSupplier();
 const adjudication=new SqliteMemoryAdjudication(f.storage,f.owner,modelPort(()=>extraction.accounting,async(request,input)=>{adjudicationCalls.push({purpose:request.purpose,user:request.user});return adjudicate(request,input);}),f.holders);
 const documents=new SqliteMemoryDocuments(f.storage,f.owner,modelPort(()=>extraction.accounting,documentSupplier(documentCalls)),f.holders);
 extraction=new SqliteMemoryExtraction(f.storage,f.owner,modelPort(()=>extraction.accounting,extract),f.holders,async runId=>{await adjudication.publishRun(runId);await documents.publishRun(runId);});
 const service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});
 t.after(async()=>{await turns.close();await extraction.close();await adjudication.close();await documents.close();});
 const run=await extraction.start('expiry-first-run');await extraction.waitForIdle();
 const complete=await extraction.read(run.runId),fact=complete.candidates.find(item=>item.body.includes(expiredText));
 assert.equal(fact?.fact.invalid_at,expiry,'08 必须保存真实有效期');
 assert.equal(complete.state,'completed',JSON.stringify(complete));
 const scope={scopeKind:'contact',contactId},before=await documents.read(scope);
 assert.equal(before.publication.members.length,2);assert.ok(before.documents.every(doc=>JSON.stringify(doc).includes(expiredText)));
 const discussion=await f.discussions.newDiscussion(contactId),knowledgeScope={ownerId:f.owner,contactId,discussionId:discussion.id};
 const initialKnowledge=await f.storage.execute('fixture.knowledge',knowledgeScope);
 assert.equal(initialKnowledge.filter(item=>item.kind==='document').length,2);
 assert.ok(initialKnowledge.some(item=>item.kind==='memory'&&item.text.includes(expiredText)));

 const afterExpiry=Date.parse(expiry)+1000;t.mock.timers.setTime(afterExpiry);await f.storage.execute('fixture.setTime',{time:afterExpiry});
 await t.test('页面不再展示依赖过期记忆的文档与依据',async()=>{
  const view=await documents.read(scope);
  assert.ok(!JSON.stringify(view.documents).includes(expiredText),'页面仍展示过期记忆的派生文档');
 });
 await t.test('12 准备回复的材料不再包含过期记忆及文档',async()=>{
  const items=await f.storage.execute('fixture.knowledge',knowledgeScope);
  assert.ok(!JSON.stringify(items,(_key,value)=>typeof value==='bigint'?String(value):value).includes(expiredText),'回复材料仍包含过期记忆或派生文档');
 });
 await t.test('回复生成的实际模型输入不含过期资料',async()=>{
  await turns.generate({contactId,discussionId:discussion.id,requestKey:randomUUID(),text:'写一句简短问候',confirmedContact:true,contextMessageIds:[]});
  assert.ok(f.requests.length>0,'必须执行真实12回复准备');
  assert.ok(!JSON.stringify(f.requests.at(-1)).includes(expiredText),'回复模型仍收到过期记忆或派生文档');
 });
 // 添加一条无期限的合法记忆，使下一轮确实需要经 08 模型比较。
 await new SqliteMemoryManagement(f.storage,f.owner).decide({requestKey:'expiry-valid-prior',action:'manual',scope,body:'联系人平时喜欢合成乌龙茶。'});
 const priorCalls=documentCalls.length,priorAdjudicationCalls=adjudicationCalls.length;
 records=[...records,{...records[0],localId:'2',text:second,sentAt:String(afterExpiry)}];
 await f.contacts.setReading(true);await f.history.synchronize(contactId);await f.contacts.setReading(false);
 const next=await extraction.start('expiry-next-run');await extraction.waitForIdle();
 const result=await extraction.read(next.runId);
 assert.ok(result.candidates.some(item=>item.body.includes('合成绿茶')),'必须先证明新资料经过正常提取');
 await t.test('后续 08 裁决的实际模型输入不含过期记忆',async()=>{
  const subsequent=adjudicationCalls.slice(priorAdjudicationCalls);
  assert.ok(subsequent.length>0,'必须实际执行新资料与仍有效记忆的裁决');
  assert.ok(!subsequent.some(call=>call.user.includes(expiredText)),'08 裁决仍向模型发送过期记忆');
 });
 await t.test('后续记忆整理不发送过期记忆或文档',async()=>{
  const subsequent=documentCalls.slice(priorCalls).filter(call=>call.contactId===contactId);
  assert.ok(!subsequent.some(call=>JSON.stringify(call.messages).includes(expiredText)),'后续整理仍向模型发送过期记忆或文档');
 });
});

test('待确认候选按半开有效期进入裁决，未知时间保持可用且管理页可回看',{timeout:20000},async t=>{
 t.mock.timers.enable({apis:['Date'],now:initial});
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-documents-expiry/registry.mjs',import.meta.url).href,synchronizeHistory:false});
 await f.storage.execute('fixture.setTime',{time:initial});
 const contactId=f.ids[0],baseRecord={partition:'shard-a',table:'table-instance-1',serverId:'0',sender:'contact',kind:'text',originalType:'1',sentAt:String(initial),timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified'};
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[
  {...baseRecord,localId:'1',text:first},
  {...baseRecord,localId:'2',text:'我喜欢合成红茶。'},
  {...baseRecord,localId:'3',text:'我从2026-01-02T00:00:00Z起喝合成白茶。'},
 ],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.history.synchronize(contactId);await f.contacts.setReading(false);
 const base=supplier();let extraction;
 const respond=async(request,input)=>{
  if(request.purpose!=='extraction')return base.respond(request,input);
  const result=await base.respond({...request,validateOutput:()=>{}},input),value=JSON.parse(result.blocks[0].arguments);
  for(const scene of value.scenes)for(const memory of scene.memories){
   if(memory.text.includes('合成花茶'))memory.invalid_at=expiry;
   if(memory.text.includes('合成白茶'))memory.valid_at=expiry;
  }
  const blocks=[{...result.blocks[0],arguments:JSON.stringify(value)}];await request.validateOutput(blocks);return {blocks};
 };
 extraction=new SqliteMemoryExtraction(f.storage,f.owner,modelPort(()=>extraction.accounting,respond),f.holders);
 t.after(()=>extraction.close());
 const run=await extraction.start('expiry-pending-candidates');await extraction.waitForIdle();
 const management=new SqliteMemoryManagement(f.storage,f.owner);await management.importRun(run.runId);
 const scope={scopeKind:'contact',contactId},view=await management.read(scope);
 assert.equal(view.candidates.filter(candidate=>candidate.state==='pending').length,3);
 const texts=async()=>{const times=await f.storage.execute('fixture.candidateTimes',{ownerId:f.owner,candidateIds:view.candidates.map(candidate=>candidate.id)});return view.candidates.filter(candidate=>times.some(time=>time.candidateId===candidate.id&&time.status==='eligible')).map(candidate=>candidate.body).sort();};
 assert.deepEqual(await texts(),['联系人在2026-01-02T00:00:00Z之前只喝合成花茶。','联系人喜欢合成红茶。'].sort());
 const boundary=Date.parse(expiry);t.mock.timers.setTime(boundary);await f.storage.execute('fixture.setTime',{time:boundary});
 assert.deepEqual(await texts(),['联系人从2026-01-02T00:00:00Z起喝合成白茶。','联系人喜欢合成红茶。'].sort());
 assert.equal((await management.read(scope)).candidates.filter(candidate=>candidate.state==='pending').length,3,'管理页保留全部仍有合法来源的候选供回看');
 await management.decide({requestKey:'expiry-pending-valid-prior',action:'manual',scope,body:'联系人喜欢合成乌龙茶。'});
 const calls=[],adjudicate=adjudicationSupplier();
 const adjudication=new SqliteMemoryAdjudication(f.storage,f.owner,modelPort(()=>extraction.accounting,async(request,input)=>{calls.push(request.user);return adjudicate(request,input);}),f.holders);
 t.after(()=>adjudication.close());await adjudication.publishRun(run.runId);
 assert.ok(calls.length>0,'仍有效的候选需要实际调用裁决模型');
 assert.ok(calls.every(input=>!input.includes(expiredText)),'过期候选不能进入裁决模型');
 assert.equal((await management.read(scope)).candidates.find(candidate=>candidate.body.includes(expiredText)).state,'pending');
});

for(const action of ['correct','change'])test(`有时间限制的记忆经${action}改写后待时间核验且不进入09或12`,{timeout:30000},async t=>{
 t.mock.timers.enable({apis:['Date'],now:initial});
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-documents-expiry/registry.mjs',import.meta.url).href,synchronizeHistory:false,
  content:async()=>JSON.stringify({candidates:[{parts:['合成候选'],basis:[1]}]})});
 await f.storage.execute('fixture.setTime',{time:initial});
 const contactId=f.ids[0],scope={scopeKind:'contact',contactId};
 let records=[{partition:'shard-a',table:'table-instance-1',localId:'1',serverId:'0',sender:'contact',kind:'text',text:first,originalType:'1',sentAt:String(initial),timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified'}];
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records,completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.history.synchronize(contactId);await f.contacts.setReading(false);
 const base=supplier(),calls=[];let extraction;
 const extract=async(request,input)=>{
  if(request.purpose!=='extraction')return base.respond(request,input);
  const payload=JSON.parse(request.user),filtered={...payload,messages:payload.messages.filter(message=>payload.target_message_ids.includes(message.message_id))};
  const result=await base.respond({...request,user:JSON.stringify(filtered),validateOutput:()=>{}},input),value=JSON.parse(result.blocks[0].arguments);
  for(const scene of value.scenes)for(const memory of scene.memories)if(memory.text.includes(expiredText))memory.invalid_at=expiry;
  const blocks=[{...result.blocks[0],arguments:JSON.stringify(value)}];await request.validateOutput(blocks);return {blocks};
 };
 const adjudication=new SqliteMemoryAdjudication(f.storage,f.owner,modelPort(()=>extraction.accounting,adjudicationSupplier()),f.holders);
 const documents=new SqliteMemoryDocuments(f.storage,f.owner,modelPort(()=>extraction.accounting,documentSupplier(calls)),f.holders);
 extraction=new SqliteMemoryExtraction(f.storage,f.owner,modelPort(()=>extraction.accounting,extract),f.holders,async runId=>{await adjudication.publishRun(runId);await documents.publishRun(runId);});
 const service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});
 t.after(async()=>{await turns.close();await extraction.close();await adjudication.close();await documents.close();});
 const firstRun=await extraction.start(`expiry-correction-${action}`);await extraction.waitForIdle();
 assert.equal((await extraction.read(firstRun.runId)).state,'completed');
 assert.ok((await documents.read(scope)).documents.some(doc=>JSON.stringify(doc).includes(expiredText)));
 const management=new SqliteMemoryManagement(f.storage,f.owner),memory=(await management.read(scope)).memories.find(item=>item.current?.body.includes(expiredText));
 const edited=`联系人在2026-01-02T00:00:00Z之前喝合成花茶，用户另作${action}。`;
 await management.decide({requestKey:`expiry-${action}`,action,memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body:edited});
 let view=await management.read(scope),editedMemory=view.memories.find(item=>item.id===memory.id);
 assert.equal(editedMemory.current.body,edited,'改写版仍须在管理页可回看');
 assert.equal(editedMemory.current.timeStatus,'needs_revalidation','未核验的新版本不可继承或洗掉已知旧期限');
 assert.equal((await management.readHistory(scope,memory.id)).versions[0].timeStatus,'eligible','有明确期限的原版在到期前仍有效');
 await management.decide({requestKey:`expiry-chain-${action}`,action:'change',memoryId:memory.id,expectedVersionNo:editedMemory.current.versionNo,expectedHeadRevision:editedMemory.headRevision,body:`${edited}再记录变化。`});
 editedMemory=(await management.read(scope)).memories.find(item=>item.id===memory.id);
 assert.equal(editedMemory.current.timeStatus,'needs_revalidation','连续改写仍依赖受限前驱');
 const discussion=await f.discussions.newDiscussion(contactId),query={ownerId:f.owner,contactId,discussionId:discussion.id};
 const knowledge=await f.storage.execute('fixture.knowledge',query);
 assert.ok(!knowledge.some(item=>item.text.includes(expiredText)),'未经核验的改写和旧文档不能进入12材料');
 assert.ok(!(await documents.read(scope)).documents.some(doc=>JSON.stringify(doc).includes(expiredText)),'旧发布集合不能继续显示为有效');
 const afterExpiry=Date.parse(expiry)+1000;t.mock.timers.setTime(afterExpiry);await f.storage.execute('fixture.setTime',{time:afterExpiry});
 editedMemory=(await management.read(scope)).memories.find(item=>item.id===memory.id);
 assert.equal(editedMemory.current.timeStatus,'needs_revalidation','旧期限过后仍须核验新版本，而非把旧期限当作新事实');
 assert.equal((await management.readHistory(scope,memory.id)).versions[0].timeStatus,'out_of_window');
 assert.ok(!(await f.storage.execute('fixture.knowledge',query)).some(item=>item.text.includes(expiredText)));
 // 没有已知受限前驱的独立手录及其修正保持未知，不因本门禁被排除。
 const manual=await management.decide({requestKey:`expiry-manual-${action}`,action:'manual',scope,body:'联系人喜欢合成麦茶。'});
 let independent=(await management.read(scope)).memories.find(item=>item.id===manual.memoryId);
 await management.decide({requestKey:`expiry-manual-edit-${action}`,action:'correct',memoryId:independent.id,expectedVersionNo:independent.current.versionNo,expectedHeadRevision:independent.headRevision,body:'联系人喜欢合成麦茶和清茶。'});
 independent=(await management.read(scope)).memories.find(item=>item.id===manual.memoryId);
 assert.equal(independent.current.timeStatus,'eligible');
 assert.ok((await f.storage.execute('fixture.knowledge',query)).some(item=>item.text.includes('合成麦茶')));
 await turns.generate({contactId,discussionId:discussion.id,requestKey:randomUUID(),text:'写一句简短问候',confirmedContact:true,contextMessageIds:[]});
 assert.ok(f.requests.length>0);assert.ok(!JSON.stringify(f.requests.at(-1)).includes(expiredText),'实际12输入不可包含待核验改写');
 const beforeCalls=calls.length;
 records=[...records,{...records[0],localId:'2',text:second,sentAt:String(initial+1000)}];
 await f.contacts.setReading(true);await f.history.synchronize(contactId);await f.contacts.setReading(false);
 const next=await extraction.start(`expiry-correction-next-${action}`);await extraction.waitForIdle();
 assert.ok((await extraction.read(next.runId)).candidates.some(item=>item.body.includes('合成绿茶')));
 assert.ok(calls.slice(beforeCalls).every(call=>!JSON.stringify(call.messages).includes(expiredText)),'后续09请求不可包含待核验改写');
});
