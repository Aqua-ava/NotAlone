// 合成图片复现本地图片预算错误被官方适配器映射为 TRANSPORT；禁止任何网络发送。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {ModelImageAttachments} from '../../../backend-ts/src/platform/models/model-images.ts';
const require=createRequire(new URL('../../../backend-ts/package.json',import.meta.url));
const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const {DeepSeekAdapter,DeepSeekFileStore,resolveAdapterOptions,resolveRequestImageTarget}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-deepseek')));
const {default:sharp}=await import(pathToFileURL(require.resolve('sharp')));
const width=1280,height=1706,raw=Buffer.alloc(width*height*3);let state=0x12345678;
for(let i=0;i<raw.length;i++){state^=state<<13;state^=state>>>17;state^=state<<5;raw[i]=state&255;}
const original=await sharp(raw,{raw:{width,height,channels:3}}).png().toBuffer();raw.fill(0);
const ctx=new Context();const images=new ModelImageAttachments(ctx);
const connection=resolveAdapterOptions({baseURL:'http://127.0.0.1:9/anthropic',thinking:'disabled',maxTokens:32,retryPolicy:{mode:'normal',maxRetries:0},models:[{id:'synthetic-vision',inputModalities:['text','image']}]});
let fetchCount=0,extensionsCount=0;const priorFetch=globalThis.fetch;
globalThis.fetch=async()=>{fetchCount++;throw new Error('synthetic_network_forbidden');};
const adapter=new DeepSeekAdapter({options:()=>connection,resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous',resolveAttachments:()=>images,resolveFiles:()=>new DeepSeekFileStore({fetch:globalThis.fetch}),prepareExtensions:async()=>{extensionsCount++;return {fields:{}};}});
let caught,target,attachmentBytes;
try{
 await images.withImages([{id:'synthetic-budget',mimeType:'image/png',dataBase64:original.toString('base64')}],new AbortController().signal,async blocks=>{
  const ref=blocks.find(block=>block.type==='image').attachment;
  target=resolveRequestImageTarget(connection.models[0],ref);attachmentBytes=ref.bytes;
  try{for await(const ignored of adapter.stream({provider:'synthetic',model:'synthetic-vision',maxTokens:32,reasoningEffort:'off',messages:[{role:'user',content:blocks}]})){} }
  catch(error){caught=error;}
 });
 assert.equal(caught?.code,'TRANSPORT');
 assert.equal(caught?.cause?.message,'extraction_model_image_budget_exceeded');
 assert.equal(fetchCount,0);assert.equal(extensionsCount,0);images.assertIdle();
 console.log(JSON.stringify({pass:true,originalBytes:original.length,attachmentBytes,target,providerCode:caught.code,causeCode:caught.cause.message,fetchCount,extensionsCount}));
}finally{globalThis.fetch=priorFetch;original.fill(0);}
