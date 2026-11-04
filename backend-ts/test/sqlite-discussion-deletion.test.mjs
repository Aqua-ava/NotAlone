import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,mkdir,writeFile,access,readFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-discussion-delete-')));
 const options={userData:root,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite/discussion-deletion-registry.mjs',import.meta.url).href};
 let storage=await SqliteStorage.open(options);await storage.execute('discussionTest.seed',{});
 const holders=new ActiveHolders(),files=new ManagedFiles(root);files.prepareArea('runtime');
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});
 return {root,holders,files,get storage(){return storage;},discussion:()=>new SqliteDiscussionService(storage,'o'),deletion:()=>new DeletionService(storage,holders,files,{drainTimeoutMs:100}),async reopen(){const id=storage.status.databaseId;await storage.close();storage=await SqliteStorage.open({...options,intent:'open',expectedDatabaseId:id});}};
}
test('精确讨论删除只推进本段代次，其他讨论及联系人数据代次保持',async t=>{
 const f=await fixture(t),first=await f.discussion().newDiscussion('a'),sibling=await f.discussion().newDiscussion('a'),other=await f.discussion().newDiscussion('b');
 const op=await f.deletion().plan({ownerId:'o',requestKey:'delete-discussion',scope:{kind:'discussion',contactId:'a',discussionId:first.id}});
 await assert.rejects(f.discussion().view('a',first.id),{code:'discussion_unavailable'});
 await assert.rejects(f.discussion().continueDiscussion('a',first.id),{code:'discussion_unavailable'});
 assert.equal((await f.discussion().view('a',sibling.id)).discussion.id,sibling.id);
 assert.equal((await f.discussion().view('b',other.id)).discussion.id,other.id);
 const done=await f.deletion().advance(op);assert.equal(done.state,'completed');
 const state=await f.storage.execute('discussionTest.control',{});
 assert.deepEqual(state.contacts,[{id:'a',data_generation:0n},{id:'b',data_generation:0n}]);
 assert.equal(state.discussions.find(d=>d.id===first.id).generation,1n);
 assert.equal(state.discussions.find(d=>d.id===first.id).state,'deleted');
 await assert.rejects(f.deletion().plan({ownerId:'o',requestKey:'wrong-contact',scope:{kind:'discussion',contactId:'b',discussionId:sibling.id}}),{code:'discussion_deletion_scope_invalid'});
});
async function runtimeCopy(f,discussionId,{copyId='copy-a',complete=true}={}){
 const location=join(f.root,'managed/runtime-copies',copyId);await mkdir(location,{mode:0o700});
 await writeFile(join(location,'events.jsonl'),'合成受管事件',{mode:0o600});
 const address=f.files.capture('runtime',copyId,'directory');
 const entries=[{id:`${copyId}-event`,address:f.files.capture('runtime',`${copyId}/events.jsonl`)},{id:`${copyId}-root`,address}];
 await f.storage.execute('discussionTest.copy',{copyId,discussionId,address,complete,files:entries});
 return {location,address,entries,copyId};
}
test('真实副本完整身份清理，替换同定位的新目录保持受阻且只沿原操作恢复',async t=>{
 const f=await fixture(t),discussion=await f.discussion().newDiscussion('a');
 const copy=await runtimeCopy(f,discussion.id);
 const op=await f.deletion().plan({ownerId:'o',requestKey:'delete-copy',scope:{kind:'discussion',contactId:'a',discussionId:discussion.id}});
 await rename(copy.location,copy.location+'.held');await mkdir(copy.location,{mode:0o700});await writeFile(join(copy.location,'events.jsonl'),'陌生替换件',{mode:0o600});
 const blocked=await f.deletion().advance(op);assert.equal(blocked.state,'blocked');
 assert.equal(await readFile(join(copy.location,'events.jsonl'),'utf8'),'陌生替换件');
 await f.reopen();await rm(copy.location,{recursive:true});await rename(copy.location+'.held',copy.location);
 const done=await f.deletion().advance(op);assert.equal(done.operationId,op.operationId);assert.equal(done.state,'completed');
 await assert.rejects(access(copy.location),{code:'ENOENT'});assert.equal((await f.storage.execute('discussionTest.control',{})).copies.length,0);
 assert.ok(done.targets.every(target=>target.target===null));
});
test('preparing缺少身份与完整manifest时不误删陌生路径，释放错误保持同操作未完成',async t=>{
 const f=await fixture(t),discussion=await f.discussion().newDiscussion('a');
 await f.storage.execute('discussionTest.copy',{copyId:'unknown-copy',discussionId:discussion.id,complete:false});
 const unknown=join(f.root,'managed/runtime-copies/unknown-copy');await mkdir(unknown,{mode:0o700});await writeFile(join(unknown,'private.txt'),'陌生件',{mode:0o600});
 const op=await f.deletion().plan({ownerId:'o',requestKey:'unknown-copy',scope:{kind:'discussion',contactId:'a',discussionId:discussion.id}});
 const blocked=await f.deletion().advance(op);assert.equal(blocked.state,'blocked');assert.equal(await readFile(join(unknown,'private.txt'),'utf8'),'陌生件');
 await f.reopen();const retried=await f.deletion().advance(op);assert.equal(retried.operationId,op.operationId);assert.equal(retried.state,'blocked');
});
test('close错误不清理真实文件，释放成功后才完成同一讨论删除',async t=>{
 const f=await fixture(t),discussion=await f.discussion().newDiscussion('a');const copy=await runtimeCopy(f,discussion.id);
 let fail=true;f.holders.register({ownerId:'o',contactId:'a',generation:0n,key:`runtime:${copy.copyId}`,close:async()=>{if(fail)throw new Error('synthetic close failure');await writeFile(join(copy.location,'events.jsonl'),'合成close末写',{mode:0o600});}});
 const op=await f.deletion().plan({ownerId:'o',requestKey:'close-failure',scope:{kind:'discussion',contactId:'a',discussionId:discussion.id}});
 assert.equal((await f.deletion().advance(op)).state,'blocked');assert.equal(await readFile(join(copy.location,'events.jsonl'),'utf8'),'合成受管事件');
 fail=false;const done=await f.deletion().advance(op);assert.equal(done.state,'completed');await assert.rejects(access(copy.location),{code:'ENOENT'});
});
test('close末写新增文件的真实manifest在同一runner刷新计划后首轮清除',async t=>{
 const f=await fixture(t),discussion=await f.discussion().newDiscussion('a');const copy=await runtimeCopy(f,discussion.id,{complete:false});
 let closed=false;
 f.holders.register({ownerId:'o',contactId:'a',generation:0n,key:`runtime:${copy.copyId}`,close:async()=>{
  await writeFile(join(copy.location,'close-final.jsonl'),'合成真实末写',{mode:0o600});
  await f.storage.execute('discussionTest.registerManifest',{copyId:copy.copyId,files:[{id:'close-final',address:f.files.capture('runtime',`${copy.copyId}/close-final.jsonl`)}]});closed=true;
 }});
 const op=await f.deletion().plan({ownerId:'o',requestKey:'close-manifest',scope:{kind:'discussion',contactId:'a',discussionId:discussion.id}});
 const done=await f.deletion().advance(op);assert.equal(closed,true);assert.equal(done.state,'completed');assert.equal(done.operationId,op.operationId);assert.ok(done.planRevision>op.planRevision);
 await assert.rejects(access(copy.location),{code:'ENOENT'});assert.ok(done.targets.every(target=>target.target===null));
});
test('联系人和账号删除组合真实身份域，覆盖受管副本并保留无关联系人',async t=>{
 for(const kind of ['contact','account']){
  const f=await fixture(t),first=await f.discussion().newDiscussion('a'),other=await f.discussion().newDiscussion('b');const copy=await runtimeCopy(f,first.id);
  const scope=kind==='account'?{kind}:{kind,contactId:'a'};
  const op=await f.deletion().plan({ownerId:'o',requestKey:`delete-${kind}`,scope});
  const done=await f.deletion().advance(op);assert.equal(done.state,'completed');await assert.rejects(access(copy.location),{code:'ENOENT'});
  if(kind==='contact')assert.equal((await f.discussion().view('b',other.id)).discussion.id,other.id);
  else await assert.rejects(f.discussion().view('b',other.id),{code:'discussion_unavailable'});
 }
});
