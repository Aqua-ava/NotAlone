import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';

const registryModule=new URL('./fixtures/memory-documents/later-schedule-release-growth-registry.mjs',import.meta.url).href;
async function prepared(t,contacts){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-later-release-growth-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule});
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});
 const ownerId=randomUUID(),seed=await storage.execute('fixture.laterReleaseSeed',{ownerId,contacts});
 return {storage,ownerId,...seed,
  queue:()=>storage.execute('fixture.laterReleaseQueue',{ownerId}),
  change:input=>storage.execute('fixture.laterReleaseState',{ownerId,...seed,...input}),
 };
}

test('多联系人任务与后续队列增长时，同一已释放运行的完整资格只核验一次',{timeout:30_000},async t=>{
 const small=await prepared(t,2),large=await prepared(t,100);
 const before=await small.queue(),after=await large.queue();
 t.diagnostic(JSON.stringify({small:{tasks:3,...before},large:{tasks:101,...after}}));
 assert.deepEqual(before.summary,{pending:3,nextDueAt:123,stage:'document_scene'});
 assert.deepEqual(after.summary,{pending:101,nextDueAt:123,stage:'document_scene'});
 assert.ok(before.releaseQualificationQueries<=1,'同一运行的多个任务不能重复核验完整退休资格');
 assert.ok(after.releaseQualificationQueries<=1,'联系人和队列增长不能重复展开同一运行的完整调用链');
 assert.equal(before.embeddedReleaseQualificationQueries,0,'任务候选扫描不能逐行执行完整运行退休链');
 assert.equal(after.embeddedReleaseQualificationQueries,0);
 assert.deepEqual(await small.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 assert.deepEqual(await large.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('释放资格只在单次队列读取内复用，新增未知任务和合法暂停仍阻挡后续阶段',async t=>{
 const f=await prepared(t,2);
 assert.deepEqual((await f.queue()).summary,{pending:3,nextDueAt:123,stage:'document_scene'});
 await f.change({taskState:'unknown'});
 assert.deepEqual((await f.queue()).summary,{pending:3,nextDueAt:null,stage:null},'新动作必须复核未知任务，不能沿用先前已释放结果');
 await f.change({taskState:'failed'});
 assert.deepEqual((await f.queue()).summary,{pending:3,nextDueAt:123,stage:'document_scene'});
 await f.change({runState:'paused'});
 assert.deepEqual((await f.queue()).summary,{pending:3,nextDueAt:null,stage:null},'仍在进行的用户暂停不能当作终态释放');
 await f.change({runState:'failed'});
 assert.deepEqual((await f.queue()).summary,{pending:3,nextDueAt:123,stage:'document_scene'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
