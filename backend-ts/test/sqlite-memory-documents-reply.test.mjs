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
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';

function documentSupplier({rejectProfile=false,structuredProfile=false,preferText,recordCalls}={}){
 let calls=0;
 return async (request,input)=>{
  calls++;const names=request.tools.map(item=>item.name),payload=JSON.parse(request.messages[0].content[0].text),memory=payload.memories.find(item=>preferText&&String(item.text??item.verbatim_text).includes(preferText))??payload.memories[0];
  recordCalls?.push({contactId:input.scope.contact_id,stepId:input.claim.step_id,taskId:input.claim.task_id,messages:structuredClone(request.messages)});
  const tool=(name,args)=>({blocks:[{type:'tool-call',id:`document-${calls}`,name,arguments:JSON.stringify(args)}]});
  if(names.includes('ScenarioVerificationOutput'))return tool('ScenarioVerificationOutput',{results:payload.proposal.scenarios.flatMap((scene,si)=>scene.paragraphs.map((paragraph,pi)=>({scenario_index:si,paragraph_index:pi,supported:true,evidence:paragraph.references.map(ref=>({memory_id:ref.memory_id,quote:payload.memories.find(item=>item.memory_id===ref.memory_id).text}))})))});
  if(names.includes('ProfileVerificationOutput'))return tool('ProfileVerificationOutput',{results:payload.proposal.entries.map((entry,entry_index)=>({entry_index,supported:!rejectProfile,evidence:rejectProfile?[]:entry.references.map(ref=>({memory_id:ref.memory_id,quote:payload.memories.find(item=>item.memory_id===ref.memory_id).verbatim_text}))}))});
  if(payload.layer==='l2')return request.messages.length===1?tool('write',{path:'topic.md',content:`<!-- META ${JSON.stringify({topic_key:'synthetic-topic',title:'合成主题',hint:'已核验的合成资料'})} -->\n\n${memory.text}\n<!-- SOURCES ${JSON.stringify([{memory_id:memory.memory_id,revision:memory.revision}])} -->`}):{blocks:[]};
  if(payload.layer==='l3'){
   if(request.messages.length!==1)return tool('ProfileProposalComplete',{});
   const reference=m=>({memory_id:m.memory_id,revision:m.revision});
   const entries=structuredProfile&&payload.memories.length>=2?[
    {meta:{kind:'inference',section:'insights',basis:'合成资料中提到相关偏好。',temporal_status:'uncertain',uncertainty:'仅为推断。',references:[reference(memory)]},text:'可能重视合成饮品。'},
    {meta:{kind:'contradiction',section:'contradictions',basis:'两条合成资料描述不一致。',temporal_status:'uncertain',uncertainty:'尚未厘清。',references:payload.memories.slice(0,2).map(reference)},text:'对合成绿茶的偏好仍有矛盾。'},
   ]:[{meta:{kind:'fact',section:'interests',basis:'正式记忆直接记载。',temporal_status:'stable',uncertainty:'',references:[reference(memory)]},text:memory.text}];
   return tool('write',{path:'profile.md',content:'# 长期背景\n\n'+entries.map(entry=>`<!-- ENTRY ${JSON.stringify(entry.meta)} -->\n${entry.text}`).join('\n\n')});
  }
  throw new Error('unexpected synthetic document call');
 };
}
function itemNumber(value,kind='document'){
 if(typeof value==='string'){const match=value.match(new RegExp(`\\[(\\d+)\\] ${kind}\\n`,'u'));return match?Number(match[1]):null;}
 if(value&&typeof value==='object')for(const item of Object.values(value)){const found=itemNumber(item,kind);if(found!==null)return found;}
 return null;
}
async function setup(t,options={}){
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-documents-reply/registry.mjs',import.meta.url).href,synchronizeHistory:false,
  content:async request=>{await options.beforeReply?.(request);const basis=itemNumber(request)??(options.allowNoDocument?itemNumber(request,'memory'):null);assert.ok(basis,'模型输入必须包含编号的合法资料');return JSON.stringify({candidates:[{parts:['结合资料的合成候选'],basis:[basis]}]});}});
 const page=f.channel.page,directory=await f.contacts.directory(),firstId=[...f.ids].sort()[0],firstLocator=directory.bindings.find(binding=>binding.contact_id===firstId).conversation_locator;
 f.channel.page=async(...args)=>{
  const result=await page(...args),a=args[0].conversationKey===(options.orderAFirst?firstLocator:'a'),base=result.records[0];
  const records=[{...base,text:a?'我长期喜欢合成园艺甲。':'我长期喜欢合成烹饪乙。'}];
  if(options.includeOwner)records.push({...base,localId:'2',sender:'owner',text:options.structuredProfile?(a?'我长期只喜欢合成绿茶。':'我长期不喜欢合成绿茶。'):(a?'我长期喜欢合成音乐甲。':'我长期喜欢合成绿茶乙。')});
  return {...result,records};
 };
 await f.contacts.setReading(true);for(const contactId of f.ids)if(!options.onlyAInitial||contactId===firstId)await f.history.synchronize(contactId);await f.contacts.setReading(false);
 const byText=new Map();for(const contactId of f.ids)for(const message of (await f.history.read(contactId)).messages)byText.set(message.text,contactId);
 const a=options.onlyAInitial?firstId:byText.get('我长期喜欢合成园艺甲。'),b=options.onlyAInitial?f.ids.find(id=>id!==firstId):byText.get('我长期喜欢合成烹饪乙。');assert.ok(a&&b);
 let extraction;
 // 只在并发反例固定08候选裁决顺序；裁决、调用、来源与写入仍走真实服务和事务。
 const adjudicationStorage=options.orderOwnerA?{execute:async(name,input)=>{
  const result=await f.storage.execute(name,input);if(name!=='memory.importRun')return result;
  const {SqliteMemoryManagement}=await import('../src/memory/sqlite/management/service.ts');
  const candidates=(await new SqliteMemoryManagement(f.storage,f.owner).read({scopeKind:'self',contactId:null})).candidates;
  const first=candidates.find(candidate=>candidate.state==='pending'&&candidate.body.includes('音乐甲'))?.id;
  return first?{...result,candidateIds:[...result.candidateIds].sort((x,y)=>(x===first?-1:0)-(y===first?-1:0))}:result;
 }}:f.storage;
 const adjudication=new SqliteMemoryAdjudication(adjudicationStorage,f.owner,modelPort(()=>extraction.accounting,adjudicationSupplier()),f.holders);
 const documents=new SqliteMemoryDocuments(f.storage,f.owner,modelPort(()=>extraction.accounting,documentSupplier({rejectProfile:options.rejectProfile,structuredProfile:options.structuredProfile,preferText:options.preferText,recordCalls:options.recordCalls})),f.holders);
 const extractor=supplier();
 const extract=options.targetOnly?async(request,input)=>{
  if(request.purpose!=='extraction')return extractor.respond(request,input);
  const payload=JSON.parse(request.user);return extractor.respond({...request,user:JSON.stringify({...payload,messages:payload.messages.filter(message=>payload.target_message_ids.includes(message.message_id))})},input);
 }:extractor.respond;
 extraction=new SqliteMemoryExtraction(f.storage,f.owner,modelPort(()=>extraction.accounting,extract),f.holders,async runId=>{await adjudication.publishRun(runId);await documents.publishRun(runId);});
 t.after(async()=>{await extraction.close();await adjudication.close();await documents.close();});
 const run=await extraction.start(`documents-to-reply-${randomUUID()}`);await extraction.waitForIdle();
 const service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 return {...f,a,b,run,documents,extraction,adjudication,service,turns};
}

test('真实08到09完整发布后12候选引用相同文档且不串联系人',{timeout:20000},async t=>{
 const f=await setup(t),scopeA={ownerId:f.owner,contactId:f.a,discussionId:(await f.discussions.newDiscussion(f.a)).id};
 const view=await f.documents.read({scopeKind:'contact',contactId:f.a});assert.equal(view.publication.members.length,2);
 const items=await f.storage.execute('fixture.documentKnowledge',scopeA),docs=items.filter(i=>i.kind==='document');
 assert.equal(items.filter(i=>i.kind==='memory').length,1);assert.equal(docs.length,2);
 assert.deepEqual(new Set(docs.map(d=>`${d.id}:${d.versionNo}`)),new Set(view.publication.members.map(m=>`${m.documentId}:${m.versionNo}`)));
 assert.ok(docs.every(d=>d.publicationId===view.publication.id&&d.contactId===f.a&&d.sources.length>0&&d.sources.every(s=>s.contactId===f.a)));
 const scopeB={ownerId:f.owner,contactId:f.b,discussionId:(await f.discussions.newDiscussion(f.b)).id};
 const other=(await f.storage.execute('fixture.documentKnowledge',scopeB)).filter(i=>i.kind==='document');
 assert.equal(other.length,2);assert.ok(other.every(d=>d.contactId===f.b&&!d.text.includes('园艺甲')));
 await f.turns.generate({contactId:f.a,discussionId:scopeA.discussionId,requestKey:randomUUID(),text:'结合资料写一句',confirmedContact:true});
 const candidate=(await f.service.view(f.a,scopeA.discussionId))[0].candidates[0];
 assert.equal(candidate.basis[0].kind,'document');assert.equal(candidate.basis[0].verification,'actual_input');assert.match(candidate.basis[0].text,/园艺甲/);
 assert.ok(f.requests.length===1);assert.ok(!JSON.stringify(f.requests[0]).includes('烹饪乙'));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('读取复验精确集合与版本，保护修订使旧文档和候选快照失效',{timeout:20000},async t=>{
 const {SqliteMemoryManagement}=await import('../src/memory/sqlite/management/service.ts');
 const f=await setup(t),discussion=await f.discussions.newDiscussion(f.a),scope={ownerId:f.owner,contactId:f.a,discussionId:discussion.id};
 const doc=(await f.storage.execute('fixture.documentKnowledge',scope)).find(item=>item.kind==='document');assert.ok(doc);
 assert.equal(await f.storage.execute('fixture.documentCurrent',{scope,item:doc}),true);
 for(const changed of [
  {...doc,versionNo:doc.versionNo+1n},{...doc,publicationId:randomUUID()},
  {...doc,documentRevision:doc.documentRevision+1n},{...doc,text:`${doc.text}伪造`},{...doc,sources:[]},
 ])await assert.rejects(f.storage.execute('fixture.documentCurrent',{scope,item:changed}),{code:'document_knowledge_stale'});
 const foreign={...scope,contactId:f.b};await assert.rejects(f.storage.execute('fixture.documentCurrent',{scope:foreign,item:doc}),{code:'document_knowledge_stale'});
 await f.turns.generate({contactId:f.a,discussionId:discussion.id,requestKey:randomUUID(),text:'结合资料写一句',confirmedContact:true});
 assert.equal((await f.service.view(f.a,discussion.id))[0].candidates.length,1);
 const management=new SqliteMemoryManagement(f.storage,f.owner),memory=(await management.read({scopeKind:'contact',contactId:f.a})).memories[0];
 await management.decide({requestKey:'protect-document-source',action:'protect',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision});
 await assert.rejects(f.storage.execute('fixture.documentCurrent',{scope,item:doc}),{code:'document_knowledge_stale'});
 assert.equal((await f.storage.execute('fixture.documentKnowledge',scope)).filter(item=>item.kind==='document').length,0);
 const stale=await f.documents.read({scopeKind:'contact',contactId:f.a});assert.equal(stale.publication,null);assert.deepEqual(stale.documents,[]);
 const candidateView=await f.service.view(f.a,discussion.id);assert.equal(candidateView[0].candidates.length,0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('在途回复所依赖的记忆头变化后晚到模型输出不可提交',{timeout:20000},async t=>{
 const {SqliteMemoryManagement}=await import('../src/memory/sqlite/management/service.ts');
 let entered,release;const ready=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>release=resolve);
 const f=await setup(t,{beforeReply:async()=>{entered();await waiting;}}),discussion=await f.discussions.newDiscussion(f.a);
 const pending=f.turns.generate({contactId:f.a,discussionId:discussion.id,requestKey:randomUUID(),text:'结合资料写一句',confirmedContact:true});
 await ready;
 try{
  const management=new SqliteMemoryManagement(f.storage,f.owner),memory=(await management.read({scopeKind:'contact',contactId:f.a})).memories[0];
  await management.decide({requestKey:'protect-before-reply',action:'protect',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision});
 }finally{release();}
 await assert.rejects(pending);const view=await f.service.view(f.a,discussion.id);
 assert.ok(view.every(entry=>entry.candidates.length===0));assert.equal(f.requests.length,1);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('撤销后台读取不会抹掉已完成且来源仍有效的文档',{timeout:20000},async t=>{
 const f=await setup(t),scope={ownerId:f.owner,contactId:f.a,discussionId:(await f.discussions.newDiscussion(f.a)).id};
 const prior=(await f.storage.execute('fixture.documentKnowledge',scope)).filter(item=>item.kind==='document');assert.equal(prior.length,2);
 const binding=(await f.contacts.directory()).bindings.find(item=>item.contact_id===f.a&&item.status==='active');assert.ok(binding);
 await f.contacts.revoke(f.a,binding.binding_id,binding.selection_generation);
 const after=(await f.storage.execute('fixture.documentKnowledge',scope)).filter(item=>item.kind==='document');
 assert.deepEqual(after,prior);assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.a})).publication.members.length,2);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const mode of ['member','input'])test(`完整发布集合${mode==='member'?'缺失成员':'缺失实际输入'}时页面和回复均撤下整组`,{timeout:20000},async t=>{
 const f=await setup(t),scope={ownerId:f.owner,contactId:f.a,discussionId:(await f.discussions.newDiscussion(f.a)).id};
 const before=await f.documents.read({scopeKind:'contact',contactId:f.a}),items=(await f.storage.execute('fixture.documentKnowledge',scope)).filter(item=>item.kind==='document');
 assert.equal(before.publication.members.length,2);assert.equal(items.length,2);
 if(mode==='member')await f.storage.execute('fixture.removeDocumentMember',{ownerId:f.owner,publicationId:before.publication.id});
 else await f.storage.execute('fixture.removeDocumentInput',{ownerId:f.owner,documentId:items[0].id});
 const after=await f.documents.read({scopeKind:'contact',contactId:f.a});assert.equal(after.publication,null);assert.deepEqual(after.documents,[]);
 assert.equal((await f.storage.execute('fixture.documentKnowledge',scope)).filter(item=>item.kind==='document').length,0);
 for(const item of items)await assert.rejects(f.storage.execute('fixture.documentCurrent',{scope,item}),{code:'document_knowledge_stale'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('零成员集合切换也撤销在途回复的旧范围快照',{timeout:20000},async t=>{
 let entered,release;const ready=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>release=resolve);
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-documents-reply/registry.mjs',import.meta.url).href,synchronizeHistory:false,
  content:async()=>{entered();await waiting;return JSON.stringify({candidates:[{parts:['空资料的合成候选'],basis:[1]}]});}});
 const contactId=f.ids[0];await f.contacts.setReading(true);await f.history.synchronize(contactId);await f.contacts.setReading(false);
 let extraction;const adjudication=new SqliteMemoryAdjudication(f.storage,f.owner,undefined,f.holders),documents=new SqliteMemoryDocuments(f.storage,f.owner,undefined,f.holders);
 extraction=new SqliteMemoryExtraction(f.storage,f.owner,modelPort(()=>extraction.accounting),f.holders,async runId=>{await adjudication.publishRun(runId);await documents.publishRun(runId);});
 const service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});
 t.after(async()=>{await turns.close();await extraction.close();await adjudication.close();await documents.close();});
 await extraction.start('first-empty-publication');await extraction.waitForIdle();
 const first=await documents.read({scopeKind:'contact',contactId});assert.equal(first.publication.members.length,0);
 const discussion=await f.discussions.newDiscussion(contactId),pending=turns.generate({contactId,discussionId:discussion.id,requestKey:randomUUID(),text:'只用当前聊天写一句',confirmedContact:true});
 await ready;
 try{
  const page=f.channel.page;f.channel.page=async(...args)=>{const result=await page(...args);return {...result,records:[{...result.records[0],localId:'2',text:'另一条合成聊天。'}]};};
  await f.contacts.setReading(true);await f.history.synchronize(contactId);await f.contacts.setReading(false);
  const secondRun=await extraction.start('second-empty-publication');await extraction.waitForIdle();assert.equal(secondRun.total,1);
  const second=await documents.read({scopeKind:'contact',contactId});assert.equal(second.publication.members.length,0);assert.notEqual(second.publication.id,first.publication.id);
 }finally{release();}
 await assert.rejects(pending);assert.ok((await service.view(contactId,discussion.id)).every(entry=>entry.candidates.length===0));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('本人混合文档保留全部实际贡献来源，回复另一联系人不带对方独立文档',{timeout:20000},async t=>{
 const f=await setup(t,{includeOwner:true}),scope={ownerId:f.owner,contactId:f.b,discussionId:(await f.discussions.newDiscussion(f.b)).id};
 const items=await f.storage.execute('fixture.documentKnowledge',scope),ownerDocs=items.filter(item=>item.kind==='document'&&item.scopeKind==='owner'),contactDocs=items.filter(item=>item.kind==='document'&&item.scopeKind==='contact');
 assert.equal(ownerDocs.length,2);assert.equal(contactDocs.length,2);
 for(const doc of ownerDocs){assert.equal(doc.contactId,null);assert.deepEqual(new Set(doc.sources.map(source=>source.contactId)),new Set([f.a,f.b]));}
 assert.ok(contactDocs.every(doc=>doc.contactId===f.b&&!doc.text.includes('园艺甲')&&doc.sources.every(source=>source.contactId===f.b)));
 await f.turns.generate({contactId:f.b,discussionId:scope.discussionId,requestKey:randomUUID(),text:'结合本人资料写一句',confirmedContact:true});
 const view=await f.service.view(f.b,scope.discussionId);assert.equal(view[0].candidates.length,1);
 const saved=await f.storage.execute('fixture.replyDocumentSources',{ownerId:f.owner,discussionId:scope.discussionId});
 for(const doc of ownerDocs){
  const rows=saved.filter(row=>JSON.parse(row.identity_json).id===doc.id);
  assert.deepEqual(new Set(rows.map(row=>`${row.source_contact_id}:${row.message_id}:${row.record_id}:${row.accepted_revision}`)),new Set(doc.sources.map(source=>`${source.contactId}:${source.messageId}:${source.recordId}:${source.acceptedRevision}`)));
 }
 assert.ok(!JSON.stringify(f.requests[0]).includes('联系人长期喜欢合成园艺甲'));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('画像核验失败时已暂存主题不进入候选输入',{timeout:20000},async t=>{
 const f=await setup(t,{rejectProfile:true,allowNoDocument:true}),scope={ownerId:f.owner,contactId:f.a,discussionId:(await f.discussions.newDiscussion(f.a)).id};
 const task=(await f.extraction.read(f.run.runId)).tasks.find(item=>item.contactId===f.a),state=await f.documents.readTask(task.taskId);
 assert.equal(state.outcome,'incomplete');assert.deepEqual(state.stages.map(s=>s.status),['succeeded','failed']);
 const page=await f.documents.read({scopeKind:'contact',contactId:f.a});assert.equal(page.publication,null);assert.deepEqual(page.documents,[]);
 const knowledge=await f.storage.execute('fixture.documentKnowledge',scope);assert.equal(knowledge.filter(item=>item.kind==='document').length,0);assert.equal(knowledge.filter(item=>item.kind==='memory').length,1);
 await f.turns.generate({contactId:f.a,discussionId:scope.discussionId,requestKey:randomUUID(),text:'结合资料写一句',confirmedContact:true});
 const candidate=(await f.service.view(f.a,scope.discussionId))[0].candidates[0];assert.equal(candidate.basis[0].kind,'memory');assert.equal(itemNumber(f.requests[0]),null);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('真实05来源删除撤销本人混合文档和12候选，保留另一联系人独立集合',{timeout:30000},async t=>{
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts');
 const {ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const f=await setup(t,{includeOwner:true}),scope={ownerId:f.owner,contactId:f.b,discussionId:(await f.discussions.newDiscussion(f.b)).id};
 const before=await f.documents.read({scopeKind:'contact',contactId:f.b}),knowledge=await f.storage.execute('fixture.documentKnowledge',scope);
 assert.equal(before.publication.members.length,2);assert.equal(knowledge.filter(item=>item.kind==='document'&&item.scopeKind==='owner').length,2);
 await f.turns.generate({contactId:f.b,discussionId:scope.discussionId,requestKey:randomUUID(),text:'结合本人资料写一句',confirmedContact:true});
 assert.equal((await f.service.view(f.b,scope.discussionId))[0].candidates.length,1);
 const source=(await f.history.read(f.a)).messages.find(message=>message.text==='我长期喜欢合成音乐甲。').sourceRecordIds[0];
 const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root)),plan=await deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.a,sourceId:source}});
 assert.equal((await f.documents.read({scopeKind:'self',contactId:null})).publication,null);
 assert.equal((await f.storage.execute('fixture.documentKnowledge',scope)).filter(item=>item.kind==='document').length,0);
 assert.ok((await f.service.view(f.b,scope.discussionId)).every(entry=>entry.candidates.length===0));
 const callsBeforeFenceRetry=f.requests.length;
 await assert.rejects(f.turns.generate({contactId:f.b,discussionId:scope.discussionId,requestKey:randomUUID(),text:'删除期间尝试生成',confirmedContact:true}));
 for(const request of f.requests.slice(callsBeforeFenceRetry)){
  assert.equal(itemNumber(request),null,'删除围栏生效后不能把旧文档加入新候选输入');
  const sent=JSON.stringify(request);for(const item of knowledge.filter(item=>item.kind==='document'))assert.ok(!sent.includes(item.text),'删除期间不能发送旧文档正文');
 }
 const done=await deletion.advance(plan);assert.equal(done.state,'completed',JSON.stringify(done.checks));
 const independent=await f.documents.read({scopeKind:'contact',contactId:f.b});assert.equal(independent.publication.id,before.publication.id);assert.deepEqual(independent.publication.members,before.publication.members);
 assert.equal((await f.documents.read({scopeKind:'self',contactId:null})).publication,null);
 const remaining=(await f.storage.execute('fixture.documentKnowledge',scope)).filter(item=>item.kind==='document');assert.equal(remaining.length,2);assert.ok(remaining.every(item=>item.scopeKind==='contact'&&item.contactId===f.b));
 assert.ok((await f.service.view(f.b,scope.discussionId)).every(entry=>entry.candidates.length===0));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('05来源删除排空在途12请求并拒绝晚到结果',{timeout:30000},async t=>{
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts');
 const {ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 let entered,release;const ready=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>release=resolve);
 const f=await setup(t,{includeOwner:true,beforeReply:async()=>{entered();await waiting;}}),discussion=await f.discussions.newDiscussion(f.b);
 const pending=f.turns.generate({contactId:f.b,discussionId:discussion.id,requestKey:randomUUID(),text:'结合本人资料写一句',confirmedContact:true});void pending.catch(()=>{});
 await ready;const source=(await f.history.read(f.a)).messages.find(message=>message.text==='我长期喜欢合成音乐甲。').sourceRecordIds[0];
 const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root));let done;
 try{
  const plan=await deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.a,sourceId:source}});
  assert.equal((await f.documents.read({scopeKind:'self',contactId:null})).publication,null);
  done=await deletion.advance(plan);assert.equal(done.state,'completed',JSON.stringify(done.checks));
 }finally{release();}
 await assert.rejects(pending);assert.ok((await f.service.view(f.b,discussion.id)).every(entry=>entry.candidates.length===0));
 const remaining=await f.documents.read({scopeKind:'contact',contactId:f.b});assert.equal(remaining.publication.members.length,2);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('另一owner即使持有文档身份也无法读取或复验原发布',{timeout:20000},async t=>{
 const {SqliteContactService}=await import('../src/contacts/sqlite/service.ts');
 const f=await setup(t),scope={ownerId:f.owner,contactId:f.a,discussionId:(await f.discussions.newDiscussion(f.a)).id};
 const doc=(await f.storage.execute('fixture.documentKnowledge',scope)).find(item=>item.kind==='document');assert.ok(doc);
 const otherOwner=randomUUID(),metadata={account:async()=>({externalKey:'second-synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'second-source',assurance:'verified',supportProfile:'synthetic'}),sessions:async()=>[{externalKey:'second-friend',displayName:'合成另一个联系人',kind:'private',identityAssurance:'verified'}]};
 const contacts=new SqliteContactService(f.storage,otherOwner,metadata);t.after(()=>contacts.close());await contacts.initialize();await contacts.confirmAccount((await contacts.detectAccount()).candidate_token);
 const candidates=await contacts.candidates(true),selected=candidates.sessions[0];await contacts.confirm(candidates.snapshot_token,[{locator:selected.username,observed_display_name:selected.display_name,expected_selection_generation:selected.selection_generation}]);
 const own=(await contacts.directory()).contacts[0].contact_id,foreign={ownerId:otherOwner,contactId:own,discussionId:randomUUID()};
 assert.deepEqual(await f.storage.execute('fixture.documentKnowledge',foreign),[]);
 await assert.rejects(f.storage.execute('fixture.documentCurrent',{scope:foreign,item:doc}),{code:'document_knowledge_stale'});
 await assert.rejects(f.storage.execute('fixture.documentKnowledge',{...foreign,contactId:f.a}),{code:'memory_scope_stale'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('本人长期背景的推断与矛盾按原结构进入回复材料并保留两侧来源',{timeout:20000},async t=>{
 const f=await setup(t,{includeOwner:true,structuredProfile:true}),scope={ownerId:f.owner,contactId:f.b,discussionId:(await f.discussions.newDiscussion(f.b)).id};
 const docs=(await f.storage.execute('fixture.documentKnowledge',scope)).filter(item=>item.kind==='document'&&item.scopeKind==='owner');assert.equal(docs.length,2);
 const profile=docs.find(doc=>doc.text.includes('【长期背景】'));assert.ok(profile);
 assert.match(profile.text,/推断：可能重视合成饮品/);assert.match(profile.text,/不确定性：仅为推断/);
 assert.match(profile.text,/矛盾：对合成绿茶的偏好仍有矛盾/);assert.match(profile.text,/状态：尚未厘清/);
 assert.match(profile.text,/长期只喜欢合成绿茶/);assert.match(profile.text,/长期不喜欢合成绿茶/);
 assert.deepEqual(new Set(profile.sources.map(source=>source.contactId)),new Set([f.a,f.b]));
 assert.equal(await f.storage.execute('fixture.documentCurrent',{scope,item:profile}),true);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('撤选B后下一轮本人整理不得沿用实际混合输入的旧文档',{timeout:30000},async t=>{
 const calls=[],f=await setup(t,{includeOwner:true,preferText:'音乐甲',targetOnly:true,recordCalls:calls,orderAFirst:true,orderOwnerA:true});
 const scope={ownerId:f.owner,contactId:f.a,discussionId:(await f.discussions.newDiscussion(f.a)).id};
 const originalKnowledge=await f.storage.execute('fixture.documentKnowledge',scope),independentMemory=originalKnowledge.find(item=>item.kind==='memory'&&item.scopeKind==='owner'&&item.text.includes('音乐甲'));
 assert.ok(independentMemory);assert.deepEqual(new Set(independentMemory.sources.map(source=>source.contactId)),new Set([f.a]));
 const old=await f.documents.read({scopeKind:'self',contactId:null}),oldKnowledge=originalKnowledge.filter(item=>item.kind==='document'&&item.scopeKind==='owner');
 assert.equal(old.publication.members.length,2);assert.equal(oldKnowledge.length,2);
 assert.ok(oldKnowledge.every(item=>item.text.includes('音乐甲')&&!item.text.includes('绿茶乙')));
 assert.ok(oldKnowledge.every(item=>new Set(item.sources.map(source=>source.contactId)).size===2&&item.sources.some(source=>source.contactId===f.a)&&item.sources.some(source=>source.contactId===f.b)));
 const provenance=await f.storage.execute('fixture.documentProvenance',{ownerId:f.owner,publicationId:old.publication.id});
 for(const item of oldKnowledge){const refs=provenance.filter(row=>row.document_id===item.id);assert.ok(refs.length);assert.deepEqual(new Set(refs.map(row=>row.source_contact_id)),new Set([f.a]));}
 const oldKeys=new Set(old.publication.members.map(item=>`${item.documentId}:${item.versionNo}`)),oldIdentifiers=new Set(provenance.flatMap(item=>[item.document_id,item.version_identity]));
 const ownA=await f.documents.read({scopeKind:'contact',contactId:f.a});assert.equal(ownA.publication.members.length,2);
 const binding=(await f.contacts.directory()).bindings.find(item=>item.contact_id===f.b&&item.status==='active');assert.ok(binding);
 await f.contacts.revoke(f.b,binding.binding_id,binding.selection_generation);
 const visibleAfterRevoke=await f.documents.read({scopeKind:'self',contactId:null});assert.equal(visibleAfterRevoke.publication.id,old.publication.id);assert.deepEqual(visibleAfterRevoke.publication.members,old.publication.members);
 const firstCount=calls.length,page=f.channel.page;
 f.channel.page=async(...args)=>{const result=await page(...args);return {...result,records:[{...result.records[0],localId:'3',sender:'owner',text:'我长期喜欢合成散步甲。'}]};};
 await f.contacts.setReading(true);await f.history.synchronize(f.a);await f.contacts.setReading(false);
 const next=await f.extraction.start('owner-next-run-only-a');await f.extraction.waitForIdle();
 assert.deepEqual(next.tasks.filter(item=>item.scopeKind==='contact').map(item=>item.contactId),[f.a]);
 const requests=calls.slice(firstCount).filter(item=>item.contactId===null),latest=await f.extraction.read(next.runId),selfTask=latest.tasks.find(item=>item.scopeKind==='self');
 assert.ok(requests.length,`新轮本人阶段必须实际运行：${JSON.stringify({tasks:latest.tasks,self:selfTask&&await f.documents.readTask(selfTask.taskId)})}`);
 for(const request of requests){
  const text=JSON.stringify(request.messages);assert.ok(!text.includes('绿茶乙'),'本人模型请求不得携带未选B的资料');
  for(const identity of oldIdentifiers)assert.ok(!text.includes(identity),'不得把实际混合输入的旧文档加入新轮模型请求');
  const inputs=await f.storage.execute('fixture.documentStepInputs',{ownerId:f.owner,stepId:request.stepId});
  assert.ok(inputs.every(item=>item.source_contact_id!==f.b));
  assert.ok(inputs.every(item=>!item.document_id||!oldIdentifiers.has(item.document_id)),'新阶段不得冻结旧混合文档');
 }
 const updated=await f.documents.read({scopeKind:'self',contactId:null});assert.ok(updated.publication);assert.notEqual(updated.publication.id,old.publication.id);
 assert.ok(updated.publication.members.every(item=>!oldKeys.has(`${item.documentId}:${item.versionNo}`)));
 const published=(await f.storage.execute('fixture.documentKnowledge',scope)).filter(item=>item.kind==='document'&&item.scopeKind==='owner');
 assert.ok(published.length);assert.ok(published.every(item=>item.sources.every(source=>source.contactId!==f.b)));
 const independent=await f.documents.read({scopeKind:'contact',contactId:f.a});assert.ok(independent.publication);assert.ok(independent.documents.some(item=>JSON.stringify(item).includes('园艺甲')));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('本人集合同时含独立A与混合成员时撤选B后只继承独立A版本',{timeout:40000},async t=>{
 const calls=[],f=await setup(t,{includeOwner:true,preferText:'音乐甲',targetOnly:true,recordCalls:calls,orderAFirst:true,orderOwnerA:true,onlyAInitial:true});
 const scope={ownerId:f.owner,contactId:f.a,discussionId:(await f.discussions.newDiscussion(f.a)).id};
 const seeded=await f.documents.read({scopeKind:'self',contactId:null}),seededDocs=(await f.storage.execute('fixture.documentKnowledge',scope)).filter(item=>item.kind==='document'&&item.scopeKind==='owner');
 assert.equal(seeded.publication.members.length,2);assert.ok(seededDocs.every(item=>item.sources.length>0&&item.sources.every(source=>source.contactId===f.a)));
 const originalPage=f.channel.page;
 f.channel.page=async(...args)=>{
  const page=await originalPage(...args);
  if(args[0].conversationKey===((await f.contacts.directory()).bindings.find(binding=>binding.contact_id===f.a)).conversation_locator)
   return {...page,records:[{...page.records[0],localId:'3',sender:'owner',text:'我长期喜欢合成散步甲。'}]};
  return page;
 };
 await f.contacts.setReading(true);await f.history.synchronize(f.a);await f.history.synchronize(f.b);await f.contacts.setReading(false);
 const mixedRun=await f.extraction.start('owner-mixed-round');await f.extraction.waitForIdle();
 assert.equal(mixedRun.tasks.filter(item=>item.scopeKind==='contact').length,2);
 const mixed=await f.documents.read({scopeKind:'self',contactId:null}),all=(await f.storage.execute('fixture.documentKnowledge',scope)).filter(item=>item.kind==='document'&&item.scopeKind==='owner');
 assert.ok(mixed.publication);assert.notEqual(mixed.publication.id,seeded.publication.id);
 const independent=all.filter(item=>item.sources.length>0&&item.sources.every(source=>source.contactId===f.a));
 const affected=all.filter(item=>item.sources.some(source=>source.contactId===f.b));
 assert.ok(independent.length,'应有第一轮继承的A独立文档');assert.ok(affected.length,'应有真实A+B输入形成的文档');
 const seedKeys=new Set(seeded.publication.members.map(item=>`${item.documentId}:${item.versionNo}`));
 assert.ok(independent.some(item=>seedKeys.has(`${item.id}:${item.versionNo}`)),'独立A成员来自真实上一轮');
 const mixedKeys=new Set(affected.map(item=>`${item.id}:${item.versionNo}`)),mixedIds=new Set(affected.map(item=>item.id)),independentKeys=new Set(independent.map(item=>`${item.id}:${item.versionNo}`));
 const binding=(await f.contacts.directory()).bindings.find(item=>item.contact_id===f.b&&item.status==='active');assert.ok(binding);
 await f.contacts.revoke(f.b,binding.binding_id,binding.selection_generation);
 assert.equal((await f.documents.read({scopeKind:'self',contactId:null})).publication.id,mixed.publication.id,'撤选不是删除，旧完整集合仍可查看');
 const firstCount=calls.length;
 f.channel.page=async(...args)=>{const page=await originalPage(...args);return {...page,records:[{...page.records[0],localId:'4',sender:'owner',text:'我长期喜欢合成钢琴甲。'}]};};
 await f.contacts.setReading(true);await f.history.synchronize(f.a);await f.contacts.setReading(false);
 const next=await f.extraction.start('owner-inherit-a-only');await f.extraction.waitForIdle();
 assert.deepEqual(next.tasks.filter(item=>item.scopeKind==='contact').map(item=>item.contactId),[f.a]);
 const requests=calls.slice(firstCount).filter(item=>item.contactId===null),latest=await f.extraction.read(next.runId),selfTask=latest.tasks.find(item=>item.scopeKind==='self');
 assert.ok(requests.length,`新轮本人阶段必须实际运行：${JSON.stringify({tasks:latest.tasks,self:selfTask&&await f.documents.readTask(selfTask.taskId)})}`);
 for(const request of requests){
  const inputs=await f.storage.execute('fixture.documentStepInputs',{ownerId:f.owner,stepId:request.stepId});
  assert.ok(inputs.every(item=>item.source_contact_id!==f.b));assert.ok(inputs.every(item=>!item.document_id||!mixedIds.has(item.document_id)),'混合成员不得作为输入');
 }
 const nextView=await f.documents.read({scopeKind:'self',contactId:null});assert.ok(nextView.publication);assert.notEqual(nextView.publication.id,mixed.publication.id);
 const nextKeys=new Set(nextView.publication.members.map(item=>`${item.documentId}:${item.versionNo}`));
 assert.ok([...independentKeys].some(key=>nextKeys.has(key)),'应保留合法独立A版本');assert.ok([...mixedKeys].every(key=>!nextKeys.has(key)),'不得继承任何旧混合版本');
 const after=(await f.storage.execute('fixture.documentKnowledge',scope)).filter(item=>item.kind==='document'&&item.scopeKind==='owner');
 assert.ok(after.every(item=>item.sources.every(source=>source.contactId!==f.b)));assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
