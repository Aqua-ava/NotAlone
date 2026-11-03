import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {registry} from '../src/storage/sqlite/registry.ts';
const registryModule=mode=>new URL(`./fixtures/memory-management/timeline-guard-registry.mjs?mode=${mode}`,import.meta.url).href;

async function guardedSource(t,mode='current'){
 const cleanup=[],beforeCleanup=[];const f=await fixture({after:close=>cleanup.push(close)},{registryModule:registryModule(mode)});
 const inspect=f.channel.inspect;f.channel.guardSession={loss:new Promise(()=>{})};
 f.channel.inspect=async scope=>({...await inspect(scope),continuity:'same-source-instances-normal-use-v1',capabilities:Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'].map(key=>[key,'supported']))});
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true});
 const contactId=f.saved[0].contact_id,scope={scopeKind:'contact',contactId};
 await f.service.synchronize(contactId);
 const management=new SqliteMemoryManagement(f.storage,owner);
 const made=await management.decide({requestKey:'guard-repro',action:'manual',scope,body:'合成可恢复来源资料'});
 await f.storage.execute('fixture.paginationUpgradeCitations',{ownerId:owner,contactId,memoryId:made.memoryId,count:1});
 t.after(async()=>{await f.service.close();for(const close of beforeCleanup)await close();for(const close of cleanup.reverse())await close();});
 return {...f,contactId,scope,management,memoryId:made.memoryId,beforeCleanup};
}
async function revalidate(f,storage,token){
 const source=await storage.execute('history.scope',{token});
 const report=await f.channel.inspect(source),target=await f.channel.target(source);
 assert.deepEqual(await storage.execute('history.prepareNormalUseGuard',{token,report,target,guardId:'synthetic-revalidated-guard'}),{ok:true,revalidated:true});
}
async function expectedTime(storage,memoryId){
 const snapshot=await storage.execute('fixture.paginationUpgradeSnapshot',{ownerId:owner});
 assert.equal(snapshot.memories.find(memory=>memory.id===memoryId).management_source_time,1700000000000n);
 return snapshot;
}

test('临时守卫失效不永久清空目录时间，期间正文仍不可读，续证后可见来源时间保持一致',async t=>{
 const f=await guardedSource(t);await f.service.close();
 const hidden=await f.management.read(f.scope);
 assert.equal(hidden.memories[0].current,null);assert.equal(hidden.memories[0].versions[0].body,null);assert.deepEqual(hidden.memories[0].versions[0].sources,[]);
 await expectedTime(f.storage,f.memoryId);
 const token=await f.contacts.eligibility(f.contactId);await revalidate(f,f.storage,token);
 const restored=await f.management.read(f.scope);
 assert.equal(restored.memories[0].current.body,'合成可恢复来源资料');
 assert.equal(restored.memories[0].current.sources[0].sentAt,'1700000000000');await expectedTime(f.storage,f.memoryId);
});

test('已应用37的守卫失效空时间由后续迁移排队重建，旧账本不修改',async t=>{
 const f=await guardedSource(t,'legacy37');assert.equal(f.storage.status.schemaVersion,37);
 const token=await f.contacts.eligibility(f.contactId);await f.service.close();
 await f.storage.execute('fixture.timelineCachedNull37',{ownerId:owner,memoryId:f.memoryId});
 const before=await f.storage.execute('fixture.paginationUpgradeSnapshot',{ownerId:owner});
 assert.equal(before.memories[0].management_source_time,null);
 await f.storage.close();
 const upgraded=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:f.storage.status.databaseId,registryModule:registryModule('current')});
 f.beforeCleanup.push(()=>upgraded.close());assert.equal(upgraded.status.schemaVersion,registry.migrations.at(-1).version);assert.ok(upgraded.status.schemaVersion>37);
 const management=new SqliteMemoryManagement(upgraded,owner);
 const hidden=await management.read(f.scope);assert.equal(hidden.memories[0].current,null);assert.equal(hidden.memories[0].versions[0].body,null);
 const after=await expectedTime(upgraded,f.memoryId);assert.deepEqual(after.ledger.slice(0,37),before.ledger);
 await revalidate(f,upgraded,token);
 const restored=await management.read(f.scope);assert.equal(restored.memories[0].current.body,'合成可恢复来源资料');
 await expectedTime(upgraded,f.memoryId);assert.deepEqual(await upgraded.check(),{integrity:'ok',foreignKeys:'ok'});
});
