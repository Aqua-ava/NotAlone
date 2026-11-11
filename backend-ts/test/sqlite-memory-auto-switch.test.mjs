import {cleanupPreSourceProofFixtures} from './fixtures/sqlite/pre-source-proof-registry.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryExtractionHttp} from '../src/memory/sqlite/http.ts';
import {SqliteMemoryL1Scheduler} from '../src/memory/sqlite/scheduler.ts';
import {authorizeSqliteRequest} from '../src/sqlite-host-plugin.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
after(cleanupPreSourceProofFixtures);

const emptyScenes=request=>({blocks:[{type:'tool-call',name:request.tool.name,arguments:'{"scenes":[]}'}]});
async function savedFixture(t,options={}){
 const f=await fixture(t,options);await f.service.synchronize(f.saved[0].contact_id);await f.contacts.setReading(false);return f;
}

test('记忆自动处理默认关闭：升级后的库不自行调用模型，所有入口按关闭处理',async t=>{
 const f=await savedFixture(t,{automatic:false});
 let memory;const port=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 await memory.initialize();
 assert.deepEqual(memory.readAutomatic(),{enabled:false});assert.equal(memory.automaticEnabled,false);
 // 用户显式入口给出明确的关闭原因；自动入口静默不建轮。
 await assert.rejects(memory.start(randomUUID()),{code:'memory_auto_processing_disabled'});
 await assert.rejects(memory.startHistory(f.saved[0].contact_id,randomUUID()),{code:'memory_auto_processing_disabled'});
 await assert.rejects(memory.continue(randomUUID(),0,randomUUID()),{code:'memory_auto_processing_disabled'});
 assert.equal(await memory.startContact(f.saved[0].contact_id,randomUUID()),null);
 assert.equal(await memory.startHistoryBatch(f.saved[0].contact_id,randomUUID()),null);
 assert.equal(await memory.recoverBacklog(),0);assert.equal(await memory.resumeFollowups(),0);
 assert.equal(port.calls,0,'关闭时没有任何模型调用');
 assert.equal((await memory.read()),null,'关闭时也没有创建处理轮次');
});

test('开关持久保存并跨重启保持；开启后沿正常入口处理',async t=>{
 const f=await savedFixture(t,{automatic:false});
 let first;first=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>first.accounting,emptyScenes));
 assert.deepEqual(await first.setAutomatic(true),{enabled:true});await first.close();
 // 同一库上的新服务实例从库内读取开关，不依赖内存。
 let memory;const port=modelPort(()=>memory.accounting,emptyScenes);memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 await memory.initialize();assert.deepEqual(memory.readAutomatic(),{enabled:true});
 const run=await memory.start(randomUUID());await memory.waitForIdle();
 assert.ok(port.calls>0);assert.equal((await memory.read(run.runId)).succeeded,1);
 await assert.rejects(memory.setAutomatic('yes'),{code:'memory_extraction_request_invalid'});
 assert.deepEqual(await memory.setAutomatic(false),{enabled:false});assert.deepEqual(await memory.setAutomatic(false),{enabled:false},'重复关闭幂等');
});

test('关闭时在途小批完成后停在步骤边界，开启后沿原任务续跑剩余目标',async t=>{
 const f=await fixture(t);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:21},(_,i)=>record(String(i+1))),completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(f.saved[0].contact_id);await f.contacts.setReading(false);
 let entered,release;const ready=new Promise(r=>entered=r),waiting=new Promise(r=>release=r);let memory;
 const model=modelPort(()=>memory.accounting,async request=>{if(model.calls===1){entered();await waiting;}return emptyScenes(request);});
 memory=new SqliteMemoryExtraction(f.storage,owner,model);t.after(()=>memory.close());
 const run=await memory.start(randomUUID());await ready;
 await memory.setAutomatic(false);release();await memory.waitForIdle();
 const paused=await memory.read(run.runId);assert.equal(paused.state,'paused');assert.equal(paused.succeeded,20);assert.equal(model.calls,1,'关闭后不再领取下一小批');
 await memory.setAutomatic(true);await memory.waitForIdle();
 const done=await memory.read(run.runId);assert.equal(done.succeeded,21);assert.equal(model.calls,2);assert.deepEqual(done.tasks.map(t=>t.taskId),run.tasks.map(t=>t.taskId),'沿原任务继续，不新建轮次');
});

test('开启只继续由关闭动作暂停的轮次，用户手动暂停保持暂停',async t=>{
 const f=await fixture(t);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:21},(_,i)=>record(String(i+1))),completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(f.saved[0].contact_id);await f.contacts.setReading(false);
 let entered,release;const ready=new Promise(r=>entered=r),waiting=new Promise(r=>release=r);let memory;
 const model=modelPort(()=>memory.accounting,async request=>{if(model.calls===1){entered();await waiting;}return emptyScenes(request);});
 memory=new SqliteMemoryExtraction(f.storage,owner,model);t.after(()=>memory.close());
 const run=await memory.start(randomUUID());await ready;
 await memory.pause(run.runId);// 用户先手动暂停
 await memory.setAutomatic(false);release();await memory.waitForIdle();
 await memory.setAutomatic(true);await memory.waitForIdle();
 const view=await memory.read(run.runId);assert.equal(view.state,'paused','用户暂停不被总开关解除');assert.equal(model.calls,1);
});

test('调度器在关闭时不扫描不建轮，开启后经唤醒重新扫描',async t=>{
 let enabled=false,scans=0,started=0;
 const scheduler=new SqliteMemoryL1Scheduler({
  scheduleContacts:async()=>{scans++;return ['c1'];},
  scanSchedule:async()=>({contacts:[{contactId:'c1',incrementalDueAt:null,historyDue:true}]}),
  startContact:async()=>null,startHistoryBatch:async()=>{started++;return null;},
 },{enabled:()=>enabled,setTimeout:()=>0,clearTimeout:()=>{}});
 t.after(()=>scheduler.close());
 await scheduler.start();await scheduler.wake();assert.equal(scans,0,'关闭时不读取库');assert.equal(started,0);
 enabled=true;await scheduler.wake();assert.ok(scans>0);assert.ok(started>0,'开启后恢复建轮');
});

test('认证HTTP读取并设置总开关，拒绝额外字段、非布尔值与错误方法',async t=>{
 const f=await savedFixture(t,{automatic:false});
 let memory;memory=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>memory.accounting,emptyScenes));t.after(()=>memory.close());await memory.initialize();
 const handler=new SqliteMemoryExtractionHttp(memory,req=>authorizeSqliteRequest(req,'synthetic-token'));
 const server=createServer(async(req,res)=>{if(!await handler.handle(req,res)){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url=`http://127.0.0.1:${server.address().port}/api/memory-processing/automatic`,headers={authorization:'Bearer synthetic-token','content-type':'application/json'};
 assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{...headers,origin:'https://invalid.example'}})).status,401);
 assert.deepEqual(await (await fetch(url,{headers})).json(),{enabled:false});
 for(const body of ['{}','{"enabled":"yes"}','{"enabled":true,"owner_id":"x"}','[true]','null','not-json'])assert.equal((await fetch(url,{method:'POST',headers,body})).status,400,body);
 assert.equal((await fetch(url,{method:'PUT',headers,body:'{"enabled":true}'})).status,400);assert.equal((await fetch(`${url}?x=1`,{headers})).status,400);
 const on=await fetch(url,{method:'POST',headers,body:'{"enabled":true}'});assert.equal(on.status,200);assert.deepEqual(await on.json(),{enabled:true});
 assert.deepEqual(await (await fetch(url,{headers})).json(),{enabled:true});assert.equal(memory.automaticEnabled,true);
 const off=await fetch(url,{method:'POST',headers,body:'{"enabled":false}'});assert.deepEqual(await off.json(),{enabled:false});
});

const registryModule=mode=>new URL(`./fixtures/memory-management/auto-switch-upgrade-registry.mjs?mode=${mode}`,import.meta.url).href;
test('41升级46保留自动处理默认关闭与既有消息，来源证明折叠且旧迁移账本不变',{timeout:20000},async t=>{
 const cleanup=[];let upgraded,memory;
 t.after(async()=>{await memory?.close();await upgraded?.close();for(const close of cleanup.reverse())await close();});
 const f=await fixture({after:close=>cleanup.push(close)},{registryModule:registryModule('legacy'),automatic:false});
 assert.equal(f.storage.status.schemaVersion,41);
 await f.service.synchronize(f.saved[0].contact_id);
 const databaseId=f.storage.status.databaseId,path=join(f.root,'managed/sqlite/notalone.sqlite');
 await f.service.close();await f.storage.close();
 const read=()=>{const db=new DatabaseSync(path,{readOnly:true});try{return {messages:db.prepare('SELECT id,text_body FROM message ORDER BY id').all(),migrations:db.prepare('SELECT version,checksum FROM schema_migration ORDER BY version').all(),columns:db.prepare("SELECT name FROM pragma_table_info('database_instance')").all().map(row=>row.name),tables:db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row=>row.name)};}finally{db.close();}};
 const before=read();assert.equal(before.tables.includes('source_proof'),false);for(const name of ['history_continuity_fence','history_continuity_scope','history_guard_lease'])assert.equal(before.tables.includes(name),true);assert.ok(before.messages.length>0);assert.equal(before.columns.includes('memory_auto_processing'),false);
 upgraded=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId,registryModule:registryModule('current')});
 assert.equal(upgraded.status.schemaVersion,49);await upgraded.close();upgraded=undefined;
 const after=read();assert.equal(after.tables.includes('source_proof'),true);for(const name of ['history_continuity_fence','history_continuity_scope','history_guard_lease'])assert.equal(after.tables.includes(name),false);assert.deepEqual(after.messages,before.messages);assert.deepEqual(after.migrations.slice(0,41),before.migrations);assert.equal(after.migrations.length,49);
 const db=new DatabaseSync(path,{readOnly:true});assert.equal(db.prepare('SELECT memory_auto_processing AS v FROM database_instance WHERE slot=1').get().v,0,'升级后默认关闭');db.close();
 upgraded=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId,registryModule:registryModule('current')});
 memory=new SqliteMemoryExtraction(upgraded,owner,{prepare:async()=>{throw new Error('not invoked');},invoke:async()=>{throw new Error('not invoked');}});
 await memory.initialize();assert.deepEqual(memory.readAutomatic(),{enabled:false});
});
