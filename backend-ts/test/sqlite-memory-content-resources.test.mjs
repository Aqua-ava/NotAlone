import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {record} from './fixtures/memory-sqlite/support.mjs';
import {unifiedChainFixture,imageStatement} from './fixtures/memory-content/unified-chain.mjs';
import {storeContentIdentity,storedContentResources} from '../src/memory/content/evidence.ts';

test('冻结资源清单独立保存且兼容旧图片身份，无法识别的元数据不能静默丢弃',()=>{
 const fileId=randomUUID(),identity={asset:{id:fileId}},stored=storeContentIdentity(identity,[fileId,fileId]);
 assert.deepEqual(storedContentResources('video',stored),{identity,managedFiles:[fileId]});
 assert.deepEqual(identity,{asset:{id:fileId}},'冻结不修改适配器身份');
 assert.deepEqual(storedContentResources('image',{fileId,sha256:'a'.repeat(64)}),{identity:{fileId,sha256:'a'.repeat(64)},managedFiles:[fileId]});
 assert.deepEqual(storedContentResources('text',{sha256:'a'.repeat(64)}).managedFiles,[]);
 assert.throws(()=>storedContentResources('video',{__notalone_content_resources:{version:2,managedFiles:[fileId]}}),{code:'memory_content_resources_invalid'});
 assert.throws(()=>storeContentIdentity({__notalone_content_resources:{}},[]),{code:'memory_content_resources_invalid'});
});

test('第三种视觉内容的资源依赖在插件卸载后仍进入媒体删除计划并清除派生资料',async t=>{
 const f=await unifiedChainFixture(t,{visualContent:true});
 await f.sync([record('1',{text:'我长期喜欢合成园艺。'})]);await f.run();
 const messages=await f.sync([record('20',{text:'这是我家的蓝色杯子。'}),record('21',{kind:'video',text:null,originalType:'43'})]);
 const visual=messages.find(message=>message.kind==='video');
 const saved=await f.media.extract(f.contactId,visual.id,{requestKey:randomUUID(),goal:'extract'});assert.equal(saved.files.length,1);
 const run=await f.run();assert.equal(run.state,'completed',JSON.stringify(f.failures));
 const memory=(await f.read()).memories.find(item=>item.current?.body===imageStatement);assert.ok(memory);
 assert.ok(f.adjudicationRequests.some(request=>request.images?.some(image=>image.id===saved.files[0].fileId)));
 await f.storage.execute('fixture.unloadVisualContent',{});
 const requestKey=randomUUID(),plan=await f.deletion.plan({ownerId:f.owner,requestKey,scope:{kind:'media_result_clear',contactId:f.contactId,messageId:visual.id}});
 assert.ok(plan.targets.some(item=>item.target?.domain==='memory_management'&&item.target.key.memory_id===memory.id),'资源删除必须规划派生记忆，不能只让当前读取隐藏正文');
 await f.media.clear(f.contactId,visual.id,requestKey);
 assert.equal((await f.deletion.status({ownerId:f.owner,operationId:plan.operationId})).state,'completed');
 assert.equal((await f.read()).memories.find(item=>item.id===memory.id)?.current??null,null);
 assert.equal((await f.documents.read(f.scope)).publication,null);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
