import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {record} from './fixtures/memory-sqlite/support.mjs';
import {unifiedChainFixture,imageStatement} from './fixtures/memory-content/unified-chain.mjs';
import {fileContentText} from './fixtures/memory-content/file-plugin.mjs';

test('图文共同来源沿统一处理链自动比较旧记忆并发布主题和长期概览，占位内容不进入模型',async t=>{
 const f=await unifiedChainFixture(t);
 const otherScope={scopeKind:'contact',contactId:f.saved[1].contact_id},otherStatement='另一位联系人独有的合成旅行安排。';
 await f.management.decide({requestKey:randomUUID(),action:'manual',scope:otherScope,body:otherStatement});
 await f.sync([record('1',{text:'我长期喜欢合成园艺。'})]);
 const baseline=await f.run();assert.equal(baseline.state,'completed',JSON.stringify({baseline,failures:f.failures}));
 assert.equal((await f.read()).memories.length,1);
 const {file,messages}=await f.addImage(),done=await f.run(),view=await f.read();
 const adopted=view.memories.find(memory=>memory.current?.body===imageStatement);
 assert.ok(adopted,JSON.stringify({candidates:view.candidates,failures:f.failures}));
 assert.equal(adopted.current.adoptionMode,'auto');
 assert.equal(view.candidates.filter(candidate=>candidate.state==='pending').length,0);
 assert.equal(done.state,'completed',JSON.stringify({done,failures:f.failures}));
 for(const purpose of ['adjudication','relation_verification']){
  const request=f.adjudicationRequests.find(item=>item.purpose===purpose&&item.images?.some(image=>image.id===file.fileId));
  assert.ok(request,`${purpose}必须携带实际图片`);assert.ok(request.images.every(image=>Buffer.from(image.dataBase64,'base64').length>0));
  assert.equal(request.contactId,f.contactId);
 }
 assert.ok(f.adjudicationRequests.every(request=>!request.user.includes(otherStatement)),'其他联系人的正式记忆不进入比较池');
 const placeholders=new Set(messages.filter(message=>['voice','video','sticker'].includes(message.kind)).map(message=>message.id));
 for(const request of f.requests){const body=JSON.parse(request.user);assert.ok(body.messages.every(message=>!placeholders.has(message.message_id)));assert.ok((body.target_message_ids??[]).every(id=>!placeholders.has(id)));}
 assert.equal(done.total,2,'只有新文字和实际图片计入本轮目标');
 const docs=await f.documents.read(f.scope);assert.deepEqual([...new Set(docs.documents.map(document=>document.kind))].sort(),['profile','scene']);
 for(const kind of ['profile','scene'])assert.ok(docs.documents.some(document=>document.kind===kind&&JSON.stringify(document).includes(imageStatement)),`${kind}应发布图片支持的新记忆`);
 assert.equal((await f.management.read(otherScope)).memories[0].current.body,otherStatement);
 assert.equal((await f.documents.read(otherScope)).publication,null,'目标联系人的处理不发布另一位联系人的文档');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('图片与两条既有文字记忆合并时，合并核验使用实际附图并保留全部来源',async t=>{
 const mergedText='联系人长期喜欢合成园艺和合成木雕，并有一个蓝色杯子。';
 const f=await unifiedChainFixture(t,{action:'merge',mergedText});
 await f.sync([record('1',{text:'我长期喜欢合成园艺。'}),record('2',{text:'我长期喜欢合成木雕。'})]);
 await f.run();assert.equal((await f.read()).memories.filter(memory=>memory.state==='active').length,2);
 const {file}=await f.addImage(),done=await f.run(),view=await f.read(),active=view.memories.filter(memory=>memory.state==='active');
 assert.equal(active.length,1,JSON.stringify({candidates:view.candidates,failures:f.failures}));
 assert.equal(active[0].current.body,mergedText);assert.equal(active[0].current.adoptionMode,'auto');
 assert.equal(active[0].current.sources.length,4,'合并保留两条旧文字、图片说明与实际图片');
 assert.equal(view.memories.filter(memory=>memory.state==='withdrawn').length,1);
 assert.ok(f.adjudicationRequests.some(request=>request.purpose==='merge_verification'&&request.images?.some(image=>image.id===file.fileId)));
 assert.equal(done.state,'completed',JSON.stringify({done,failures:f.failures}));
 assert.ok(JSON.stringify((await f.documents.read(f.scope)).documents).includes(mergedText));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const action of ['clear','replace'])test(`图文自动采纳并发布后${action==='clear'?'清除':'替换'}图片，相关记忆与文档失效且独立文字保留`,async t=>{
 const f=await unifiedChainFixture(t);
 await f.sync([record('1',{text:'我长期喜欢合成园艺。'})]);await f.run();
 const baseline=(await f.read()).memories.find(memory=>memory.current?.body==='联系人长期喜欢合成园艺。');assert.ok(baseline);
 const {message,file}=await f.addImage();await f.run();
 const imageMemory=(await f.read()).memories.find(memory=>memory.current?.body===imageStatement);assert.ok(imageMemory);
 assert.ok(JSON.stringify((await f.documents.read(f.scope)).documents).includes(imageStatement));
 if(action==='clear')await f.media.clear(f.contactId,message.id,randomUUID());
 else {
  await f.contacts.setReading(true);
  const saved=await f.media.extract(f.contactId,message.id,{requestKey:randomUUID(),goal:'extract'});assert.notEqual(saved.files[0].fileId,file.fileId);
 }
 const after=await f.read(),retained=after.memories.find(memory=>memory.id===baseline.id);assert.ok(retained,JSON.stringify({after,baseline:baseline.id,failures:f.failures}));assert.equal(retained.current.body,'联系人长期喜欢合成园艺。');
 assert.equal(after.memories.find(memory=>memory.id===imageMemory.id)?.current??null,null);
 const documents=await f.documents.read(f.scope);assert.equal(documents.publication,null);assert.deepEqual(documents.documents,[]);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('仅新增并注册第三种合成内容适配器即可沿原流程提取核验裁决和整理，来源正文为空仍保留合法引句',async t=>{
 const f=await unifiedChainFixture(t,{fileContent:true,preferredText:'合成读书会'});
 await f.sync([record('1',{text:'我长期喜欢合成园艺。'})]);await f.run();
 const messages=await f.sync([record('31',{kind:'file',text:null,originalType:'49'})]),file=messages.find(message=>message.kind==='file');
 assert.ok(file);assert.equal(file.text,null,'原始消息正文保留为空，内容由文件适配器读取');
 const done=await f.run(),view=await f.read(),statement=fileContentText.replace(/^我/,'联系人');
 const memory=view.memories.find(item=>item.current?.body===statement);
 assert.ok(memory,JSON.stringify({candidates:view.candidates,failures:f.failures}));
 assert.equal(memory.current.adoptionMode,'auto');assert.equal(memory.current.verificationState,'verified');
 assert.equal(memory.current.sources[0].contentKind,'file');assert.equal(memory.current.sources[0].quote,fileContentText);
 assert.equal(memory.current.sources[0].contentRef.frozen.pluginId,'synthetic.file');
 assert.ok(f.adjudicationRequests.some(request=>request.purpose==='relation_verification'&&JSON.stringify(JSON.parse(request.user)).includes(fileContentText)));
 assert.equal(done.total,1);assert.equal(done.state,'completed',JSON.stringify({done,failures:f.failures}));
 assert.ok(JSON.stringify((await f.documents.read(f.scope)).documents).includes(statement));
 const plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactId,sourceId:file.sourceRecordIds[0]}});
 const erased=await f.deletion.advance({ownerId:f.owner,operationId:plan.operationId});assert.equal(erased.state,'completed',JSON.stringify(erased.checks));
 assert.equal((await f.read()).memories.find(item=>item.id===memory.id)?.current??null,null);
 assert.equal((await f.documents.read(f.scope)).publication,null);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
