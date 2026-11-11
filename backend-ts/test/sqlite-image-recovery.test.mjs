import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {imageFixture} from './fixtures/memory-sqlite/image-support.mjs';

test('明确终端传输失败按不同子窗二分记账，文字目标只处理一次且账本无未知',async t=>{
 const f=await imageFixture(t,4,request=>(request.images?.length??0)>1);
 const run=await f.service.start(randomUUID());await f.service.waitForIdle(run.runId);
 const done=await f.service.read(run.runId);
 assert.equal(done.succeeded,run.total,JSON.stringify(done.tasks));assert.equal(done.failed,0);assert.equal(done.unknown,0);
 assert.equal(f.requests.length,7);
 const successful=f.requests.filter(request=>request.images.length===1).flatMap(request=>JSON.parse(request.user).target_message_ids);
 assert.equal(successful.length,run.total);assert.equal(new Set(successful).size,run.total);
 const trace=await f.service.trace(done.tasks.find(task=>task.scopeKind==='contact').taskId);
 assert.equal(trace.calls.filter(call=>call.state==='unknown'||call.state==='prepared'||call.state==='sending').length,0);
 assert.equal(trace.calls.length,7);assert.equal(trace.calls.filter(call=>call.state==='failed').length,3);
 assert.ok(trace.events.some(event=>event.kind==='image_input_degraded'));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});


test('一张图降级仍失败时隔离并完成其他目标，显式重试沿原轮成功恢复',async t=>{
 let badId=null,broken=true;
 const f=await imageFixture(t,3,request=>broken&&request.images.some(image=>image.id===badId));
 badId=f.files.get(f.messages[1].id);
 const run=await f.service.start(randomUUID());await f.service.waitForIdle(run.runId);
 const done=await f.service.read(run.runId);
 assert.equal(done.isolated,1);assert.equal(done.succeeded,run.total-1);assert.equal(done.failed,0);assert.equal(done.unknown,0);
 assert.equal(done.tasks.find(task=>task.scopeKind==='contact').state,'succeeded');
 assert.ok(done.actions.includes('retry_images'));
 const view=await f.service.readContact(f.contact);assert.equal(view.queue.content.find(item=>item.kind==='image').isolated,1);
 const trace=await f.service.trace(done.tasks.find(task=>task.scopeKind==='contact').taskId);
 assert.ok(trace.events.some(event=>event.kind==='media_input_isolated'&&event.payload.reason==='media_model_input_unavailable'));
 assert.equal(trace.calls.some(call=>['unknown','prepared','sending'].includes(call.state)),false);
 broken=false;const operationId=randomUUID();
 await f.service.retryImages(run.runId,done.controlVersion,operationId);await f.service.waitForIdle(run.runId);
 const after=await f.service.read(run.runId);assert.equal(after.isolated??0,0);assert.equal(after.succeeded,run.total);
 const calls=f.requests.length;await f.service.retryImages(run.runId,done.controlVersion,operationId);await f.service.waitForIdle(run.runId);
 assert.equal(f.requests.length,calls,'同一次重试回执重放不重新调用模型');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('连续三张单图均不可用时持久暂停，后续图片保持未处理且不继续花费',async t=>{
 const f=await imageFixture(t,4,request=>request.images.length>0);
 const run=await f.service.start(randomUUID());await f.service.waitForIdle(run.runId);
 const done=await f.service.read(run.runId);assert.equal(done.state,'paused');assert.equal(done.isolated,3);
 assert.ok(f.requests.length<=12);assert.ok(done.total>done.isolated+done.succeeded);
 const trace=await f.service.trace(done.tasks.find(task=>task.scopeKind==='contact').taskId);
 assert.equal(trace.calls.some(call=>['unknown','prepared','sending'].includes(call.state)),false);
 const count=f.requests.length;await f.service.recoverBacklog({wait:true});await f.service.resumeFollowups();await f.service.waitForIdle();assert.equal(f.requests.length,count);
});

test('单个受管图片文件丢失时隔离原目标，其他图片与文字继续完成',async t=>{
 const f=await imageFixture(t,2,()=>false),message=f.messages[0],fileId=f.files.get(message.id);
 const file=await f.storage.execute('media.file',{ownerId:f.owner,contactId:f.contact,messageId:message.id,fileId});
 await unlink(join(f.root,'managed','media',file.address.locator));
 const run=await f.service.start(randomUUID());await f.service.waitForIdle(run.runId);
 const done=await f.service.read(run.runId);assert.equal(done.isolated,1);assert.equal(done.succeeded,run.total-1);assert.equal(done.failed,0);
 assert.equal(done.tasks.find(task=>task.scopeKind==='contact').state,'succeeded');
 assert.ok(f.requests.length>0);assert.equal(f.requests.some(request=>request.images.some(image=>image.id===fileId)),false);
});
