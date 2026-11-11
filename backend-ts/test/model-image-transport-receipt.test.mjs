import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Context} from '@deepseek-ai/cordis';
import {LlmError} from '@deepseek-ai/dsh-llm';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import sharp from 'sharp';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';
import {createSqliteExtractionModelPort} from '../src/memory/sqlite/model-port.ts';
import {installModelProvider} from '../src/platform/models/model-provider.ts';
import {createModelPermitPort} from '../src/platform/models/model-permit-port.ts';
import {ModelPermitArbiter} from '../src/platform/models/model-permits.ts';

async function fixture(t,{dropTerminal=false}={}){
 const base=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});assert.equal(base.status,'configured');
 const received=[];
 const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);received.push(Buffer.concat(chunks));res.destroy();});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${server.address().port}`,arbiter=new ModelPermitArbiter(),receipts=[],pending=new Map();let adapter;
 const ctx={isolate:()=>new Context(),llm:{registerAdapter(_names,value){adapter=value;return async()=>{};},async prepareCall(config,signal){
  const prepared=await adapter.prepareCall(config.provider,config.model,signal);
  // 模拟官方宿主把异常转换为不含cause的finish；真实请求和图片走正式adapter。
  return {config,async *stream(options){try{yield* prepared.stream(options);}catch(error){if(!(error instanceof LlmError))throw error;if(dropTerminal)return;yield {type:'finish',reason:{kind:'error',failure:error.failure}};}}};
 }}};
 const configuration={...base,model:{...base.model,maxTokens:64},provider:{...base.provider,connection:resolveAdapterOptions({baseURL:origin+'/anthropic',thinking:'disabled',maxTokens:64,retryPolicy:{mode:'normal',maxRetries:0}}),strictVerificationEndpoint:origin+'/beta/chat/completions',resolveAuth:async()=>({headers:{'x-api-key':'synthetic-only'}})}};
 const provider=installModelProvider(ctx,{...configuration.provider,resolveUserId:()=> 'synthetic-anonymous'});
 const accounting={reserve:async receipt=>{pending.set(receipt.request_id,receipt);},recordReserved:async receipt=>{receipts.push(receipt);pending.delete(receipt.request_id);},unconfirmedRequests:async()=>[...pending.keys()]};
 const port=createSqliteExtractionModelPort({ctx,configuration,provider,permit:createModelPermitPort(arbiter,accounting),authorizePurpose:async()=>{}});
 t.after(async()=>{await port.close();await provider.dispose();arbiter.stop();server.closeAllConnections();await new Promise(done=>server.close(done));});
 const image={id:'synthetic-image',mimeType:'image/png',dataBase64:(await sharp({create:{width:4,height:3,channels:3,background:'green'}}).png().toBuffer()).toString('base64')};
 const invoke=async({images=[image],stepName='extraction_verification',purpose='extraction',signal=new AbortController().signal,onReceipt=async()=>{}}={})=>{
  try{await port.invoke({purpose,system:'合成提取',user:'合成消息',tool:{name:purpose==='verification'?'SourceVerificationOutput':'DirectMemoryExtractionOutput',description:'合成结构输出',parameters:{type:'object',properties:{}}},images},
   {requestId:randomUUID(),attemptId:randomUUID(),scope:{owner_id:randomUUID(),contact_id:randomUUID()},claim:{task_id:randomUUID(),step_id:randomUUID(),step_name:stepName,worker_id:randomUUID(),lease_generation:0},signal,requireCurrent:async()=>{},onReceipt});assert.fail('合成连接关闭必须失败');}catch(error){return error;}
 };
 return {invoke,received,receipts,arbiter,accounting};
}

test('图片请求明确传输终态可独立结算，发送事实与成本仍未知且指标不含正文',async t=>{
 const f=await fixture(t),error=await f.invoke(),receipt=f.receipts.at(-1);
 assert.equal(error.code,'extraction_model_call_failed');
 assert.equal(receipt.terminal_failure,'transport');assert.equal(receipt.outcome,'failed');assert.equal(receipt.dispatch,'authorized_unconfirmed');
 assert.equal(receipt.cost.status,'unknown');assert.equal(receipt.usage,null);
 assert.equal(error.provider_failure.transport_category,'socket_closed');assert.equal(error.provider_failure.stage,'awaiting_response');
 assert.equal(error.provider_failure.request_bytes,f.received[0].length);assert.equal(error.provider_failure.image_count,1);assert.ok(error.provider_failure.elapsed_ms>=0);
 assert.doesNotMatch(JSON.stringify(error.provider_failure),/合成提取|合成消息|base64|cause|message/);
 assert.equal(f.arbiter.snapshot().backgroundActive,0);assert.equal(f.arbiter.snapshot().orphaned,0);
});

test('无图片传输失败保持原有未知合同并冻结后台许可',async t=>{
 const f=await fixture(t),error=await f.invoke({images:[]}),receipt=f.receipts.at(-1);
 assert.equal(error.code,'extraction_model_call_failed');assert.equal(receipt.outcome,'unknown');assert.equal(receipt.terminal_failure,undefined);
 assert.equal(f.arbiter.snapshot().orphaned,1);assert.equal(f.arbiter.snapshot().backgroundActive,1);
});

for(const [code,category] of [['ECONNRESET','reset'],['ETIMEDOUT','timeout'],['CERT_HAS_EXPIRED','tls'],['ENOTFOUND','dns'],['SYNTHETIC_UNCLASSIFIED','other']])test(`传输${category}只保留脱敏枚举，最终请求按UTF8字节记量`,async t=>{
 const f=await fixture(t);let requestBytes;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{requestBytes=Buffer.byteLength(options.body);throw new TypeError('PRIVATE_TRANSPORT_MESSAGE',{cause:Object.assign(new Error('PRIVATE_TRANSPORT_CAUSE'),{code})});});
 const error=await f.invoke();assert.equal(error.provider_failure.transport_category,category);
 assert.equal(error.provider_failure.request_bytes,requestBytes);assert.equal(error.provider_failure.stage,'awaiting_response');
 assert.equal(error.receipt.terminal_failure,'transport');assert.doesNotMatch(JSON.stringify(error),/PRIVATE_TRANSPORT|SYNTHETIC_UNCLASSIFIED|CERT_HAS_EXPIRED|ENOTFOUND/);
});

test('图片调用的账本确认失败仍为ACK未知，不能用终端标记释放许可',async t=>{
 const f=await fixture(t);f.accounting.recordReserved=async()=>{throw Error('PRIVATE_ACK_ERROR');};
 const error=await f.invoke();assert.equal(error.code,'extraction_model_ack_unknown');assert.equal(f.arbiter.snapshot().orphaned,1);
 assert.doesNotMatch(JSON.stringify(error),/PRIVATE_ACK_ERROR/);
});

test('预约后取消有明确未发送证明，不能获得传输降级标记',async t=>{
 const f=await fixture(t),controller=new AbortController(),reserve=f.accounting.reserve;
 f.accounting.reserve=async receipt=>{await reserve(receipt);controller.abort();};
 const error=await f.invoke({signal:controller.signal}),receipt=f.receipts.at(-1);
 assert.equal(error.code,'extraction_model_cancelled');assert.equal(receipt.dispatch,'not_sent');assert.equal(receipt.terminal_failure,undefined);
 assert.equal(error.provider_failure.stage,'before_send');assert.equal(f.received.length,0);assert.equal(f.arbiter.snapshot().orphaned,0);
});

test('非提取阶段的图片失败保持未知，不扩大裁决与后续整理合同',async t=>{
 const f=await fixture(t),error=await f.invoke({stepName:'adjudication'});
 assert.equal(error.receipt.outcome,'unknown');assert.equal(error.receipt.terminal_failure,undefined);assert.equal(f.arbiter.snapshot().orphaned,1);
});

test('底层TimeoutError以超时枚举呈现，不保留异常文字',async t=>{
 const f=await fixture(t);t.mock.method(globalThis,'fetch',async()=>{throw new DOMException('PRIVATE_TIMEOUT_TEXT','TimeoutError');});
 const error=await f.invoke();assert.equal(error.provider_failure.transport_category,'timeout');assert.doesNotMatch(JSON.stringify(error),/PRIVATE_TIMEOUT_TEXT/);
});

test('strict图片核验断连沿相同终端失败与请求字节合同结算',async t=>{
 const f=await fixture(t),error=await f.invoke({purpose:'verification'});
 assert.equal(error.receipt.terminal_failure,'transport');assert.equal(error.receipt.outcome,'failed');assert.equal(error.provider_failure.transport_category,'socket_closed');
 assert.equal(error.provider_failure.request_bytes,f.received[0].length);assert.equal(error.provider_failure.image_count,1);assert.equal(f.arbiter.snapshot().orphaned,0);
});

test('宿主没有给出模型终态时图片调用仍未知，不凭底层异常推定已结算',async t=>{
 const f=await fixture(t,{dropTerminal:true}),error=await f.invoke();
 assert.equal(error.receipt.outcome,'unknown');assert.equal(error.receipt.terminal_failure,undefined);assert.equal(f.arbiter.snapshot().orphaned,1);
});
