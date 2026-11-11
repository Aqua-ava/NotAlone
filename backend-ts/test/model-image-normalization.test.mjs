import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {imageMemoryContent} from '../src/memory/content/image.ts';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function noise(width,height,channels=3){
 const bytes=Buffer.alloc(width*height*channels);let state=0x12345678;
 for(let i=0;i<bytes.length;i++){state^=state<<13;state^=state>>>17;state^=state<<5;bytes[i]=state&255;}
 return bytes;
}
async function prepare(data,mimeType='image/png'){
 const id='11111111-1111-4111-8111-111111111111',sha256=digest(data);
 return imageMemoryContent.prepare({ownerId:'owner',contactId:'contact',message:{id:'message',sender_role:'contact',sent_at:null},
  frozen:{pluginId:'notalone.image',pluginVersion:'1',kind:'image',identity:{fileId:id,sha256,mediaGeneration:'0',mimeType,byteSize:data.length}},
  resources:{readImage:async()=>({mimeType,dataBase64:data.toString('base64')})},signal:new AbortController().signal,requireCurrent:async()=>{}});
}

test('图片内容插件发送有界JPEG，来源仍绑定原图摘要与文件',async()=>{
 const original=await sharp(noise(1280,1706),{raw:{width:1280,height:1706,channels:3}}).png().toBuffer();
 const result=await prepare(original),sent=result.images[0],metadata=await sharp(Buffer.from(sent.dataBase64,'base64')).metadata();
 assert.equal(sent.mimeType,'image/jpeg');assert.equal(metadata.format,'jpeg');assert.equal(Math.max(metadata.width,metadata.height),1536);
 assert.ok(Buffer.from(sent.dataBase64,'base64').length<=2097152);
 assert.equal(result.message.image.sha256,digest(original));assert.equal(result.message.image.file_id,sent.id);
 assert.equal(sent.sourceSha256,digest(original));assert.equal(sent.originalBytes,original.length);assert.equal(sent.normalizationTier,'primary');
});

test('官方适配器能发送原大PNG，追踪发送JPEG及原始字节而不误报TRANSPORT',async t=>{
 const {createServer}=await import('node:http'),{once}=await import('node:events');
 const {Context}=await import('@deepseek-ai/cordis');
 const {DeepSeekAdapter,DeepSeekFileStore,resolveAdapterOptions}=await import('@deepseek-ai/dsh-llm-deepseek');
 const {ModelImageAttachments}=await import('../src/platform/models/model-images.ts');
 const original=await sharp(noise(1280,1706),{raw:{width:1280,height:1706,channels:3}}).png().toBuffer();
 const requests=[],server=createServer(async(req,res)=>{
  const chunks=[];for await(const part of req)chunks.push(part);requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  const events=[{type:'message_start',message:{id:'synthetic',model:'synthetic-vision',usage:{input_tokens:3,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'合成'}},{type:'content_block_stop',index:0},
   {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}];
  res.setHeader('content-type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const images=new ModelImageAttachments(new Context());
 const connection=resolveAdapterOptions({baseURL:`http://127.0.0.1:${server.address().port}/anthropic`,thinking:'disabled',maxTokens:32,
  retryPolicy:{mode:'normal',maxRetries:0},models:[{id:'synthetic-vision',inputModalities:['text','image']}]});
 const adapter=new DeepSeekAdapter({options:()=>connection,resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous',
  resolveAttachments:()=>images,resolveFiles:()=>new DeepSeekFileStore({fetch:async()=>{throw new Error('synthetic-inline-only');}}),prepareExtensions:async()=>({fields:{}})});
 await images.withImages([{id:'synthetic-budget',mimeType:'image/png',dataBase64:original.toString('base64')}],new AbortController().signal,async blocks=>{
  for await(const ignored of adapter.stream({provider:'synthetic',model:'synthetic-vision',maxTokens:32,reasoningEffort:'off',messages:[{role:'user',content:blocks}]})){}
  const manifest=images.manifest()[0];assert.equal(manifest.sourceSha256,digest(original));assert.equal(manifest.originalBytes,original.length);
  assert.equal(manifest.requestMimeType,'image/jpeg');assert.ok(manifest.bytes<=2097152);assert.ok(manifest.width<=1536&&manifest.height<=1536);
 });
 assert.equal(requests.length,1);const image=requests[0].messages[0].content.find(block=>block.type==='image');
 assert.equal(image.source.media_type,'image/jpeg');images.assertIdle();
});

test('透明PNG使用白底，EXIF方向应用后去除元数据，GIF只发送首帧',async()=>{
 const transparent=await sharp({create:{width:20,height:12,channels:4,background:{r:255,g:0,b:0,alpha:0}}}).png().toBuffer();
 const transparentResult=await prepare(transparent),transparentBytes=Buffer.from(transparentResult.images[0].dataBase64,'base64');
 const {data:rgb,info}=await sharp(transparentBytes).raw().toBuffer({resolveWithObject:true});
 assert.equal(info.channels,3);assert.ok(rgb[0]>=250&&rgb[1]>=250&&rgb[2]>=250);
 const oriented=await sharp({create:{width:40,height:20,channels:3,background:'blue'}}).withMetadata({orientation:6}).jpeg().toBuffer();
 const orientedResult=await prepare(oriented,'image/jpeg'),metadata=await sharp(Buffer.from(orientedResult.images[0].dataBase64,'base64')).metadata();
 assert.equal(metadata.width,20);assert.equal(metadata.height,40);assert.equal(metadata.orientation,undefined);assert.equal(metadata.exif,undefined);
 const frames=Buffer.concat([Buffer.from([255,0,0,255,0,0]),Buffer.from([0,0,255,0,0,255])]);
 const animated=await sharp(frames,{raw:{width:2,height:2,channels:3,pageHeight:1}}).gif({loop:0,delay:[100,100]}).toBuffer();
 assert.equal((await sharp(animated).metadata()).pages,2);
 const animatedResult=await prepare(animated,'image/gif'),first=await sharp(Buffer.from(animatedResult.images[0].dataBase64,'base64')).raw().toBuffer({resolveWithObject:true});
 assert.equal(first.info.width,2);assert.equal(first.info.height,1);assert.ok(first.data[0]>240&&first.data[2]<15);
});

test('大尺寸图片有界缩小，降级到1024且保留可复制的原图证明，篡改被拒绝',async()=>{
 const {normalizeModelImageInput,verifyNormalizedModelImage}=await import('../src/platform/models/image-normalization.ts');
 const original=await sharp({create:{width:6000,height:4000,channels:3,background:'#6d83aa'}}).png().toBuffer();
 const primary=(await prepare(original)).images[0],cloned=structuredClone(primary);
 assert.equal(verifyNormalizedModelImage(cloned,digest(original)),true);
 const degraded=await normalizeModelImageInput(cloned,{tier:'degraded'}),metadata=await sharp(Buffer.from(degraded.dataBase64,'base64')).metadata();
 assert.equal(Math.max(metadata.width,metadata.height),1024);assert.equal(degraded.sourceSha256,digest(original));assert.equal(degraded.originalBytes,original.length);
 assert.equal(degraded.normalizationTier,'degraded');assert.equal(verifyNormalizedModelImage(degraded,digest(original)),true);
 for(const changed of [{sourceSha256:'a'.repeat(64)},{originalBytes:1},{id:'different'},{normalizationTier:'degraded'},{dataBase64:Buffer.from('tampered').toString('base64')},{dataBase64:primary.dataBase64+'\n'}]){
  const tampered={...primary,...changed};assert.equal(verifyNormalizedModelImage(tampered,tampered.sourceSha256),false);
  await assert.rejects(normalizeModelImageInput(tampered),/extraction_model_image_invalid/);
 }
 assert.equal(verifyNormalizedModelImage(primary,'b'.repeat(64)),false);
});

test('发送字节精确边界可用，超过边界继续缩小，不可能满足的预算明确失败',async()=>{
 const {normalizeModelImageBytes}=await import('../src/platform/models/image-normalization.ts');
 const original=await sharp(noise(300,200),{raw:{width:300,height:200,channels:3}}).png().toBuffer();
 const first=await normalizeModelImageBytes(original),exact=await normalizeModelImageBytes(original,{target:{width:300,height:200,maxBytes:first.bytes}});
 assert.equal(exact.bytes,first.bytes);
 const smaller=await normalizeModelImageBytes(original,{target:{width:300,height:200,maxBytes:Math.floor(first.bytes/2)}});
 assert.ok(smaller.bytes<=Math.floor(first.bytes/2));assert.ok(smaller.width<300&&smaller.height<200);
 await assert.rejects(normalizeModelImageBytes(original,{target:{width:300,height:200,maxBytes:64}}),/extraction_model_image_budget_exceeded/);
 first.data.fill(0);exact.data.fill(0);smaller.data.fill(0);
});

test('损坏图片、类型伪装、超像素图片与取消均在模型调用前停止',async()=>{
 const {normalizeModelImageInput}=await import('../src/platform/models/image-normalization.ts');
 await assert.rejects(prepare(Buffer.from('broken-image')));
 const png=await sharp({create:{width:4,height:3,channels:3,background:'red'}}).png().toBuffer();
 await assert.rejects(prepare(png,'image/jpeg'),/extraction_model_image_invalid/);
 const oversized=await sharp({create:{width:6000,height:6000,channels:3,background:'white'}}).png().toBuffer();
 await assert.rejects(prepare(oversized),/pixel limit/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(normalizeModelImageInput({id:'cancel',mimeType:'image/png',dataBase64:png.toString('base64')},{signal:controller.signal}),{name:'AbortError'});
});

test('正式图片附件统一采用8张上限，规范化后计字节且超过上限不进入工作回调',async()=>{
 const {Context}=await import('@deepseek-ai/cordis'),{ModelImageAttachments}=await import('../src/platform/models/model-images.ts');
 const {MODEL_IMAGE_LIMITS}=await import('../src/platform/models/image-normalization.ts');
 const data=await sharp({create:{width:4,height:3,channels:3,background:'green'}}).png().toBuffer(),images=new ModelImageAttachments(new Context());
 const input=Array.from({length:8},(_,index)=>({id:`synthetic-${index}`,mimeType:'image/png',dataBase64:data.toString('base64')}));
 await images.withImages(input,new AbortController().signal,async blocks=>{assert.equal(blocks.filter(block=>block.type==='image').length,8);});
 let entered=false;
 await assert.rejects(images.withImages([...input,{...input[0],id:'synthetic-9'}],new AbortController().signal,async()=>{entered=true;}),/extraction_model_image_invalid/);
 assert.equal(entered,false);assert.equal(images.imageLimits,MODEL_IMAGE_LIMITS);images.assertIdle();
});
