import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {LlmError} from '@deepseek-ai/dsh-llm';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import sharp from 'sharp';
import {configureDiagnosticLog,withDiagnosticTrace,eraseModelImageDiagnostic} from '../src/diagnostics/unified.ts';
import {readDiagnosticRecords,UnifiedDiagnosticLog} from '../src/diagnostics/unified-log.mjs';
import {checkedDiagnosticEvent} from '../src/diagnostics/unified-contract.mjs';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';
import {createSqliteExtractionModelPort} from '../src/memory/sqlite/model-port.ts';
import {installModelProvider} from '../src/platform/models/model-provider.ts';
import {createModelPermitPort} from '../src/platform/models/model-permit-port.ts';
import {ModelPermitArbiter} from '../src/platform/models/model-permits.ts';

async function fixture(t,{mode='success',inputBudget}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-image-diagnostics-'))),log=configureDiagnosticLog(root,{proc:'backend'});
 const received=[],server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const raw=Buffer.concat(chunks);received.push({bytes:raw.length,body:JSON.parse(raw),path:req.url});
  if(mode==='socket'){res.destroy();return;}
  if(req.url==='/strict/chat/completions'){
   res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'synthetic-tool',type:'function',function:{name:'SourceVerificationOutput',arguments:'{"results":[]}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:3,completion_tokens:2}}));return;
  }
  const events=[{type:'message_start',message:{id:'synthetic',model:'deepseek-flash',usage:{input_tokens:3,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
   {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'PRIVATE_SYNTHETIC_RESPONSE'}},
   {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}];
  res.setHeader('content-type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${server.address().port}`,arbiter=new ModelPermitArbiter(),pending=new Map();let adapter;
 const ctx={isolate:()=>new Context(),llm:{registerAdapter(_names,value){adapter=value;return async()=>{};},async prepareCall(config,signal){
  const prepared=await adapter.prepareCall(config.provider,config.model,signal);
  return {config,async *stream(options){try{yield* prepared.stream(options);}catch(error){if(!(error instanceof LlmError))throw error;yield {type:'finish',reason:{kind:'error',failure:error.failure}};}}};
 }}};
 const base=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'PRIVATE_SYNTHETIC_KEY'});assert.equal(base.status,'configured');
 const configuration={...base,model:{...base.model,maxTokens:64,...(inputBudget?{budgetProfile:{context_window_tokens:inputBudget+128,safety_margin_tokens:64}}:{})},
  provider:{...base.provider,connection:resolveAdapterOptions({baseURL:origin+'/anthropic',thinking:'disabled',maxTokens:64,retryPolicy:{mode:'normal',maxRetries:0}}),
   strictVerificationEndpoint:origin+'/strict/chat/completions',resolveAuth:async()=>({headers:{'x-api-key':'PRIVATE_SYNTHETIC_KEY'}})}};
 const provider=installModelProvider(ctx,{...configuration.provider,resolveUserId:()=> 'synthetic-anonymous'});
 const accounting={reserve:async receipt=>{pending.set(receipt.request_id,receipt);},recordReserved:async receipt=>{pending.delete(receipt.request_id);},unconfirmedRequests:async()=>[...pending.keys()]};
 const port=createSqliteExtractionModelPort({ctx,configuration,provider,permit:createModelPermitPort(arbiter,accounting),authorizePurpose:async()=>{}});
 const contactId=randomUUID(),imageId=randomUUID(),traceId=randomUUID();
 const original=await sharp({create:{width:32,height:24,channels:3,background:'green'}}).png().toBuffer();
 const image={id:imageId,mimeType:'image/png',dataBase64:original.toString('base64')};
 t.after(async()=>{await port.close();await provider.dispose();arbiter.stop();server.closeAllConnections();await new Promise(done=>server.close(done));await log.close();await rm(root,{recursive:true,force:true});});
 const invoke=async(purpose='extraction',images=[image])=>{
  const attemptId=randomUUID();let error;
  try{await withDiagnosticTrace(traceId,()=>port.invoke({purpose,system:'PRIVATE_SYNTHETIC_SYSTEM',user:'PRIVATE_SYNTHETIC_CHAT中文🟩',
   tool:{name:purpose==='verification'?'SourceVerificationOutput':'DirectMemoryExtractionOutput',description:'PRIVATE_SYNTHETIC_SCHEMA',parameters:{type:'object',properties:{}}},images},
   {requestId:randomUUID(),attemptId,scope:{owner_id:randomUUID(),contact_id:contactId},claim:{task_id:randomUUID(),step_id:randomUUID(),step_name:'extraction_verification',worker_id:randomUUID(),lease_generation:0},signal:new AbortController().signal,requireCurrent:async()=>{},onReceipt:async()=>{}}));}catch(caught){error=caught;}
  await log.flush();return {error,attemptId};
 };
 return {invoke,log,root,received,contactId,imageId,traceId,original,image,records:()=>readDiagnosticRecords(root)};
}

test('普通图片调用沿统一诊断记录最终字节和原图身份，不保存输入输出内容',async t=>{
 const f=await fixture(t),{error,attemptId}=await f.invoke();assert.equal(error,undefined);
 const records=(await f.records()).filter(row=>row.event.startsWith('processing.model_'));
 assert.equal(records.length,2,JSON.stringify({stats:f.log.stats(),records:await f.records()}));
 const call=records.find(row=>row.event==='processing.model_call'),image=records.find(row=>row.event==='processing.model_image');
 const encoded=f.received[0].body.messages.flatMap(message=>message.content).find(block=>block.type==='image').source.data;
 assert.equal(call.callId,attemptId);assert.equal(call.requestBytes,f.received[0].bytes);assert.equal(call.imageCount,1);
 assert.equal(image.imageId,f.imageId);assert.equal(image.originalBytes,f.original.length);assert.equal(image.sentBytes,Buffer.byteLength(encoded,'base64'));
 assert.equal(image.requestBytes,f.received[0].bytes);assert.equal(image.mimeType,'image/jpeg');assert.equal(image.width,32);assert.equal(image.height,24);
 for(const record of records){assert.equal(record.traceId,f.traceId);assert.equal(record.contactPrefix,f.contactId.slice(0,8));assert.equal(record.failureCategory,'none');assert.equal(record.stage,'response_received');assert.ok(record.durationMs>=0);}
 assert.doesNotMatch(JSON.stringify(records),/PRIVATE_SYNTHETIC|dataBase64|base64|sourceSha256|requestSha256|cause/);
 assert.equal(f.log.stats().rejected,0);
});

test('strict图片核验也记录最终实体字节，同一调用只发布一次汇总',async t=>{
 const f=await fixture(t),{error,attemptId}=await f.invoke('verification');assert.equal(error,undefined);
 const records=(await f.records()).filter(row=>row.event.startsWith('processing.model_'));
 assert.equal(records.length,2);
 const call=records.find(row=>row.event==='processing.model_call'),image=records.find(row=>row.event==='processing.model_image');
 const data=f.received[0].body.messages.flatMap(message=>Array.isArray(message.content)?message.content:[]).find(block=>block.type==='image_url').image_url.url.split(',')[1];
 assert.equal(call.callId,attemptId);assert.equal(call.requestBytes,f.received[0].bytes);assert.equal(call.toState,'succeeded');
 assert.equal(image.imageId,f.imageId);assert.equal(image.sentBytes,Buffer.byteLength(data,'base64'));
 assert.equal(image.originalBytes,f.original.length);assert.equal(image.failureCategory,'none');assert.equal(image.stage,'response_received');
 assert.doesNotMatch(JSON.stringify(records),/PRIVATE_SYNTHETIC|base64|cause/);assert.equal(f.log.stats().rejected,0);
});

test('普通与strict断连沿统一诊断只保存失败枚举与实际请求字节',async t=>{
 for(const purpose of ['extraction','verification']){
  const f=await fixture(t,{mode:'socket'}),{error,attemptId}=await f.invoke(purpose);assert.equal(error.code,'extraction_model_call_failed');
  const records=(await f.records()).filter(row=>row.event.startsWith('processing.model_'));
  assert.equal(records.length,2);
  for(const record of records){
   assert.equal(record.callId,attemptId);assert.equal(record.requestBytes,f.received[0].bytes);
   assert.equal(record.failureCategory,'socket_closed');assert.equal(record.stage,'awaiting_response');
   assert.ok(record.durationMs>=0);
  }
  assert.equal(records.find(row=>row.event==='processing.model_call').toState,'failed');
  assert.doesNotMatch(JSON.stringify(records),/PRIVATE_SYNTHETIC|other side closed|fetch failed|UND_ERR_SOCKET|base64|cause/);
 }
});

test('图片发送前预算失败仍记录已构建版本与测量阶段，不伪称发送成功',async t=>{
 const f=await fixture(t,{inputBudget:1}),{error}=await f.invoke();assert.equal(error.code,'extraction_model_budget_exceeded');
 assert.equal(error.provider_failure.stage,'before_send');assert.equal(error.provider_failure.image_count,1);assert.ok(error.provider_failure.request_bytes>0);
 assert.equal(f.received.length,0);
 const records=(await f.records()).filter(row=>row.event.startsWith('processing.model_'));
 assert.equal(records.length,2);
 for(const record of records){assert.equal(record.failureCategory,'model_budget');assert.equal(record.stage,'before_send');assert.ok(record.requestBytes>0);assert.equal(record.originalBytes,f.original.length);assert.ok(record.sentBytes>0);}
 assert.equal(records.find(row=>row.event==='processing.model_call').toState,'failed');
 assert.doesNotMatch(JSON.stringify(records),/PRIVATE_SYNTHETIC|base64|cause/);
});

test('图片调用诊断遵守联系人清理与字段白名单，异常正文和任意图片标识不得进入日志',async t=>{
 const f=await fixture(t);await f.invoke();assert.equal((await f.records()).length,2);
 assert.equal(await f.log.eraseContact(f.contactId.slice(0,8)),true);assert.deepEqual(await f.records(),[]);
 const base={event:'processing.model_image',callId:randomUUID(),imageId:randomUUID(),originalBytes:10,sentBytes:20,imageCount:1,requestBytes:30,stage:'before_send',failureCategory:'other'};
 for(const bad of [{...base,cause:'PRIVATE_SYNTHETIC_CAUSE'},{...base,imageId:'PRIVATE_SYNTHETIC_CHAT'}, {...base,failureCategory:'PRIVATE_SYNTHETIC_CAUSE'}, {...base,requestBytes:-1}]){
  assert.equal(checkedDiagnosticEvent(bad),undefined);f.log.diagnose(bad);
 }
 await f.log.flush();assert.deepEqual(await f.records(),[]);assert.equal(f.log.stats().rejected,4);
});

test('八图调用只新增九条有界事件，各图片保留身份和准确合计',async t=>{
 const f=await fixture(t),images=Array.from({length:8},()=>({...f.image,id:randomUUID()})),{error}=await f.invoke('extraction',images);
 assert.equal(error,undefined);assert.equal(f.received.length,1);
 const records=await f.records(),call=records.find(row=>row.event==='processing.model_call'),items=records.filter(row=>row.event==='processing.model_image');
 assert.equal(records.length,9);assert.equal(items.length,8);assert.equal(call.imageCount,8);assert.equal(call.originalBytes,f.original.length*8);
 assert.equal(call.sentBytes,items.reduce((sum,image)=>sum+image.sentBytes,0));
 assert.deepEqual(new Set(items.map(image=>image.imageId)),new Set(images.map(image=>image.id)));
 assert.ok(records.every(row=>row.requestBytes===f.received[0].bytes));assert.equal(f.log.stats().rejected,0);
});

test('关闭统一诊断不记录图片元数据，也不阻断正常模型调用',async t=>{
 const f=await fixture(t);assert.equal(await f.log.setEnabled(false),true);
 const {error}=await f.invoke();assert.equal(error,undefined);assert.equal(f.received.length,1);assert.deepEqual(await f.records(),[]);
});

test('单图片擦除跨统一日志进程文件清除对应标识，保留其他图片和无标识汇总',async t=>{
 const f=await fixture(t),other={...f.image,id:randomUUID()};await f.invoke('extraction',[f.image,other]);
 const main=new UnifiedDiagnosticLog(f.root,{proc:'main'});t.after(()=>main.close());
 for(const record of await f.records())if(record.event==='processing.model_image'){
  const {time,proc,level,...event}=record;main.diagnose(event);
 }
 await main.flush();assert.equal((await f.records()).length,5);
 assert.equal(typeof f.log.eraseModelImage,'function');
 assert.equal(await eraseModelImageDiagnostic(f.imageId),true);
 const remaining=await f.records();assert.equal(remaining.length,3);
 assert.equal(remaining.filter(row=>row.imageId===other.id).length,2);
 assert.equal(remaining.filter(row=>row.event==='processing.model_call').length,1);
 assert.doesNotMatch(JSON.stringify(remaining),new RegExp(f.imageId));
 assert.equal(await f.log.eraseModelImage('PRIVATE_SYNTHETIC_CHAT'),false);assert.equal((await f.records()).length,3);
});

test('单图片删除在惰性初始化期间同时清除待写元数据，保留无关事件',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-image-diagnostic-pending-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const context=new URL('../src/diagnostics/context.ts',import.meta.url).href,reader=new URL('../src/diagnostics/unified-log.mjs',import.meta.url).href;
 const source=`import {diagnose,eraseModelImageDiagnostic,diagnosticLog} from ${JSON.stringify(context)};
 import {readDiagnosticRecords} from ${JSON.stringify(reader)};
 const id='00000000-0000-4000-8000-000000000001';
 diagnose({event:'processing.model_image',callId:'00000000-0000-4000-8000-000000000002',imageId:id,originalBytes:10,sentBytes:20,imageCount:1,requestBytes:30,stage:'before_send',failureCategory:'other'});
 diagnose({event:'diagnostics.changed',count:1});
 const removed=await eraseModelImageDiagnostic(id);await diagnosticLog()?.flush();
 const records=await readDiagnosticRecords(process.env.NOTALONE_DIAGNOSTIC_ROOT);
 process.stdout.write(JSON.stringify({removed,total:records.length,hasImage:records.some(row=>row.imageId===id),kept:records.some(row=>row.event==='diagnostics.changed')}));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',source],{env:{PATH:process.env.PATH,HOME:root,NOTALONE_DIAGNOSTIC_ROOT:root},encoding:'utf8',timeout:10000});
 assert.equal(child.status,0);assert.deepEqual(JSON.parse(child.stdout),{removed:true,total:1,hasImage:false,kept:true});
});

test('单图片诊断擦除遇到不安全目录时返回失败，不冒称已清理',async t=>{
 const f=await fixture(t);await f.invoke();await chmod(f.root,0o777);
 try{assert.equal(await eraseModelImageDiagnostic(f.imageId),false);}finally{await chmod(f.root,0o700);}
 assert.equal((await f.records()).filter(row=>row.imageId===f.imageId).length,1);
});
