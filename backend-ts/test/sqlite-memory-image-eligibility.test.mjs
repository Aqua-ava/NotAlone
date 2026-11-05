import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {fixture} from './media-support.mjs';
import {modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {createBuiltinMemoryContentRegistry} from '../src/memory/content/builtins.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';

// 合成夹具：记忆只带入当前可查看的已保存图片（标准图或高清图）；仅缩略图（不保存）与从未取图的消息保持未就绪。
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const digest=createHash('sha256').update(png).digest('hex');
const adapterFor=variant=>({version:`synthetic-eligibility-${variant}-v1`,supports:kind=>kind==='image',async execute(context){
 if(variant==='thumbnail-only')throw new StorageFailure('media_thumbnail_only');
 await context.save({role:'image_display',bytes:(async function*(){yield png;})(),expectedBytes:png.length,expectedSha256:digest,
  validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});
 return {association:{protocol:'media-association-v1',profileId:`synthetic-eligibility-${variant}-v1`,recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-image-one'}};
}});
async function run(t,variant){
 const f=await fixture(t,adapterFor(variant)),image=f.messages.find(m=>m.kind==='image');
 if(variant==='thumbnail-only')await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:`eligibility-${variant}`,goal:'extract'}),{code:'media_thumbnail_only'});
 else if(variant==='saved')await f.media.extract(f.contact,image.id,{requestKey:`eligibility-${variant}`,goal:'extract'});
 const requests=[];let service;
 const model=modelPort(()=>service.accounting,async request=>{requests.push(request);return {blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]};});
 service=new SqliteMemoryExtraction(f.storage,f.owner,model,f.media.holders,undefined,undefined,undefined,{registry:createBuiltinMemoryContentRegistry(),resources:{readImage:input=>f.media.readMemoryImage(input)}});
 t.after(()=>service.close());
 const started=await service.start(randomUUID());await service.waitForIdle(started.runId);
 const view=await service.readContact(f.contact);
 return {requests,imageUnavailable:view.queue.content.find(c=>c.kind==='image').unavailable,sentImages:requests.reduce((sum,r)=>sum+(r.images?.length??0),0)};
}
for(const variant of ['thumbnail-only','never-fetched'])
 test(`${variant}的图片不进入记忆模型，图片消息保持未就绪`,async t=>{
  const result=await run(t,variant);
  assert.equal(result.sentImages,0);assert.equal(result.imageUnavailable,1);
 });
test('已保存的标准图或高清图带入记忆模型',async t=>{
 const result=await run(t,'saved');
 assert.equal(result.sentImages,1);assert.equal(result.imageUnavailable,0);
});
