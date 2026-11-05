import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {fixture} from './media-support.mjs';
import {modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {createBuiltinMemoryContentRegistry} from '../src/memory/content/builtins.ts';

// 合成夹具：记忆只带入已确认不是缩略图的图片（标准图或原图）；缩略图与来源未确认的图片不进入模型。
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const digest=createHash('sha256').update(png).digest('hex');
const evidence=(quality,sourceVariant,originalProofDigest=null)=>({protocol:'wechat-image-quality-v1',quality,sourceVariant,resourceInfoId:'10',
 resources:[{resourceId:'20',resourceTypeRaw:sourceVariant==='main'?131073:65537}],sourceSha256:'a'.repeat(64),contentSha256:digest,originalProofDigest});
const variants={
 thumbnail:{imageQuality:'thumbnail',qualityProof:null,imageQualityEvidence:evidence('thumbnail','thumbnail')},
 unconfirmed:{imageQuality:'unknown',qualityProof:null},
 main:{imageQuality:'unknown',qualityProof:null,imageQualityEvidence:evidence('unknown','main')},
 original:{imageQuality:'original',qualityProof:'synthetic-original-proof',imageQualityEvidence:evidence('original','main','b'.repeat(64))},
};
const adapterFor=variant=>({version:`synthetic-eligibility-${variant}-v1`,supports:kind=>kind==='image',async execute(context){
 await context.save({role:'image_display',bytes:(async function*(){yield png;})(),expectedBytes:png.length,expectedSha256:digest,
  validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false,...variants[variant]})});
 return {association:{protocol:'media-association-v1',profileId:`synthetic-eligibility-${variant}-v1`,recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-image-one'}};
}});
async function run(t,variant){
 const f=await fixture(t,adapterFor(variant)),image=f.messages.find(m=>m.kind==='image');
 await f.media.extract(f.contact,image.id,{requestKey:`eligibility-${variant}`,goal:'extract'});
 const requests=[];let service;
 const model=modelPort(()=>service.accounting,async request=>{requests.push(request);return {blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]};});
 service=new SqliteMemoryExtraction(f.storage,f.owner,model,f.media.holders,undefined,undefined,undefined,{registry:createBuiltinMemoryContentRegistry(),resources:{readImage:input=>f.media.readMemoryImage(input)}});
 t.after(()=>service.close());
 const started=await service.start(randomUUID());await service.waitForIdle(started.runId);
 const view=await service.readContact(f.contact);
 return {requests,imageUnavailable:view.queue.content.find(c=>c.kind==='image').unavailable,sentImages:requests.reduce((sum,r)=>sum+(r.images?.length??0),0)};
}
for(const variant of ['thumbnail','unconfirmed'])
 test(`${variant}图片不进入记忆模型，图片消息保持未就绪`,async t=>{
  const result=await run(t,variant);
  assert.equal(result.sentImages,0);assert.equal(result.imageUnavailable,1);
 });
for(const variant of ['main','original'])
 test(`${variant}图片作为确认不是缩略图的图片带入记忆模型`,async t=>{
  const result=await run(t,variant);
  assert.equal(result.sentImages,1);assert.equal(result.imageUnavailable,0);
 });
