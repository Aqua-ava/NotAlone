import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {fixture} from './media-support.mjs';
import {modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {ExtractionModelError} from '../src/memory/extraction/model.ts';
import {createBuiltinMemoryContentRegistry} from '../src/memory/content/builtins.ts';

const png=await sharp({create:{width:1200,height:1600,channels:3,background:'#aadd88'}}).png().toBuffer();
const adapter={version:'synthetic-image-recovery-v1',supports:kind=>kind==='image',async execute(context){
 await context.save({role:'image_display',bytes:(async function*(){yield png;})(),expectedBytes:png.length,expectedSha256:createHash('sha256').update(png).digest('hex'),
  validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});
 return {association:{protocol:'media-association-v1',profileId:'synthetic-image-recovery-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-image-recovery'}};
}};

async function imageFixture(t,count,fail){
 const f=await fixture(t,adapter);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:count-1},(_,i)=>({partition:'a',table:'one',localId:String(10+i),serverId:'0',sender:'contact',kind:'image',text:null,originalType:'image',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,stateAssurance:'verified'})),completedPartitions:['a'],exhausted:true});
 await f.history.synchronize(f.contact);
 const messages=(await f.history.read(f.contact)).messages.filter(message=>message.kind==='image');
 const files=new Map();for(const message of messages){const saved=await f.media.extract(f.contact,message.id,{requestKey:`synthetic-recovery-${message.id}`,goal:'extract'});files.set(message.id,saved.files[0].fileId);}
 let service;const requests=[],receipts=new Map();
 const accounting=()=>({...service.accounting,reserve:async(receipt,claim)=>{receipts.set(receipt.attempt_id,receipt);return service.accounting.reserve(receipt,claim);}});
 const model=modelPort(accounting,async(request,input)=>{
  requests.push(request);
  if(fail(request)){
   const receipt={...receipts.get(input.attemptId),outcome:'failed',terminal_failure:'transport',latency_ms:1};
   await input.onReceipt(receipt);await service.accounting.recordReserved(receipt);
   throw new ExtractionModelError('extraction_model_call_failed',receipt,{name:'LlmError',code:'TRANSPORT',transport_category:'socket_closed',stage:'awaiting_response',elapsed_ms:1,request_bytes:100,image_count:request.images?.length??0});
  }
  return {blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]};
 });
 service=new SqliteMemoryExtraction(f.storage,f.owner,model,f.media.holders,undefined,undefined,undefined,{registry:createBuiltinMemoryContentRegistry(),resources:{readImage:input=>f.media.readMemoryImage(input)}});
 t.after(()=>service.close());return {...f,service,requests,messages,files};
}

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

export {imageFixture};

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
