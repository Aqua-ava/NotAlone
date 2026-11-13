
const imageLaterRegistry=new URL('./fixtures/memory-documents/image-later-registry.mjs',import.meta.url).href;
async function imageLaterFixture(t,key){
 const f=await memoryFixture(t,{imageFact:true,registryModule:imageLaterRegistry}),saved=await saveImage(f);
 const run=await f.extract(key);await f.accept('聊天图片中有一个蓝色杯子。');
 const requests=[],respond=documentSupplier();
 const documents=new SqliteMemoryDocuments(f.storage,owner,modelPort(()=>f.extraction.accounting,async request=>{requests.push(request);return respond(request);}),f.holders);t.after(()=>documents.close());
 await documents.enrollRun(run.runId);return {...f,...saved,documents,documentRequests:requests};
}

test('图片L1记忆经独立L2与L3轮次冻结原图身份，文字文档请求不发送图片，正式清图覆盖全部派生来源',{timeout:20000},async t=>{
 const f=await imageLaterFixture(t,'image-later-documents-closure'),schedule=await f.documents.readSchedule(f.scope);
 const jobs=await f.documents.runDueStages(schedule.scene.dueAt);
 assert.equal(jobs.length,2,JSON.stringify(jobs));assert.deepEqual(jobs.map(job=>job.stage),['document_scene','document_profile']);
 assert.ok(jobs.every(job=>job.state==='succeeded'));assert.equal((await f.documents.read(f.scope)).publication.members.length,2);
 const inputs=await f.storage.execute('fixture.imageLaterInputs',{ownerId:owner});assert.equal(inputs.length,2);
 for(const input of inputs){
  assert.equal(input.content_kind,'image');assert.equal(input.plugin_id,'notalone.image');assert.equal(input.plugin_version,'1');assert.equal(input.message_id,f.message.id);
  const identity=JSON.parse(input.identity_json);assert.equal(identity.fileId,f.file.fileId);assert.equal(identity.sha256,createHash('sha256').update(await imageBytes(1)).digest('hex'));
  assert.equal(identity.mimeType,'image/png');assert.equal(identity.byteSize,(await imageBytes(1)).length);assert.ok(/^\d+$/.test(identity.mediaGeneration));
  assert.equal(await f.storage.execute('fixture.imageLaterRevalidate',{ownerId:owner,runId:input.run_id}),true);
 }
 assert.ok(f.documentRequests.length>0);
 for(const request of f.documentRequests){assert.equal(request.images,undefined);assert.ok(!JSON.stringify(request).includes((await imageBytes(1)).toString('base64')));assert.ok(request.messages.every(message=>!Array.isArray(message.content)||message.content.every(block=>block.type!=='image')));}
 await f.media.clear(f.contactId,f.message.id,'clear-image-later-documents');
 assert.equal((await f.documents.read(f.scope)).publication,null);assert.deepEqual(await f.storage.execute('fixture.imageLaterInputs',{ownerId:owner}),[]);
 for(const job of jobs)await assert.rejects(f.extraction.trace(job.taskId),{code:'memory_extraction_not_found'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('独立文档轮已冻结图片后复验当前原图摘要，摘要变化不能沿旧身份继续',{timeout:20000},async t=>{
 const f=await imageLaterFixture(t,'image-later-current-digest'),schedule=await f.documents.readSchedule(f.scope);
 const job=await f.storage.execute('memoryDocuments.claimDue',{ownerId:owner,now:schedule.scene.dueAt});assert.ok(job.runId,JSON.stringify(job));
 assert.equal(await f.storage.execute('fixture.imageLaterRevalidate',{ownerId:owner,runId:job.runId}),true);
 await f.storage.execute('fixture.imageLaterDigestChange',{ownerId:owner,fileId:f.file.fileId});
 await assert.rejects(f.storage.execute('fixture.imageLaterRevalidate',{ownerId:owner,runId:job.runId}),{code:'memory_content_source_stale'});
 assert.equal(f.documentRequests.length,0,'当前图身份不符时尚未调用文档模型');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
