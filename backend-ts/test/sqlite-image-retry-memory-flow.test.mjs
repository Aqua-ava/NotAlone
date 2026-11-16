import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import sharp from 'sharp';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const timeout=async(promise,label,ms=15_000)=>{
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}
 finally{clearTimeout(timer);}
};
const imageBlocks=body=>body.messages.flatMap(message=>Array.isArray(message.content)?message.content.filter(block=>block.type==='image'):[]);
const targetIds=body=>body.messages.flatMap(message=>Array.isArray(message.content)?message.content.filter(block=>block.type==='text'):[]).flatMap(block=>{
 try{return JSON.parse(block.text).target_message_ids??[];}catch{return [];}
});

async function fixture(t,{gateText=false}={}){
 const directory=await mkdtemp(join(tmpdir(),'notalone-late-images-flow-'));
 const token=randomBytes(24).toString('base64url'),requests=[],first=Promise.withResolvers(),imagesReceived=Promise.withResolvers(),gate=Promise.withResolvers();
 let child,exited,url,log='',expectedImageIds=[];
 const provider=createServer(async(req,res)=>{
  try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const raw=Buffer.concat(chunks),body=JSON.parse(raw.toString('utf8'));
  requests.push({path:req.url,body,sha256:digest(raw),bytes:raw.length});
  if(requests.length===1){first.resolve();if(gateText)await gate.promise;}
  const events=[
   {type:'message_start',message:{id:`synthetic-${requests.length}`,type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:3,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'tool_use',id:`synthetic-tool-${requests.length}`,name:'DirectMemoryExtractionOutput',input:{}}},
   {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"scenes":[]}'}},
   {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:7}},{type:'message_stop'},
  ];
  res.setHeader('content-type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  const targeted=new Set(requests.flatMap(request=>targetIds(request.body)));
  if(expectedImageIds.length===2&&expectedImageIds.every(id=>targeted.has(id)))imagesReceived.resolve();
  }catch{res.statusCode=500;res.end(JSON.stringify({error:'synthetic_model_protocol_failed'}));}
 });
 t.after(async()=>{
  gate.resolve();
  if(child&&child.exitCode===null&&child.signalCode===null){
   if(url)await fetch(url+'/__fixture/stop',{method:'POST',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(3000)}).catch(()=>{});
   else child.kill('SIGTERM');
   await timeout(exited,'合成 DSH 未正常退出',5000).catch(async()=>{child.kill('SIGKILL');await timeout(exited,'合成 DSH 未释放进程',5000);});
  }
  provider.closeAllConnections();await new Promise(done=>provider.close(done));
  await rm(directory,{recursive:true,force:true});
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const profile=join(directory,'profiles/notalone');await mkdir(profile,{recursive:true});
 await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
 const official=await readFile(new URL('../profile/sqlite.patch.yml',import.meta.url),'utf8');
 const patch=official.replace('PLUGIN_PATH',JSON.stringify(resolve('test/fixtures/sqlite-memory-late-image-flow.ts')))
  +(!official.includes("name: '@deepseek-ai/dsh-llm'")?"    - id: late-images-test-llm\n      name: '@deepseek-ai/dsh-llm'\n":'');
 await writeFile(join(profile,'cordis.patch.yml'),patch);
 child=spawn(process.execPath,[resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{
  cwd:directory,env:{PATH:process.env.PATH,HOME:directory,DSH_HOME:directory,DSH_TELEMETRY_DISABLED:'1',
   NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}/anthropic`,NOTALONE_SYNTHETIC_HTTP_TOKEN:token},stdio:['ignore','pipe','pipe']});
 exited=once(child,'exit');child.stderr.on('data',value=>{log+=value;});
 const ready=await timeout(new Promise((done,reject)=>{
  child.stdout.on('data',value=>{log+=value;const match=log.match(/SQLITE_LATE_IMAGE_READY (\{[^\n]+\})/);if(match)done(JSON.parse(match[1]));});
  child.once('exit',()=>reject(new Error(log.slice(-1500))));
 }),'合成图片记忆运行时未就绪');
 url=ready.url;expectedImageIds=ready.imageMessageIds;
 const api=async(path,body)=>{
  const response=await fetch(url+'/__fixture/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`},
   ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
  const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;
 };
 return {api,ready,requests,first:first.promise,imagesReceived:imagesReceived.promise,release:()=>gate.resolve()};
}

async function assertImageFlow(f,state){
 assert.equal(state.automatic,true);
 assert.equal(state.images.length,2);
 for(const image of state.images){
  assert.equal(image.media.files.length,1);assert.equal(image.processing.extraction_state,'succeeded');
 }
 const queue=state.contact.queue.content.find(row=>row.kind==='image');
 assert.equal(queue.pending,0);assert.equal(queue.unadmitted,0);
 const blocks=f.requests.flatMap(request=>imageBlocks(request.body));assert.ok(blocks.length>=2,'两张图须作为实际图像发送');
 assert.deepEqual(f.requests.flatMap(request=>targetIds(request.body)).filter(id=>f.ready.imageMessageIds.includes(id)).sort(),[...f.ready.imageMessageIds].sort(),'每张图片只作为新目标处理一次，仍允许作为后续目标的正常上下文');
 const manifests=state.traces.flatMap(trace=>trace.events.filter(event=>event.kind==='image_inputs').flatMap(event=>event.payload.images));
 assert.deepEqual(new Set(manifests.map(image=>image.sourceSha256)),new Set(f.ready.images.map(image=>image.pngSha256)));
 assert.deepEqual(new Set(manifests.map(image=>image.id)),new Set(state.images.map(image=>image.media.files[0].fileId)));
 const calls=state.traces.flatMap(trace=>trace.calls),events=state.traces.flatMap(trace=>trace.events);
 for(const request of f.requests.filter(request=>imageBlocks(request.body).length)){
  const receipt=state.receipts.find(receipt=>receipt.input_budget?.request_sha256===request.sha256);
  assert.ok(receipt,'实际 HTTP 须对应同次已结算调用，发送前事件不能代替成功回执');
  assert.equal(receipt.input_budget.serialized_bytes,request.bytes);
  assert.equal(receipt.dispatch,'response_observed');assert.equal(receipt.outcome,'succeeded');
  const call=calls.find(call=>call.callId===receipt.attempt_id);assert.ok(call);assert.equal(call.state,'succeeded');
  const sent=events.filter(event=>event.kind==='image_inputs'&&event.callId===call.callId).flatMap(event=>event.payload.images);
  assert.equal(sent.length,imageBlocks(request.body).length);
  for(const block of imageBlocks(request.body)){
   assert.equal(block.source.type,'base64');assert.equal(block.source.media_type,'image/jpeg');
   const actual=Buffer.from(block.source.data,'base64'),manifest=sent.find(image=>image.requestSha256===digest(actual));
   assert.ok(manifest,'HTTP 实际图像字节须与同次调用的发送摘要一致');
   const metadata=await sharp(actual).metadata(),expected=f.ready.images.find(image=>image.pngSha256===manifest.sourceSha256);
   assert.equal(metadata.width,expected.width);assert.equal(metadata.height,expected.height);
  }
 }
 assert.ok(state.receipts.length>=1);
 assert.ok(state.receipts.every(receipt=>receipt.dispatch==='response_observed'&&receipt.outcome==='succeeded'));
 assert.ok(calls.length>0);assert.ok(calls.every(call=>call.state==='succeeded'));
 assert.ok(state.followups.length>=state.runs.length);
 assert.ok(state.followups.every(item=>item.outcome==='no_formal_change'&&item.reason==='no_formal_memory_change'),'合成模型明确无新增记忆时正常登记收尾，不虚构后续整理');
 assert.equal(state.later.pending,0);
 assert.ok(f.requests.every(request=>request.path==='/anthropic/v1/messages'),'不产生额外上传或其他模型请求');
}

test('两张图片查看失败后晚到：自动补取、正式记忆调度、实际模型图像及完成去重完整连通',{timeout:40_000},async t=>{
 const f=await fixture(t,{gateText:true});
 await f.api('start',{});await timeout(f.first,'初始文字没有进入模型');
 assert.equal(imageBlocks(f.requests[0].body).length,0);
 await f.api('retry-images',{});
 const failed=await f.api('state');assert.ok(failed.images.every(image=>image.media.latestAttempt.errorCode==='media_thumbnail_only'&&image.media.files.length===0));
 await f.api('images-ready',{});
 const late=await f.api('state');assert.ok(late.images.every(image=>image.media.files.length===1));
 assert.equal(late.contact.run.total,1,'晚到图片不扩张正在运行的文字冻结轮');
 f.release();await timeout(f.imagesReceived,'晚到图片没有被正式调度送入模型');await f.api('wait',{});
 await assertImageFlow(f,await f.api('state'));
 const count=f.requests.length;await f.api('wake',{});await f.api('wait',{});
 assert.equal(f.requests.length,count,'重复唤醒不重复调用图片模型');
});

test('记忆开关关闭时晚到图片只保存；明确开启后自动处理两图且不重发',{timeout:40_000},async t=>{
 const f=await fixture(t);
 await f.api('automatic',{enabled:false});await f.api('start',{});
 await f.api('retry-images',{});await f.api('images-ready',{});await f.api('wait',{});
 const disabled=await f.api('state');assert.equal(disabled.automatic,false);
 assert.ok(disabled.images.every(image=>image.media.files.length===1));assert.equal(f.requests.length,0,'保存和展示不能绕过记忆总开关发送');
 assert.equal(disabled.contact.queue.content.find(row=>row.kind==='image').unadmitted,2);
 await f.api('automatic',{enabled:true});await timeout(f.imagesReceived,'开启后没有自动领取已保存图片');await f.api('wait',{});
 await assertImageFlow(f,await f.api('state'));
 const count=f.requests.length;await f.api('wake',{});await f.api('wait',{});assert.equal(f.requests.length,count);
});

test('记忆调度已空闲时，两图自动补取事件仍能唤醒模型处理，无需再次打开页面',{timeout:40_000},async t=>{
 const f=await fixture(t);
 await f.api('start',{});await timeout(f.first,'初始文字没有进入模型');await f.api('wait',{});
 await f.api('retry-images',{});await f.api('wait',{});
 assert.equal(f.requests.length,1);
 await f.api('images-ready',{});
 // 收到实际图片请求前不调用 wake、切换开关或读取页面，验证补图后的自动唤醒。
 await timeout(f.imagesReceived,'空闲记忆运行时未被补图事件唤醒');
 await f.api('wait',{});await assertImageFlow(f,await f.api('state'));
});
