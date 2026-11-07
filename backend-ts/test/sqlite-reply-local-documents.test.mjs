import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deletionFixture} from './fixtures/memory-documents/deletion-support.mjs';
import {record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';

test('正式自动记忆与递归文档的ok本机资格不依赖易失守卫',async t=>{
 const f=await deletionFixture(t),run=await f.extraction.start('local-documents-guard');await f.extraction.waitForIdle(run.runId);
 const scope={ownerId:f.owner,contactId:f.contactId,discussionId:randomUUID()};
 const before=await f.storage.execute('fixture.localReplyKnowledge',scope);
 assert.ok(before.some(item=>item.kind==='memory'&&item.qualification==='auto'));assert.equal(before.filter(item=>item.kind==='document').length,2);
 await f.storage.execute('fixture.localReplyGuardLost',scope);
 const after=await f.storage.execute('fixture.localReplyKnowledge',scope);assert.deepEqual(after,before);
 for(const item of before)assert.equal(await f.storage.execute('fixture.localReplyFrozen',{scope,item}),true);
 assert.deepEqual(await f.storage.execute('fixture.documentKnowledge',scope),before.filter(item=>item.kind==='document'),'文档本机资格同样不依赖易失guard');
});

test('新正式发布保留原冻结集合；新请求拒绝指定旧集合，旧集合缺任一成员即失效',async t=>{
 let unchanged=false;
 const f=await deletionFixture(t,{extractionResponse:async request=>unchanged&&request.purpose==='extraction'?{blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]}:undefined});
 const first=await f.extraction.start('local-documents-publication-first');await f.extraction.waitForIdle(first.runId);
 const scope={ownerId:f.owner,contactId:f.contactId,discussionId:randomUUID()},before=(await f.storage.execute('fixture.localReplyKnowledge',scope)).filter(item=>item.kind==='document');assert.equal(before.length,2);
 unchanged=true;f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('2',{text:'合成问候。',sentAt:'1700000001000'})],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);await f.contacts.setReading(false);
 const second=await f.extraction.start('local-documents-publication-second');await f.extraction.waitForIdle(second.runId);
 const after=(await f.storage.execute('fixture.localReplyKnowledge',scope)).filter(item=>item.kind==='document');assert.equal(after.length,2);assert.notEqual(after[0].publicationId,before[0].publicationId);
 for(const item of before){assert.equal(await f.storage.execute('fixture.localReplyFrozen',{scope,item}),true);await assert.rejects(f.storage.execute('fixture.localReplyCurrent',{scope,item}),{code:'document_knowledge_stale'});}
 await f.storage.execute('fixture.removeDocumentMember',{ownerId:f.owner,publicationId:before[0].publicationId});
 for(const item of before)await assert.rejects(f.storage.execute('fixture.localReplyFrozen',{scope,item}),{code:'document_knowledge_stale'});
});

test('冻结文档的实际事实纠错后不能以旧publication继续使用',async t=>{
 const f=await deletionFixture(t),run=await f.extraction.start('local-documents-correction');await f.extraction.waitForIdle(run.runId);
 const scope={ownerId:f.owner,contactId:f.contactId,discussionId:randomUUID()},items=await f.storage.execute('fixture.localReplyKnowledge',scope),memory=items.find(item=>item.kind==='memory');assert.ok(memory);
 const management=new SqliteMemoryManagement(f.storage,f.owner);
 await management.decide({requestKey:randomUUID(),action:'correct',memoryId:memory.id,expectedVersionNo:String(memory.versionNo),expectedHeadRevision:String(memory.headRevision),body:'已纠正的合成事实。'});
 for(const item of items)await assert.rejects(f.storage.execute('fixture.localReplyFrozen',{scope,item}));
});
