import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {documentFixture} from './fixtures/memory-documents/support.mjs';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
const originalBody='本轮原始园艺场景专有正文。',newBody='后来发布的天文学场景专有正文。';
function toolResponse(res,itemNo){
 const events=[{type:'message_start',message:{id:randomUUID(),model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'tool_use',id:randomUUID(),name:'read_relationship_document',input:{}}},
  {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({itemNo,startBlock:1,blockCount:1})}},
  {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:8}},{type:'message_stop'}];
 res.setHeader('content-type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}
async function setup(t,beforeTool=async()=>{}){
 let f,sceneBody=originalBody;
 f=await fixture(t,{synchronizeHistory:false,registryModule:new URL('./fixtures/sqlite-reply-candidates/frozen-document-registry.mjs',import.meta.url).href,
  onRequest:async(_req,res,request,n)=>{
   if(n!==1)return;const wire=JSON.stringify(request);assert.ok(!wire.includes(originalBody));
   const itemNo=Number(wire.match(/\[(\d+)\] document\\n【主题目录】/)[1]);await beforeTool(f,itemNo);toolResponse(res,itemNo);return true;
  },content:request=>{
   const wire=JSON.stringify(request);assert.match(wire,new RegExp(originalBody));assert.ok(!wire.includes(newBody));
   return JSON.stringify({candidates:[{parts:['按照原始资料形成的合成回复。'],basis:[Number(wire.match(/实际输入材料\[(\d+)\]/)[1])]}]});
  }});
 await f.contacts.setReading(true);
 const docs=await documentFixture(t,{baseFixture:{...f,service:f.history,saved:[{contact_id:f.ids[0]}]},sceneBody:()=>sceneBody});
 await docs.extraction.start('frozen-document-first');await docs.extraction.waitForIdle();
 const contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});
 t.after(()=>turns.close());Object.assign(f,{docs,contactId,discussionId:d.id,service,turns,changeScene:()=>{sceneBody=newBody;}});
 f.scope={ownerId:f.owner,contactId,discussionId:d.id};
 f.inputs=()=>f.storage.execute('frozenDocumentTest.input',f.scope);
 f.generate=()=>turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'谈谈园艺',confirmedContact:true});
 return f;
}

test('目录冻结后正式新发布与守卫失证不换用本轮正文，真实依据仍绑定原publication',async t=>{
 let oldDirectory;
 const f=await setup(t,async(f,itemNo)=>{
  oldDirectory=JSON.parse((await f.inputs()).find(item=>Number(item.item_no)===itemNo).identity_json);
  f.changeScene();
  await f.docs.management.decide({requestKey:'unrelated-astronomy',action:'manual',scope:{scopeKind:'contact',contactId:f.contactId},body:'联系人另外喜欢合成天文学。'});
  const scope={scopeKind:'contact',contactId:f.contactId},scheduled=await f.docs.documents.readSchedule(scope);
  assert.equal(scheduled.scene.state,'scheduled');await f.docs.documents.runDueStages(scheduled.scene.dueAt);
  const now=(await f.storage.execute('frozenDocumentTest.local',f.scope)).find(item=>item.projection?.kind==='directory');
  assert.ok(now);assert.notEqual(now.publicationId,oldDirectory.publicationId);
  assert.ok(JSON.stringify(await f.docs.documents.read(scope)).includes(newBody),'新publication确实含后来形成的正文，不能只更换空头指针');
  const beforeGuard=await f.storage.execute('frozenDocumentTest.strict',f.scope);assert.ok(beforeGuard.some(item=>item.projection?.kind==='directory'&&item.publicationId===now.publicationId));
  await f.contacts.setReading(false);await f.storage.execute('frozenDocumentTest.guardLost',f.scope);
  assert.deepEqual(await f.storage.execute('frozenDocumentTest.strict',f.scope),beforeGuard,'新发布集合的ok资格不依赖进程守卫；本轮工具仍须绑定旧冻结集合');
 });
 await f.generate().catch(error=>{t.diagnostic(JSON.stringify({requests:f.requests.length,supplierErrors:f.supplierErrors.map(value=>value.message)}));throw error;});assert.equal(f.requests.length,2);
 const inputs=(await f.inputs()).map(item=>({identity:JSON.parse(item.identity_json),text:item.text_body})),body=inputs.find(item=>item.identity.projection?.kind==='blocks');
 assert.equal(body.identity.publicationId,oldDirectory.publicationId);assert.deepEqual(body.identity.versionNo,oldDirectory.versionNo);assert.match(body.text,new RegExp(originalBody));
 const basis=(await f.service.view(f.contactId,f.discussionId))[0].candidates[0].basis[0];assert.equal(basis.verification,'actual_input');assert.match(basis.text,new RegExp(originalBody));
 const batch=await f.storage.execute('frozenDocumentTest.batchPublications',f.scope);assert.equal(batch.publicationIds.length,2,'同scope的两份冻结发布集合应分别复核');assert.ok(batch.reusedVersions>0,'同文档版本出现在两个publication中也必须按集合独立核验');
 await f.storage.execute('frozenDocumentTest.removePublicationMember',{...f.scope,publicationId:oldDirectory.publicationId});
 assert.equal((await f.storage.execute('frozenDocumentTest.batchPublications',{...f.scope,currentOnly:true})).publicationIds.length,1);
 await assert.rejects(f.storage.execute('frozenDocumentTest.batchPublications',f.scope),{code:'document_knowledge_stale'},'当前完整集合不能掩盖旧publication缺失成员');
});

test('同步关闭且守卫已失证时可从本机资料首次召回目录并经真实工具读取正文',async t=>{
 const f=await setup(t),before=await f.storage.execute('frozenDocumentTest.strict',f.scope);assert.equal(before.length,2);await f.contacts.setReading(false);await f.storage.execute('frozenDocumentTest.guardLost',f.scope);
 assert.deepEqual(await f.storage.execute('frozenDocumentTest.strict',f.scope),before,'同步关闭和guard丢失不能撤销已接纳的本机证明');
 await f.generate();assert.equal(f.requests.length,2);assert.ok((await f.inputs()).some(item=>JSON.parse(item.identity_json).projection?.kind==='blocks'));
 assert.equal((await f.service.view(f.contactId,f.discussionId))[0].sourceState,'available');
});

test('目录冻结后真实事实纠错仍拒绝读取旧正文，不能以冻结publication绕过',async t=>{
 const f=await setup(t,async f=>{
  const memory=(await f.docs.management.read({scopeKind:'contact',contactId:f.contactId})).memories[0];
  await f.docs.management.decide({requestKey:'frozen-fact-correction',action:'correct',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body:'纠正后的事实不再支持原园艺场景。'});
 });
 await assert.rejects(f.generate());assert.equal(f.requests.length,1);
 assert.ok((await f.inputs()).every(item=>JSON.parse(item.identity_json).projection?.kind!=='blocks'));
 assert.equal((await f.service.view(f.contactId,f.discussionId)).flatMap(row=>row.candidates).length,0);
});

test('目录冻结后删除真实来源会拒绝迟到正文工具并清理冻结输入',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();t.after(()=>release.resolve());
 const f=await setup(t,async()=>{entered.resolve();await release.promise;});
 const pending=f.generate(),rejected=assert.rejects(pending);await entered.promise;
 const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root)),message=(await f.history.read(f.contactId)).messages[0];
 const operation=await deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactId,sourceId:message.sourceRecordIds[0]}});
 release.resolve();await rejected;assert.equal((await deletion.advance(operation)).state,'completed');
 assert.equal(f.requests.length,1);assert.deepEqual(await f.inputs(),[]);assert.deepEqual(await f.service.view(f.contactId,f.discussionId),[]);
});
