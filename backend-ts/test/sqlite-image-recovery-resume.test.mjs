import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {fixture} from './media-support.mjs';
import {modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {ExtractionModelError} from '../src/memory/extraction/model.ts';
import {ModelImageNormalizationError} from '../src/platform/models/image-normalization.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {createBuiltinMemoryContentRegistry} from '../src/memory/content/builtins.ts';

const png=await sharp({create:{width:64,height:96,channels:3,background:'#548bba'}}).png().toBuffer();
const adapter={version:'synthetic-image-resume-v1',supports:kind=>kind==='image',async execute(context){
 await context.save({role:'image_display',bytes:(async function*(){yield png;})(),expectedBytes:png.length,
  expectedSha256:createHash('sha256').update(png).digest('hex'),
  validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});
 return {association:{protocol:'media-association-v1',profileId:'synthetic-image-resume-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-image-resume'}};
}};

async function savedImageFixture(t){
 const f=await fixture(t,adapter);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,
  records:Array.from({length:3},(_,index)=>({partition:'a',table:'one',localId:String(10+index),serverId:'0',sender:'contact',kind:'image',text:null,originalType:'image',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,stateAssurance:'verified'})),
  completedPartitions:['a'],exhausted:true});
 await f.history.synchronize(f.contact);
 for(const message of (await f.history.read(f.contact)).messages.filter(message=>message.kind==='image'))
  await f.media.extract(f.contact,message.id,{requestKey:`resume-${message.id}`,goal:'extract'});
 return f;
}

test('恢复时单图准备失败仍保留原降级树，成功兄弟复用回执且其余目标完成',async t=>{
 const f=await savedImageFixture(t);
 let service,configurationUnavailable=true,localImageUnavailable=false,unavailableFileId=null;
 const requests=[],successfulLeaves=[],receipts=new Map();
 const accounting=()=>({...service.accounting,reserve:async(receipt,claim)=>{
  receipts.set(receipt.attempt_id,receipt);return service.accounting.reserve(receipt,claim);
 }});
 const model=modelPort(accounting,async(request,input)=>{
  const imageIds=(request.images??[]).map(image=>image.id);requests.push(imageIds);
  if(imageIds.length>1){
   const receipt={...receipts.get(input.attemptId),outcome:'failed',terminal_failure:'transport',latency_ms:1};
   await input.onReceipt(receipt);await service.accounting.recordReserved(receipt);
   throw new ExtractionModelError('extraction_model_call_failed',receipt,{name:'LlmError',code:'TRANSPORT',transport_category:'socket_closed'});
  }
  if(imageIds.length===1){successfulLeaves.push(imageIds[0]);unavailableFileId??=imageIds[0];}
  return {blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]};
 });
 const prepare=model.prepare;
 model.prepare=async(request,input)=>{
  // 左侧两个叶已返回，右侧父窗尚未预约，因此没有未知调用。
  if(configurationUnavailable&&successfulLeaves.length>=2&&(request.images?.length??0)>1)
   throw new StorageFailure('extraction_model_credentials_unavailable');
  return prepare(request,input);
 };
 service=new SqliteMemoryExtraction(f.storage,f.owner,model,f.media.holders,undefined,undefined,undefined,
  {registry:createBuiltinMemoryContentRegistry(),resources:{readImage:input=>
   localImageUnavailable&&input.fileId===unavailableFileId
    ?Promise.reject(new ModelImageNormalizationError('extraction_model_image_invalid'))
    :f.media.readMemoryImage(input)}});
 t.after(()=>service.close());

 const run=await service.start(randomUUID());await service.waitForIdle(run.runId);
 const paused=await service.read(run.runId);
 assert.equal(paused.state,'paused');assert.equal(successfulLeaves.length,2);assert.equal(requests.length,4);
 assert.equal(paused.tasks.find(task=>task.scopeKind==='contact').errorCode,'extraction_model_credentials_unavailable');
 const rootRequest=[...requests[0]],leftRequest=[...requests[1]],healthySibling=successfulLeaves[1];

 configurationUnavailable=false;localImageUnavailable=true;
 await service.continue(run.runId,paused.controlVersion,randomUUID());await service.waitForIdle(run.runId);
 const done=await service.read(run.runId),contact=done.tasks.find(task=>task.scopeKind==='contact');
 assert.equal(contact.state,'succeeded',JSON.stringify(contact));assert.equal(done.succeeded,run.total-1);
 assert.equal(done.isolated,1);assert.equal(done.failed,0);assert.equal(done.unknown,0);
 assert.equal(requests.filter(ids=>JSON.stringify(ids)===JSON.stringify(rootRequest)).length,1,'原父窗不重发');
 assert.equal(requests.filter(ids=>JSON.stringify(ids)===JSON.stringify(leftRequest)).length,1,'已降级左父窗不重发');
 assert.equal(requests.filter(ids=>ids.length===1&&ids[0]===healthySibling).length,1,'健康成功叶沿原槽复用回执');
 assert.equal(requests.length,7,'恢复只发送右父窗和两个新叶');
 const trace=await service.trace(contact.taskId);
 assert.ok(trace.events.some(event=>event.kind==='model_reused'));
 assert.equal(trace.calls.some(call=>['unknown','prepared','sending'].includes(call.state)),false);
 assert.ok(trace.events.some(event=>event.kind==='media_input_isolated'&&event.payload.file_id===unavailableFileId));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('终端回执已保存但降级登记前中断，恢复补齐原槽计划且不重发原父窗',async t=>{
 const f=await savedImageFixture(t);
 let service,interruptBeforeSupersede=true;
 const requests=[],receipts=new Map();
 const execute=f.storage.execute.bind(f.storage);
 f.storage.execute=(name,input,...rest)=>{
  // 故障发生在动作事务之前；原终端回执已持久化，不能把它当成尚未调用。
  if(name==='memoryExtraction.supersedeImageInput'&&interruptBeforeSupersede){
   interruptBeforeSupersede=false;return Promise.reject(new Error('synthetic_before_degradation_transaction'));
  }
  return execute(name,input,...rest);
 };
 const accounting=()=>({...service.accounting,reserve:async(receipt,claim)=>{
  receipts.set(receipt.attempt_id,receipt);return service.accounting.reserve(receipt,claim);
 }});
 const model=modelPort(accounting,async(request,input)=>{
  const imageIds=(request.images??[]).map(image=>image.id);requests.push(imageIds);
  if(imageIds.length>1){
   const receipt={...receipts.get(input.attemptId),outcome:'failed',terminal_failure:'transport',latency_ms:1};
   await input.onReceipt(receipt);await service.accounting.recordReserved(receipt);
   throw new ExtractionModelError('extraction_model_call_failed',receipt,{name:'LlmError',code:'TRANSPORT',transport_category:'socket_closed'});
  }
  return {blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]};
 });
 service=new SqliteMemoryExtraction(f.storage,f.owner,model,f.media.holders,undefined,undefined,undefined,
  {registry:createBuiltinMemoryContentRegistry(),resources:{readImage:input=>f.media.readMemoryImage(input)}});
 t.after(()=>service.close());
 const run=await service.start(randomUUID());await service.waitForIdle(run.runId);
 const stopped=await service.read(run.runId),contactTaskId=stopped.tasks.find(task=>task.scopeKind==='contact').taskId;
 assert.equal(stopped.state,'failed');assert.equal(requests.length,1);
 const before=await service.trace(contactTaskId),rootCall=before.calls[0],rootInput=before.events.find(event=>event.kind==='model_input');
 assert.equal(rootCall.state,'failed');assert.equal(before.events.some(event=>event.kind==='image_input_degraded'),false);
 assert.deepEqual(await service.accounting.unconfirmedRequests({owner_id:f.owner,contact_id:f.contact}),[]);
 const rootRequest=[...requests[0]];

 await service.continue(run.runId,stopped.controlVersion,randomUUID());await service.waitForIdle(run.runId);
 assert.equal(requests.filter(ids=>JSON.stringify(ids)===JSON.stringify(rootRequest)).length,1,'回执与登记之间中断不能重发原父窗');
 const done=await service.read(run.runId);assert.equal(done.tasks.find(task=>task.scopeKind==='contact').state,'succeeded');
 assert.equal(done.succeeded,run.total);assert.equal(done.isolated??0,0);assert.equal(done.unknown,0);
 assert.equal(requests.length,7);
 const after=await service.trace(contactTaskId);
 const recovered=after.events.find(event=>event.kind==='image_input_degraded'&&event.payload.priorCallId===rootCall.callId);
 assert.ok(recovered,'从原失败账本补齐降级计划');assert.equal(recovered.payload.slot,0);
 assert.notEqual(recovered.attemptId,rootInput.attemptId);assert.equal(recovered.callId??null,null,'旧失败调用不伪造当前producer或成功复用');
 assert.equal(after.calls.some(call=>['unknown','prepared','sending'].includes(call.state)),false);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
