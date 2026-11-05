import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Context} from '@deepseek-ai/cordis';
import {fixture} from './media-support.mjs';
import {fixture as memoryFixture,record} from './fixtures/memory-sqlite/support.mjs';
import {fileMemoryContent} from './fixtures/memory-content/file-plugin.mjs';
import {modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {MemoryContentRegistry,memoryContentPlugin} from '../src/memory/content/registry.ts';
import {createBuiltinMemoryContentRegistry} from '../src/memory/content/builtins.ts';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const adapter={version:'synthetic-image-input-v1',supports:kind=>kind==='image',async execute(context){
 await context.save({role:'image_display',bytes:(async function*(){yield png;})(),expectedBytes:png.length,expectedSha256:createHash('sha256').update(png).digest('hex'),
  validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});
 return {association:{protocol:'media-association-v1',profileId:'synthetic-image-input-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-image-one'}};
}};
function extraction(t,f,requests){
 let service;
 const model=modelPort(()=>service.accounting,async request=>{requests.push(request);return {blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]};});
 service=new SqliteMemoryExtraction(f.storage,f.owner,model,f.media.holders,undefined,undefined,undefined,{registry:createBuiltinMemoryContentRegistry(),resources:{readImage:input=>f.media.readMemoryImage(input)}});
 t.after(()=>service.close());return service;
}
test('内容插件沿官方生命周期注册；新增文件插件与卸载不改记忆主流程',async()=>{
 const ctx=new Context(),registry=new MemoryContentRegistry();
 const plugin={id:'synthetic.file',version:'1',kinds:['file'],modelInputCost:()=>({images:0,bytes:0}),snapshot:()=>({fileId:'synthetic-file'}),prepare:async()=>({message:{message_id:randomUUID(),text:'合成文件内容',sender:'contact',occurred_at:null,text_representation:'text'}})};
 const fork=await ctx.plugin(memoryContentPlugin,{registry,plugins:[plugin]});
 assert.deepEqual(registry.kinds,['file']);
 const frozen=registry.snapshot({}, {ownerId:randomUUID(),contactId:randomUUID(),message:{kind:'file'}});
 assert.equal(frozen.pluginId,'synthetic.file');
 assert.throws(()=>registry.register({...plugin,id:'synthetic.duplicate'}),{code:'memory_content_plugin_conflict'});
 const result=await registry.prepare({ownerId:randomUUID(),contactId:randomUUID(),message:{kind:'file'},frozen,signal:new AbortController().signal,requireCurrent:async()=>{}});
 assert.equal(result.message.text,'合成文件内容');
 await fork.dispose();assert.throws(()=>registry.require(frozen),{code:'memory_content_plugin_unavailable'});
});
test('同联系人图片字节与文字按消息顺序共同进入正常记忆任务，关闭同步仍可处理合法副本',async t=>{
 const f=await fixture(t,adapter),image=f.messages.find(m=>m.kind==='image');
 const saved=await f.media.extract(f.contact,image.id,{requestKey:'joint-image',goal:'extract'});
 await f.contacts.setReading(false);
 const requests=[],service=extraction(t,f,requests),run=await service.start(randomUUID());
 assert.equal(run.total,2);await service.waitForIdle(run.runId);
 const done=await service.read(run.runId);assert.equal(done.succeeded,2,JSON.stringify(done.tasks));
 assert.equal(requests.length,1);const request=requests[0],payload=JSON.parse(request.user);
 assert.deepEqual(payload.messages.map(message=>message.message_id),[image.id,f.messages.find(m=>m.kind==='text').id]);
 assert.equal(payload.messages[0].image_id,saved.files[0].fileId);
 assert.equal(request.images.length,1);assert.equal(request.images[0].id,saved.files[0].fileId);assert.deepEqual(Buffer.from(request.images[0].dataBase64,'base64'),png);
 assert.ok(done.contentCounts.some(c=>c.kind==='image'&&c.total===1&&c.succeeded===1));
 const trace=await service.trace(done.tasks.find(task=>task.scopeKind==='contact').taskId);
 assert.ok(trace.events.some(event=>event.kind==='model_input'&&event.payload.images?.[0].id===saved.files[0].fileId));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('未保存图片如实保留未就绪；图片稍后可用时单独作为新目标并带已处理文字语境',async t=>{
 const f=await fixture(t,adapter),image=f.messages.find(m=>m.kind==='image'),requests=[],service=extraction(t,f,requests);
 const first=await service.start(randomUUID());assert.equal(first.total,1);await service.waitForIdle(first.runId);assert.equal((await service.read(first.runId)).succeeded,1);
 const view=await service.readContact(f.contact);assert.equal(view.queue.content.find(c=>c.kind==='image').unavailable,1);
 assert.equal(requests[0].images?.length??0,0);
 await f.media.extract(f.contact,image.id,{requestKey:'late-image',goal:'extract'});
 const second=await service.start(randomUUID());assert.equal(second.total,1);await service.waitForIdle(second.runId);
 const done=await service.read(second.runId);assert.equal(done.succeeded,1,JSON.stringify(done.tasks));
 const payload=JSON.parse(requests[1].user);assert.deepEqual(payload.target_message_ids,[image.id]);
 assert.equal(payload.messages.length,2);assert.equal(requests[1].images.length,1);
 const final=await service.start(randomUUID());assert.equal(final.total,0);
});

test('宿主与Worker使用同一插件模块后，新增文件类型贯通正常任务筛选、冻结与处理',async t=>{
 const f=await memoryFixture(t,{registryModule:new URL('./fixtures/memory-content/registry.mjs',import.meta.url).href});
 const contact=f.saved[0].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('3',{kind:'file',text:null,originalType:'file'})],completedPartitions:f.target.partitions,exhausted:true});
 await f.service.synchronize(contact);
 const registry=createBuiltinMemoryContentRegistry();registry.register(fileMemoryContent);let service;const requests=[];
 const model=modelPort(()=>service.accounting,async request=>{requests.push(request);return {blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]};});
 service=new SqliteMemoryExtraction(f.storage,f.contacts.ownerId,model,undefined,undefined,undefined,undefined,{registry});t.after(()=>service.close());
 const run=await service.start(randomUUID());assert.equal(run.total,1);await service.waitForIdle(run.runId);
 const done=await service.read(run.runId);assert.equal(done.succeeded,1,JSON.stringify(done.tasks));
 assert.equal(JSON.parse(requests[0].user).messages[0].text,'合成文件中的固定每周安排');
 assert.deepEqual(done.contentCounts,[{kind:'file',total:1,succeeded:1}]);
});
test('九张图片按正式模型八张上限分批，恢复不会重复超限的固定输入',async t=>{
 const f=await fixture(t,adapter);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:9},(_,i)=>({partition:'a',table:'one',localId:String(20+i),serverId:'0',sender:'contact',kind:'image',text:null,originalType:'image',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,stateAssurance:'verified'})),completedPartitions:['a'],exhausted:true});
 await f.history.synchronize(f.contact);
 const images=(await f.history.read(f.contact)).messages.filter(message=>message.kind==='image'&&message.id!==f.messages.find(m=>m.kind==='image').id);
 for(const message of images)await f.media.extract(f.contact,message.id,{requestKey:`album-${message.id}`,goal:'extract'});
 const requests=[],service=extraction(t,f,requests),run=await service.start(randomUUID());await service.waitForIdle(run.runId);
 const done=await service.read(run.runId);assert.equal(done.succeeded,run.total,JSON.stringify(done.tasks));
 assert.ok(requests.length>=2);assert.ok(requests.every(request=>(request.images?.length??0)<=8));
 assert.equal(requests.reduce((sum,request)=>sum+(request.images?.length??0),0),images.length);
});
