import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
test('共享处理与追踪迁移可在真实Worker升级重开并通过完整性和外键复核',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-memory-schema-')));let store;
 try{store=await SqliteStorage.open({userData:root,intent:'create',role:'test'});assert.ok(store.status.schemaVersion>=6);assert.deepEqual(await store.check(),{integrity:'ok',foreignKeys:'ok'});const databaseId=store.status.databaseId;await store.close();store=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:databaseId});assert.deepEqual(await store.check(),{integrity:'ok',foreignKeys:'ok'});}finally{await store?.close();await rm(root,{recursive:true,force:true});}
});
