import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SqliteDiscussionRuntime} from '../src/reply/sqlite/runtime.ts';
import {createSqliteDiscussionHost} from '../src/reply/sqlite/host-runtime.ts';
import {SqliteHostShutdown} from '../src/host/sqlite-shutdown.ts';
import {closeSqliteHostResources} from '../src/sqlite-host-plugin.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';

test('存储永久失败后讨论已排空时正常停读可结束，共享资源关闭且运行副本原样保留',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-dead-storage-close-')));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'managed'),{mode:0o700});const files=new ManagedFiles(root);files.prepareArea('runtime');
 const id=randomUUID(),location=join(root,'managed/runtime-copies',id);await mkdir(location,{mode:0o700});await writeFile(join(location,'events.jsonl'),'合成持久事件\n',{mode:0o600});
 const copy={id,contactId:randomUUID(),discussionId:randomUUID(),dataGeneration:0n,writeGeneration:1n,state:'ready',sdkInstanceId:randomUUID(),managedLocator:id,address:files.capture('runtime',id,'directory')};
 let dead=false,readerClosed=false,modelsClosed=false,storageClosed=false;const calls=[];
 const storage={status:{databaseId:randomUUID()},get failureDiagnostic(){return dead?{cause:'action_timeout',action:'memoryDocuments.publish',pendingCount:1,queuedCount:0}:null;},verifyIdentity(){if(dead)throw new StorageFailure('worker_failed');},async execute(name){calls.push(name);if(dead)throw new StorageFailure('worker_failed');if(name==='runtime.inventory')return [copy];if(name==='discussion.recover')return true;if(name==='runtime.manifest')return true;throw Error('合成未约定动作：'+name);}};
 const discussions=await createSqliteDiscussionHost({ctx:{},storage,ownerId:randomUUID(),userData:root,holders:new ActiveHolders(),reader:{close:async()=>{readerClosed=true;}},authorizeRequest:()=>true});
 dead=true;
 const shutdown=new SqliteHostShutdown(()=>closeSqliteHostResources({discussions,models:{close:async()=>{modelsClosed=true;}},storage:{close:async()=>{storageClosed=true;}}}));
 await shutdown.stop();assert.equal(shutdown.state,'stopped');assert.equal(readerClosed,true);assert.equal(modelsClosed,true);assert.equal(storageClosed,true);
 assert.equal(await readFile(join(location,'events.jsonl'),'utf8'),'合成持久事件\n');assert.equal(calls.filter(name=>name==='runtime.manifest').length,0,'永久失效后不向死库重复提交manifest');
});

async function runtimeFixture(t,{count=1,fault}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-runtime-drain-')));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'managed'),{mode:0o700});const files=new ManagedFiles(root);files.prepareArea('runtime');const copies=[];
 for(let index=0;index<count;index++){const id=randomUUID(),location=join(root,'managed/runtime-copies',id);await mkdir(location,{mode:0o700});await writeFile(join(location,'events.jsonl'),'合成副本'+index,{mode:0o600});copies.push({id,contactId:randomUUID(),discussionId:randomUUID(),dataGeneration:0n,writeGeneration:1n,state:'ready',sdkInstanceId:randomUUID(),managedLocator:id,address:files.capture('runtime',id,'directory')});}
 let dead=false;const calls=[];const storage={status:{databaseId:randomUUID()},get failureDiagnostic(){return dead?{cause:'worker_exit',pendingCount:0,queuedCount:0}:null;},async execute(name,input){calls.push({name,input});if(dead)throw new StorageFailure('worker_failed');if(name==='runtime.inventory')return copies;if(name==='runtime.manifest')return true;throw Error('合成未约定动作：'+name);}};
 const ownerId=randomUUID(),holders=new ActiveHolders();const runtime=new SqliteDiscussionRuntime({ctx:{},storage,ownerId,userData:root,holders,fault});await runtime.initialize();
 return {runtime,calls,root,copies,holders,ownerId,setDead:()=>{dead=true;}};
}

test('一个讨论副本关闭失败时仍等待其他副本实际排空，不能提前返回停读失败',async t=>{
 let count=0;const entered=Promise.withResolvers(),gate=Promise.withResolvers();
 const f=await runtimeFixture(t,{count:2,fault:async point=>{if(point!=='beforeClose')return;if(++count===1)throw new StorageFailure('discussion_runtime_unavailable');entered.resolve();await gate.promise;}});f.setDead();
 let settled=false;const closing=f.runtime.close().then(()=>null,error=>error);closing.then(()=>{settled=true;});await entered.promise;await new Promise(setImmediate);const premature=settled;gate.resolve();const error=await closing;
 assert.equal(premature,false,'失败返回之前所有副本仍须完成真实关闭屏障');assert.equal(error.code,'discussion_runtime_unavailable');
 for(const [index,copy]of f.copies.entries())assert.equal(await readFile(join(f.root,'managed/runtime-copies',copy.id,'events.jsonl'),'utf8'),'合成副本'+index);
});

test('健康存储的正常停读仍保存完整最终文件清单',async t=>{
 const f=await runtimeFixture(t);await f.runtime.close();const manifest=f.calls.filter(call=>call.name==='runtime.manifest');
 assert.equal(manifest.length,1);assert.equal(manifest[0].input.rootAbsent,false);assert.equal(manifest[0].input.files.length,2);
 assert.ok(manifest[0].input.files.some(file=>file.locator.endsWith('/events.jsonl')));assert.equal(await readFile(join(f.root,'managed/runtime-copies',f.copies[0].id,'events.jsonl'),'utf8'),'合成副本0');
});

test('永久失效存储也不能吞掉本地关闭失败，明确重试仅在关闭成功后释放',async t=>{
 let fail=true;const f=await runtimeFixture(t,{fault:point=>{if(point==='beforeClose'&&fail)throw new StorageFailure('discussion_runtime_unavailable');}});f.setDead();
 await assert.rejects(f.runtime.close(),{code:'discussion_runtime_unavailable'});fail=false;await f.runtime.close();
 assert.equal(f.calls.some(call=>call.name==='runtime.manifest'),false);assert.equal(await readFile(join(f.root,'managed/runtime-copies',f.copies[0].id,'events.jsonl'),'utf8'),'合成副本0');
});

test('删除排空不能借存储永久失败跳过文件清单或提前释放holder',async t=>{
 const f=await runtimeFixture(t);f.setDead();const operation={operationId:randomUUID(),ownerId:f.ownerId,scope:{kind:'account'},acceptedGeneration:1n};
 await assert.rejects(f.holders.drain(operation,[],100),{code:'worker_failed'});assert.equal(f.holders.verify(operation,[]),false);
 assert.equal(f.calls.filter(call=>call.name==='runtime.manifest').length,1);assert.equal(await readFile(join(f.root,'managed/runtime-copies',f.copies[0].id,'events.jsonl'),'utf8'),'合成副本0');
 await f.runtime.close();assert.equal(f.holders.verify(operation,[]),true);
});
