import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import sharp from "file:///Users/local-user/Documents/learn/NotAlone/node_modules/.pnpm/sharp@0.35.5_@types+node@26.6.4/node_modules/sharp/dist/index.cjs";
import {Context} from "file:///Users/local-user/Documents/learn/NotAlone/node_modules/.pnpm/@deepseek-ai+cordis@4.0.5_@deepseek-ai+cordis-plugin-include@1.0.10_@deepseek-ai+cordis-plugin-loader@1.0.6/node_modules/@deepseek-ai/cordis/lib/index.js";
import {LlmError} from "file:///Users/local-user/Documents/learn/NotAlone/node_modules/.pnpm/@deepseek-ai+dsh-llm@0.2.1-rc.2_@deepseek-ai+cordis@4.0.5/node_modules/@deepseek-ai/dsh-llm/lib/index.js";
import {resolveAdapterOptions} from "file:///Users/local-user/Documents/learn/NotAlone/node_modules/.pnpm/@deepseek-ai+dsh-llm-deepseek@0.2.1-rc.2_71960c16ca9e9b41dd26f4662f40e3b4/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js";
import {fixture} from "file:///Users/local-user/.codex/worktrees/image-input-reliability/NotAlone/backend-ts/test/media-support.mjs";
import {resolveHostReplyConfiguration} from '../../../backend-ts/src/host/host-reply-config.ts';
import {SqliteMemoryExtraction} from '../../../backend-ts/src/memory/sqlite/service.ts';
import {createSqliteExtractionModelPort} from '../../../backend-ts/src/memory/sqlite/model-port.ts';
import {createBuiltinMemoryContentRegistry} from '../../../backend-ts/src/memory/content/builtins.ts';
import {installModelProvider} from '../../../backend-ts/src/platform/models/model-provider.ts';
import {createModelPermitPort} from '../../../backend-ts/src/platform/models/model-permit-port.ts';
import {ModelPermitArbiter} from '../../../backend-ts/src/platform/models/model-permits.ts';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

function respond(res){
 const id=randomUUID(),events=[{type:'message_start',message:{id,type:'message',role:'assistant',model:'synthetic',content:[],usage:{input_tokens:3,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'tool_use',id:randomUUID(),name:'DirectMemoryExtractionOutput',input:{}}},
  {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"scenes":[]}'}},
  {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:2}},{type:'message_stop'}];
 res.setHeader('content-type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

test('本地供应商仅按指定图片发送摘要断连，正式提取二分至单图并降级，每个不同请求独立结算',{timeout:20000},async t=>{
 const pngs=await Promise.all(Array.from({length:4},(_,index)=>sharp({create:{width:1200,height:1600,channels:3,background:{r:20+index*53,g:60+index*31,b:180-index*23}}}).png().toBuffer()));
 let imageNo=0;const bytesById=new Map();
 const adapter={version:'synthetic-conditional-http-v1',supports:kind=>kind==='image',async execute(context){
  const bytes=pngs[imageNo++];
  await context.save({role:'image_display',expectedBytes:bytes.length,expectedSha256:hash(bytes),bytes:(async function*(){yield bytes;})(),validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-conditional-http-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-conditional-http'}};
 }};
 const f=await fixture(t,adapter);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:3},(_,index)=>({partition:'a',table:'one',localId:String(10+index),serverId:'0',sender:'contact',kind:'image',text:null,originalType:'image',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,stateAssurance:'verified'})),completedPartitions:['a'],exhausted:true});
 await f.history.synchronize(f.contact);
 const images=(await f.history.read(f.contact)).messages.filter(message=>message.kind==='image');assert.equal(images.length,4);
 for(const message of images){const index=imageNo,saved=await f.media.extract(f.contact,message.id,{requestKey:randomUUID(),goal:'extract'});bytesById.set(saved.files[0].fileId,pngs[index]);}
 await f.contacts.setReading(false);
 const targetId=[...bytesById.keys()][1],received=[],supplierErrors=[];let rejectedDigest;assert.equal(typeof targetId,'string');
 const server=createServer((req,res)=>{void(async()=>{
  assert.equal(req.url,'/anthropic/v1/messages');assert.equal(req.headers['x-api-key'],'synthetic-only');
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks),body=JSON.parse(raw);
  const digests=[];let targetLabel=false;
  for(const message of body.messages)for(const block of Array.isArray(message.content)?message.content:[]){
   if(block.type==='text'&&block.text.includes('图片 image_id='))targetLabel=block.text.includes('图片 image_id='+targetId+'（');
   if(block.type==='image'){const digest=hash(Buffer.from(block.source.data,'base64'));digests.push(digest);if(targetLabel&&rejectedDigest===undefined)rejectedDigest=digest;targetLabel=false;}
  }
  const rejected=digests.includes(rejectedDigest);received.push({bytes:raw.length,requestDigest:hash(raw),imageCount:digests.length,rejected});
  if(rejected){res.destroy();return;}respond(res);
 })().catch(error=>{supplierErrors.push(error);res.destroy();});});
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
 // 所有真实fetch只准到本轮合成供应商，认证固定为合成值。
 const fetch=globalThis.fetch;t.mock.method(globalThis,'fetch',(input,init)=>{const request=new Request(input,init);assert.equal(new URL(request.url).origin,origin);return fetch(input,init);});
 let adapterPort,service;const ctx={isolate:()=>new Context(),llm:{registerAdapter(_names,value){adapterPort=value;return async()=>{};},async prepareCall(config,signal){
  const prepared=await adapterPort.prepareCall(config.provider,config.model,signal);
  return {config,async *stream(options){try{yield* prepared.stream(options);}catch(error){if(!(error instanceof LlmError))throw error;yield {type:'finish',reason:{kind:'error',failure:error.failure}};}}};
 }}};
 const base=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});assert.equal(base.status,'configured');
 const configuration={...base,model:{...base.model,maxTokens:64},provider:{...base.provider,connection:resolveAdapterOptions({baseURL:origin+'/anthropic',thinking:'disabled',maxTokens:64,retryPolicy:{mode:'normal',maxRetries:0}}),strictVerificationEndpoint:origin+'/beta/chat/completions',resolveAuth:async()=>({headers:{'x-api-key':'synthetic-only'}})}};
 const arbiter=new ModelPermitArbiter(),reserved=new Map(),settled=new Map();
 const accounting={reserve:async(receipt,claim)=>{reserved.set(receipt.request_id,receipt);await service.accounting.reserve(receipt,claim);},recordReserved:async receipt=>{settled.set(receipt.request_id,receipt);await service.accounting.recordReserved(receipt);},unconfirmedRequests:scope=>service.accounting.unconfirmedRequests(scope)};
 const provider=installModelProvider(ctx,{...configuration.provider,resolveUserId:()=> 'synthetic-conditional-http'});
 const port=createSqliteExtractionModelPort({ctx,configuration,provider,permit:createModelPermitPort(arbiter,accounting),authorizePurpose:async()=>{}});
 service=new SqliteMemoryExtraction(f.storage,f.owner,port,f.media.holders,undefined,undefined,undefined,{registry:createBuiltinMemoryContentRegistry(),resources:{readImage:input=>f.media.readMemoryImage(input)}});
 t.after(async()=>{await service.close();await provider.dispose();arbiter.stop();server.closeAllConnections();await new Promise(done=>server.close(done));});
 const run=await service.start(randomUUID());await service.waitForIdle(run.runId);const done=await service.read(run.runId),task=done.tasks.find(task=>task.scopeKind==='contact');
 assert.equal(task.state,'succeeded',JSON.stringify(task));assert.equal(done.succeeded,run.total);assert.equal(done.isolated??0,0);assert.equal(done.unknown,0);
 assert.deepEqual(supplierErrors,[]);assert.equal(received.length,6,JSON.stringify({received,rejectedDigestBound:rejectedDigest!==undefined}));assert.equal(received.filter(request=>request.rejected).length,3);
 assert.deepEqual(received.filter(request=>request.rejected).map(request=>request.imageCount),[4,2,1]);assert.equal(new Set(received.map(request=>request.requestDigest)).size,6,'父窗与单图原请求不能盲重发');
 const trace=await service.trace(task.taskId);assert.equal(trace.calls.length,6);assert.equal(new Set(trace.calls.map(call=>call.callId)).size,6);
 assert.equal(trace.calls.filter(call=>call.state==='failed').length,3);assert.equal(trace.calls.filter(call=>call.state==='succeeded').length,3);
 assert.equal(reserved.size,6);assert.equal(settled.size,6);assert.equal(new Set([...reserved.values()].map(receipt=>receipt.attempt_id)).size,6);
 assert.equal([...settled.values()].filter(receipt=>receipt.outcome==='failed'&&receipt.terminal_failure==='transport').length,3);
 assert.deepEqual(await service.accounting.unconfirmedRequests({owner_id:f.owner,contact_id:f.contact}),[]);
 assert.ok(trace.events.some(event=>event.kind==='image_inputs'&&event.payload.images.some(image=>image.id===targetId&&image.normalizationTier==='degraded')));
 assert.equal(arbiter.snapshot().orphaned,0);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
