import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {configureDiagnosticLog} from '../src/diagnostics/unified.ts';
import {checkedDiagnosticRecord} from '../src/diagnostics/unified-contract.mjs';

async function diagnostics(f,t){
 const log=configureDiagnosticLog(f.root,{proc:'backend',development:true});
 t.after(()=>log.close());
 return async()=>{await log.flush();const files=await readdir(join(f.root,'logs'));return (await Promise.all(files.filter(file=>/^backend-.*\.jsonl$/.test(file)).map(file=>readFile(join(f.root,'logs',file),'utf8')))).join('').trim().split('\n').filter(Boolean).map(line=>{const value=JSON.parse(line);assert.ok(checkedDiagnosticRecord(value));return value;});};
}
const empty=request=>({blocks:[{type:'tool-call',name:request.tool.name,arguments:'{"scenes":[]}'}]});

test('处理日志串联总开关、暂停续跑与已提交run/task/batch，且不写正文',async t=>{
 const f=await fixture(t);const contactId=f.saved[0].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:21},(_,i)=>record(String(i+1),{text:`不可进入日志的合成正文-${i}`})),completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.contacts.setReading(false);
 const records=await diagnostics(f,t),entered=Promise.withResolvers(),gate=Promise.withResolvers();let memory;
 const port=modelPort(()=>memory.accounting,async request=>{if(port.calls===1){entered.resolve();await gate.promise;}return empty(request);});
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(async()=>{gate.resolve();await memory.close();});
 const run=await memory.start(randomUUID());await entered.promise;
 await memory.setAutomatic(false);gate.resolve();await memory.waitForIdle();
 assert.equal((await memory.read(run.runId)).state,'paused');
 await memory.setAutomatic(true);await memory.waitForIdle();
 const rows=await records(),processing=rows.filter(row=>row.module==='memory.processing');
 assert.ok(processing.some(row=>row.event==='processing.control_changed'&&row.toState==='disabled'));
 assert.ok(processing.some(row=>row.event==='processing.control_changed'&&row.toState==='enabled'));
 assert.ok(processing.some(row=>row.event==='processing.run_changed'&&row.runId===run.runId&&row.toState==='paused'));
 assert.ok(processing.some(row=>row.event==='processing.run_changed'&&row.runId===run.runId&&row.reasonCode==='resumed'));
 assert.ok(processing.some(row=>row.event==='processing.task_changed'&&row.taskId===run.tasks.find(task=>task.scopeKind==='contact').taskId&&row.toState==='succeeded'));
 assert.equal(new Set(processing.filter(row=>row.event==='processing.batch_changed'&&row.toState==='succeeded').map(row=>row.batchId)).size,2);
 assert.ok(processing.filter(row=>row.event==='processing.batch_changed').every(row=>row.traceId&&row.runId&&row.taskId&&row.batchId));
 assert.equal(JSON.stringify(rows).includes('不可进入日志'),false);
 t.diagnostic(JSON.stringify(processing.filter(row=>row.runId===run.runId&&['paused','resumed'].includes(row.reasonCode)).map(({runId,taskId,reasonCode})=>({runId,...(taskId?{taskId}:{}),reasonCode}))));
});

test('技术失败后继续沿原任务重试，日志保留固定失败原因与重试状态',async t=>{
 const f=await fixture(t);await f.service.synchronize(f.saved[0].contact_id);await f.contacts.setReading(false);
 const records=await diagnostics(f,t);let memory;
 const port=modelPort(()=>memory.accounting,empty),prepare=port.prepare;let fail=true;
 port.prepare=async(...args)=>{if(fail){const {StorageFailure}=await import('../src/storage/sqlite/contracts.ts');throw new StorageFailure('extraction_model_unconfigured');}return prepare(...args);};
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const run=await memory.start(randomUUID());await memory.waitForIdle();
 const blocked=await memory.read(run.runId);assert.equal(blocked.state,'paused');
 fail=false;await memory.continue(run.runId,blocked.controlVersion,randomUUID());await memory.waitForIdle();
 const rows=(await records()).filter(row=>row.runId===run.runId);
 assert.ok(rows.some(row=>row.event==='processing.batch_changed'&&row.toState==='failed'&&row.reasonCode==='model_unavailable'));
 assert.ok(rows.some(row=>row.event==='processing.task_changed'&&row.toState==='pending'&&row.reasonCode==='retry'));
 assert.ok(rows.some(row=>row.event==='processing.batch_changed'&&row.toState==='succeeded'));
});

test('撤销授权后的领取与收尾记录授权撤销，迟到结果不能恢复任务',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id;
 await f.service.synchronize(contactId);const records=await diagnostics(f,t),entered=Promise.withResolvers(),gate=Promise.withResolvers();let memory;
 const port=modelPort(()=>memory.accounting,async request=>{entered.resolve();await gate.promise;return empty(request);});
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(async()=>{gate.resolve();await memory.close();});
 const run=await memory.start(randomUUID());await entered.promise;
 const binding=f.saved[0];await f.contacts.revoke(contactId,binding.binding_id,binding.selection_generation);gate.resolve();await memory.waitForIdle();
 const rows=(await records()).filter(row=>row.runId===run.runId);
 assert.ok(rows.some(row=>row.event==='processing.task_changed'&&row.toState==='revoked'&&row.reasonCode==='authorization_revoked'));
 assert.equal((await memory.read(run.runId)).tasks.find(task=>task.scopeKind==='contact').state,'revoked');
});

async function imageScenario(t,readyBeforeRun,rollback=false){
 const {createHash}=await import('node:crypto');
 const {SqliteMediaService}=await import('../src/media/sqlite/service.ts');
 const {createBuiltinMemoryContentRegistry}=await import('../src/memory/content/builtins.ts');
 const f=await fixture(t,rollback?{registryModule:new URL('./fixtures/memory-diagnostics/rollback-registry.mjs',import.meta.url).href}:{}),contactId=f.saved[0].contact_id;
 const sharp=(await import('sharp')).default;
 const validImage=await sharp({create:{width:2,height:2,channels:4,background:{r:30,g:80,b:140,alpha:1}}}).png().toBuffer();
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1'),record('2',{kind:'image',text:null,originalType:'3'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);
 let revision=0;
 const adapter={version:'synthetic-diagnostic-image-v1',supports:(kind,goal)=>kind==='image'&&goal==='extract',async execute(context){
  const bytes=Buffer.concat([validImage,Buffer.from(String(++revision))]);
  await context.save({role:'image_display',expectedBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex'),bytes:(async function*(){yield bytes;})(),validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-diagnostic-image-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-image'}};
 }};
 const media=new SqliteMediaService({storage:f.storage,contacts:f.contacts,history:f.service,userData:f.root,adapters:[adapter]});
 await media.initialize();t.after(()=>media.close());
 const image=(await f.service.read(contactId)).messages.find(message=>message.kind==='image');
 if(readyBeforeRun)await media.extract(contactId,image.id,{requestKey:'image-before-run',goal:'extract'});
 const records=await diagnostics(f,t),entered=Promise.withResolvers(),gate=Promise.withResolvers();let memory;
 const port=modelPort(()=>memory.accounting,async request=>{entered.resolve();await gate.promise;return empty(request);});
 memory=new SqliteMemoryExtraction(f.storage,owner,port,undefined,undefined,undefined,undefined,{registry:createBuiltinMemoryContentRegistry(),resources:{readImage:input=>media.readMemoryImage(input)}});
 t.after(async()=>{gate.resolve();await memory.close();});
 const run=await memory.start(randomUUID());await Promise.race([entered.promise,memory.waitForIdle().then(async()=>{const stopped=await memory.read(run.runId);throw new Error('image_fixture_model_not_reached:'+stopped.tasks.map(task=>task.errorCode).join(','));})]);
 assert.equal(run.total,readyBeforeRun?2:1);
 if(rollback)await assert.rejects(media.extract(contactId,image.id,{requestKey:'image-after-run',goal:'extract'}),{code:'synthetic_publish_rollback'});
 else await media.extract(contactId,image.id,{requestKey:'image-after-run',goal:'extract'});
 const excluded=(await records()).filter(row=>row.event==='processing.image_excluded');
 if(readyBeforeRun||rollback)assert.equal(excluded.length,0,'已在固定输入中的图片替换或回滚不伪报晚就绪');
 else assert.deepEqual(excluded.map(row=>({runId:row.runId,reasonCode:row.reasonCode,count:row.count})),[{runId:run.runId,reasonCode:'image_late_ready',count:1}]);
 gate.resolve();await memory.waitForIdle();
}
test('已有消息的图片在本轮冻结后首次就绪，日志提示未纳入本轮而不扩大输入',{timeout:10000},async t=>imageScenario(t,false));
test('本来已就绪且在本轮输入的图片替换，不伪报晚就绪',{timeout:10000},async t=>imageScenario(t,true));

test('媒体正式发布回滚时丢弃已缓冲的晚图事件',{timeout:10000},async t=>imageScenario(t,false,true));

test('后续整理等待窗口、到期领取和完成都可由日志追溯',{timeout:15000},async t=>{
 const {documentFixture}=await import('./fixtures/memory-documents/support.mjs');
 const f=await documentFixture(t,{laterScheduling:true}),records=await diagnostics(f,t);
 const run=await f.extraction.start(randomUUID());await f.extraction.waitForIdle();
 const waiting=await f.extraction.readContact(f.contactId);assert.equal(waiting.run.status,'waiting');
 const before=await records();
 assert.ok(before.some(row=>row.event==='processing.control_changed'&&row.runId===run.runId&&row.toState==='waiting'&&row.reasonCode==='waiting_window'));
 await f.documents.runDueStages(waiting.run.nextDueAt);
 assert.equal((await f.extraction.readContact(f.contactId)).run.status,'completed');
 const rows=await records();
 assert.ok(rows.some(row=>row.event==='processing.run_changed'&&row.runId===run.runId&&row.toState==='completed'));
 assert.ok(rows.filter(row=>row.event==='processing.batch_changed'&&row.toState==='succeeded').length>=3,'提取、主题及画像批次均记录完成');
});

test('诊断接收器失败不会改变正式处理结果或授权',{timeout:10000},async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-diagnostics/failing-recorder-registry.mjs',import.meta.url).href});
 await f.service.synchronize(f.saved[0].contact_id);await f.contacts.setReading(false);
 const records=await diagnostics(f,t);let memory;
 const port=modelPort(()=>memory.accounting,empty);memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const run=await memory.start(randomUUID());await memory.waitForIdle();
 assert.equal((await memory.read(run.runId)).succeeded,1);assert.equal(port.calls,1);
 assert.equal((await records()).filter(row=>row.module==='memory.processing').length,0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
