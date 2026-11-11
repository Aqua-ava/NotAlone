import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {supplier} from './fixtures/memory-management/supplier.mjs';
import {SqliteMediaService} from '../src/media/sqlite/service.ts';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {ExtractionModelError} from '../src/memory/extraction/model.ts';
import {createBuiltinMemoryContentRegistry} from '../src/memory/content/builtins.ts';

const png=await sharp({create:{width:1200,height:1600,channels:3,background:'orange'}}).png().toBuffer();
const adapter={version:'synthetic-image-owner-retry',supports:kind=>kind==='image',async execute(context){
 await context.save({role:'image_display',bytes:(async function*(){yield png;})(),expectedBytes:png.length,expectedSha256:createHash('sha256').update(png).digest('hex'),
  validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});
 return {association:{protocol:'media-association-v1',profileId:'synthetic-image-owner-retry',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-image'}};
}};
const fields=['attribution','body','temporal_and_modality','category','topic','scene_name','alternatives','interpretation_reason','valid_at','invalid_at','speech_act','assertion_status','figurative_type','event','conditions'];
const imageFact=(id,color='橙色')=>({text:`用户有一个${color}杯子。`,subject:'self',category:'common_fact',topic:'other',source_message_ids:[id],confidence:0.8,risk_flags:[],valid_at:null,invalid_at:null,
 speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'合成模型输出用于验证本人贡献接线。',event:null,conditions:null});

async function retryFixture(t,{existingFact=false}={}){
 const f=await fixture(t),contact=f.saved[0].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{sender:'owner',kind:'image',text:null,originalType:'image'}),record('2',{sender:'owner',text:'合成背景。'}),...(existingFact?[record('3',{sender:'owner',kind:'image',text:null,originalType:'image'})]:[])],completedPartitions:f.target.partitions,exhausted:true});
 await f.service.synchronize(contact);
 const media=new SqliteMediaService({storage:f.storage,contacts:f.contacts,history:f.service,userData:f.root,adapters:[adapter]});await media.initialize();t.after(()=>media.close());
 const images=(await f.service.read(contact)).messages.filter(message=>message.kind==='image'),image=images.at(-1);let healthyFileId=null;
 for(const current of images){const saved=await media.extract(contact,current.id,{requestKey:`synthetic-owner-retry-${current.id}`,goal:'extract'});if(existingFact&&current===images[0])healthyFileId=saved.files[0].fileId;}
 let extraction,broken=true;const receipts=new Map();
 const accounting=()=>({...extraction.accounting,reserve:async(receipt,claim)=>{receipts.set(receipt.attempt_id,receipt);return extraction.accounting.reserve(receipt,claim);}});
 const model=modelPort(accounting,async(request,input)=>{
  if(broken&&request.images?.some(image=>image.id!==healthyFileId)){
   const receipt={...receipts.get(input.attemptId),outcome:'failed',terminal_failure:'transport',latency_ms:1};
   await input.onReceipt(receipt);await extraction.accounting.recordReserved(receipt);
   throw new ExtractionModelError('extraction_model_call_failed',receipt,{name:'LlmError',code:'TRANSPORT'});
  }
  const body=JSON.parse(request.user);let value;
  if(request.purpose==='extraction'){
   const image=body.messages.find(message=>message.content_kind==='image');
   value={scenes:image?[{scene_name:'合成本人资料',memories:[imageFact(image.message_id,existingFact&&image.message_id===images[0].id?'蓝色':'橙色')]}]:[]};
  }else value={results:body.candidates.map((candidate,candidate_index)=>({candidate_index,verdict:'supported',issues:[],
   evidence:[{kind:'image',message_id:candidate.source_message_ids[0],quote:null,description:'合成图片明确支持测试中的本人主张。'}],scope_subject:'self',actor_kind:'self',resolution:'explicit',
   checks:fields.map(field=>({field,verdict:'supported',evidence_indices:[0],explanation:'合成来源支持该字段。'}))}))};
  const blocks=[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify(value)}];await request.validateOutput(blocks);return {blocks};
 });
 extraction=new SqliteMemoryExtraction(f.storage,owner,model,media.holders,undefined,undefined,undefined,{registry:createBuiltinMemoryContentRegistry(),resources:{readImage:input=>media.readMemoryImage(input)}});t.after(()=>extraction.close());
 const run=await extraction.start(randomUUID());await extraction.waitForIdle(run.runId);
 return {...f,contact,media,image,extraction,model,run,repair:()=>{broken=false;}};
}

test('隔离图片重试产生本人候选时追加真实producer，保留原成功历史且不重复贡献',async t=>{
 const f=await retryFixture(t),before=await f.extraction.read(f.run.runId),self=before.tasks.find(task=>task.scopeKind==='self');
 const old=await f.extraction.trace(self.taskId);assert.equal(self.state,'succeeded');assert.equal(before.isolated,1);
 assert.equal(old.events.filter(event=>event.kind==='stage_result').length,1);assert.equal(old.events.filter(event=>event.kind==='verified_output').length,0);
 f.repair();const operationId=randomUUID();await f.extraction.retryImages(f.run.runId,before.controlVersion,operationId);await f.extraction.waitForIdle(f.run.runId);
 const after=await f.extraction.read(f.run.runId),trace=await f.extraction.trace(self.taskId),outputs=trace.events.filter(event=>event.kind==='verified_output');
 assert.equal(after.isolated??0,0);assert.equal(after.succeeded,before.total);
 assert.equal(outputs.length,1,'重试新增的本人贡献不能被旧成功producer短路');
 assert.equal(outputs[0].payload.fact.subject,'self');assert.equal(outputs[0].payload.fact.text,'用户有一个橙色杯子。');
 assert.equal(after.candidates.filter(candidate=>candidate.scopeKind==='self').length,1);
 assert.equal(trace.events.filter(event=>event.kind==='stage_result').length,2,'原无产出成功阶段保持原样');
 assert.ok(old.events.every(event=>trace.events.some(current=>current.eventId===event.eventId&&current.attemptId===event.attemptId)));
 assert.equal(trace.calls.length,0,'本人归集不制造新的模型调用');
 const management=new SqliteMemoryManagement(f.storage,owner);await management.importRun(f.run.runId);
 const scope={scopeKind:'self',contactId:null},pending=await management.read(scope);assert.equal(pending.candidates.length,1,'候选沿正常采纳入口可见');
 const calls=f.model.calls;await f.extraction.retryImages(f.run.runId,before.controlVersion,operationId);await f.extraction.waitForIdle(f.run.runId);
 await management.importRun(f.run.runId);assert.equal(f.model.calls,calls);assert.equal((await management.read(scope)).candidates.length,1);
 assert.equal((await f.extraction.trace(self.taskId)).events.length,trace.events.length);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('重试新增的本人图片候选沿正式清图删除，原贡献和派生输出不会残留',async t=>{
 const f=await retryFixture(t),before=await f.extraction.read(f.run.runId);f.repair();
 await f.extraction.retryImages(f.run.runId,before.controlVersion,randomUUID());await f.extraction.waitForIdle(f.run.runId);
 const management=new SqliteMemoryManagement(f.storage,owner),scope={scopeKind:'self',contactId:null};await management.importRun(f.run.runId);
 assert.equal((await management.read(scope)).candidates.length,1);
 const cleared=await f.media.clear(f.contact,f.image.id,'delete-retried-owner-image');assert.equal(cleared.state,'cleared');
 const after=await management.read(scope);assert.equal(after.candidates.length,0);assert.equal(after.memories.length,0);
 assert.equal((await f.extraction.read(f.run.runId)).candidates.length,0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('已有本人记忆后仅归集重试新增贡献，旧采纳及独立图片来源不被重放或清除',async t=>{
 const f=await retryFixture(t,{existingFact:true}),management=new SqliteMemoryManagement(f.storage,owner),scope={scopeKind:'self',contactId:null};
 const before=await f.extraction.read(f.run.runId),self=before.tasks.find(task=>task.scopeKind==='self');await management.importRun(f.run.runId);
 const candidate=(await management.read(scope)).candidates[0];assert.equal(candidate.body,'用户有一个蓝色杯子。');
 await management.automatic({requestKey:'adopt-owner-before-image-retry',action:'auto_accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});
 const oldTrace=await f.extraction.trace(self.taskId);f.repair();
 await f.extraction.retryImages(f.run.runId,(await f.extraction.read(f.run.runId)).controlVersion,randomUUID());await f.extraction.waitForIdle(f.run.runId);await management.importRun(f.run.runId);
 const trace=await f.extraction.trace(self.taskId),outputs=trace.events.filter(event=>event.kind==='verified_output');
 assert.equal(outputs.length,2);assert.ok(oldTrace.events.every(event=>trace.events.some(current=>current.eventId===event.eventId)));
 const view=await management.read(scope);assert.deepEqual(view.candidates.map(candidate=>candidate.body),['用户有一个橙色杯子。']);assert.deepEqual(view.memories.map(memory=>memory.current?.body),['用户有一个蓝色杯子。']);
 await f.media.clear(f.contact,f.image.id,'delete-only-retried-owner-image');
 const after=await management.read(scope);assert.equal(after.candidates.length,0);assert.deepEqual(after.memories.map(memory=>memory.current?.body),['用户有一个蓝色杯子。']);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('本人归集按有界步骤处理新增贡献，重复收尾不追加成功producer',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:70},(_,index)=>record(String(index+1),{sender:'owner',text:`我长期喜欢合成园艺${index+1}。`})),completedPartitions:f.target.partitions,exhausted:true});
 await f.service.synchronize(contact);let extraction;const supplied=supplier(),model=modelPort(()=>extraction.accounting,supplied.respond);
 extraction=new SqliteMemoryExtraction(f.storage,owner,model);t.after(()=>extraction.close());
 const run=await extraction.start(randomUUID());await extraction.waitForIdle(run.runId);
 const done=await extraction.read(run.runId),self=done.tasks.find(task=>task.scopeKind==='self'),trace=await extraction.trace(self.taskId);
 const outputs=trace.events.filter(event=>event.kind==='verified_output'),byAttempt=new Map();
 for(const event of outputs)byAttempt.set(event.attemptId,(byAttempt.get(event.attemptId)??0)+1);
 assert.equal(outputs.length,70);assert.equal(byAttempt.size,2);assert.ok([...byAttempt.values()].every(count=>count<=60));
 assert.equal(done.candidates.filter(candidate=>candidate.scopeKind==='self').length,70);assert.equal(trace.calls.length,0);
 const calls=model.calls;await f.storage.execute('memoryExtraction.settleRun',{ownerId:owner,runId:run.runId});
 assert.equal(model.calls,calls);assert.equal((await extraction.trace(self.taskId)).events.length,trace.events.length);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
