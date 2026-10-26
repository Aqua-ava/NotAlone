import test from 'node:test';
import assert from 'node:assert/strict';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {HostStorage} from '../src/platform/database/host-storage.ts';
import {MemoryManagementHandoff} from '../src/memory/management/memory-management-handoff.ts';

test('移交端口合成PG：排空管理租约、核验原结构、显式恢复及结构失败关闭',async()=>{
 const f=await createStorageFixture();const storage=await HostStorage.open(f.options);
 const gate=new MemoryManagementHandoff(storage);
 await gate.activate();
 try{
 const lease=gate.enter();const transfer=gate.activate();
 assert.equal(gate.status().state,'transferring');assert.equal(gate.status().active_requests,1);
 assert.throws(()=>gate.enter(),{status:503});assert.throws(()=>lease.assertCurrent(),{status:409});
 lease.finish();lease.finish();
 assert.equal((await transfer).owner,'typescript');
 assert.equal(gate.status().owner,'typescript');
 await f.client.query('ALTER TABLE public.expression_preference RENAME COLUMN revision TO unavailable_revision');
 await assert.rejects(gate.activate());
 assert.equal(gate.status().state,'stopped');
 assert.throws(()=>gate.enter(),{status:503});
 await f.client.query('ALTER TABLE public.expression_preference RENAME COLUMN unavailable_revision TO revision');
 assert.equal((await gate.activate()).owner,'typescript');
 }finally{await gate.close();await storage.close();await f.close();}
});

import {parseMemoryManagementJSON} from '../src/memory/management/memory-management-json.ts';
test('管理JSON边界：大整数无损且修订拒绝浮点词法，不误拒忽略字段',()=>{
 assert.equal(parseMemoryManagementJSON('{"expected_revision":9007199254740993}',true).expected_revision,9007199254740993n);
 for(const revision of['1.0','1e0','1E+0'])assert.throws(()=>parseMemoryManagementJSON(`{"expected_revision":${revision}}`,true));
 assert.equal(parseMemoryManagementJSON('{"expected_revision":1.0}',false).expected_revision,1);
 assert.deepEqual(parseMemoryManagementJSON('{"ignored":{"expected_revision":1.0},"expected_revision":2}',true),{ignored:{expected_revision:1},expected_revision:2});
});
