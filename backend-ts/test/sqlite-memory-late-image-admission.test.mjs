import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {fixture} from './media-support.mjs';
import {modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {createBuiltinMemoryContentRegistry} from '../src/memory/content/builtins.ts';

const png=await sharp({create:{width:4,height:3,channels:3,background:'blue'}}).png().toBuffer();
const adapter={version:'synthetic-late-image-v1',supports:kind=>kind==='image',async execute(context){
 await context.save({role:'image_display',bytes:(async function*(){yield png;})(),expectedBytes:png.length,expectedSha256:createHash('sha256').update(png).digest('hex'),validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});
 return {association:{protocol:'media-association-v1',profileId:'synthetic-late-image-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-late-image'}};
}};

test('运行中晚到图片不扩张冻结输入，正式自动历史下一轮领取且manual摘要显示未纳入',async t=>{
 const changed=[],f=await fixture(t,adapter,{onMediaChanged:(...ids)=>changed.push(ids)}),image=f.messages.find(row=>row.kind==='image'),requests=[];
 const entered=Promise.withResolvers(),gate=Promise.withResolvers();let memory;
 const model=modelPort(()=>memory.accounting,async request=>{requests.push(request);if(requests.length===1){entered.resolve();await gate.promise;}return {blocks:[{type:'tool-call',name:request.tool.name,arguments:'{"scenes":[]}'}]};});
 memory=new SqliteMemoryExtraction(f.storage,f.owner,model,f.media.holders,undefined,undefined,undefined,{registry:createBuiltinMemoryContentRegistry(),resources:{readImage:input=>f.media.readMemoryImage(input)}});t.after(()=>memory.close());
 const first=await memory.startHistoryBatch(f.contact,randomUUID());await entered.promise;
 try{
  await f.media.extract(f.contact,image.id,{requestKey:'synthetic-late-ready',goal:'extract'});
  assert.deepEqual(changed,[[f.contact,image.id]]);assert.equal((await memory.read(first.runId)).total,1);assert.equal(requests[0].images?.length??0,0);
  assert.equal((await memory.scanSchedule(Date.now(),[f.contact])).contacts.some(row=>row.historyDue),false,'仍在运行的原轮保持联系人门');
 }finally{gate.resolve();}
 await memory.waitForIdle(first.runId);
 const waiting=await memory.readContact(f.contact);assert.equal(waiting.queue.content.find(row=>row.kind==='image').unadmitted,1);
 assert.equal((await memory.scanSchedule(Date.now(),[f.contact])).contacts.some(row=>row.historyDue),true);
 const second=await memory.startHistoryBatch(f.contact,randomUUID());await memory.waitForIdle(second.runId);
 assert.equal(second.total,1);assert.equal((await memory.read(second.runId)).succeeded,1);assert.equal(requests[1].images.length,1);
 assert.deepEqual(JSON.parse(requests[1].user).target_message_ids,[image.id]);assert.equal(requests.length,2);
 assert.equal((await memory.scanSchedule(Date.now(),[f.contact])).contacts.some(row=>row.historyDue),false);assert.equal((await memory.readContact(f.contact)).queue.content.find(row=>row.kind==='image').unadmitted,0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
