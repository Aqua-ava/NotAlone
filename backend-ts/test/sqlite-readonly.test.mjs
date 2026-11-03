import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,rename,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';

const registryModule=new URL('./fixtures/sqlite/readonly-registry.mjs',import.meta.url).href;
async function fixture(t){
 const userData=await realpath(await mkdtemp(join(tmpdir(),'notalone-sqlite-reader-')));
 const options={userData,intent:'create',role:'test',registryModule};
 const storage=await SqliteStorage.open(options);
 t.after(async()=>{await storage.close();await rm(userData,{recursive:true,force:true});});
 return {storage,options};
}

test('附属读者沿用运行租约、读取最新提交且不排队等待后台长SELECT',async t=>{
 const {storage}=await fixture(t),lease=storage.status;
 const reader=await storage.openReader(['reader.value','reader.lease']);
 assert.deepEqual(await reader.execute('reader.lease',{}),{databaseId:lease.databaseId,runtimeId:lease.runtimeId,epoch:lease.epoch});
 assert.equal(await reader.execute('reader.value',{}),7n);
 await storage.execute('reader.save',19);
 assert.equal(await reader.execute('reader.value',{}),19n);
 const started=new SharedArrayBuffer(4),backgroundBegan=performance.now();let settled=false;
 const slow=storage.execute('reader.slow',{started}).finally(()=>{settled=true;});
 await Atomics.waitAsync(new Int32Array(started),0,0,5000).value;
 assert.equal(Atomics.load(new Int32Array(started),0),1);
 const began=performance.now();assert.equal(await reader.execute('reader.value',{}),19n);
 const readerMs=performance.now()-began;
 assert.ok(readerMs<750,'附属短读不应等待后台长查询');
 assert.equal(settled,false);
 await slow;t.diagnostic(JSON.stringify({readerMs:Math.round(readerMs*10)/10,backgroundMs:Math.round((performance.now()-backgroundBegan)*10)/10}));await reader.close();
});

test('附属读者拒绝写者、维护、任意动作与事务外遗留读能力',async t=>{
 const {storage}=await fixture(t);
 for(const action of ['reader.save','reader.compact','arbitrary.sql'])await assert.rejects(storage.openReader([action]),{code:'readonly_action_forbidden'});
 const reader=await storage.openReader(['reader.value','reader.illegalWrite','reader.illegalSqlWrite','reader.remember','reader.useRemembered']);
 await assert.rejects(reader.execute('reader.save',0),{code:'readonly_action_forbidden'});
 await assert.rejects(reader.execute('reader.illegalWrite',{}),{code:'readonly_write_forbidden'});
 await assert.rejects(reader.execute('reader.illegalSqlWrite',{}));
 assert.equal(await reader.execute('reader.value',{}),7n);
 await reader.execute('reader.remember',{});
 await assert.rejects(reader.execute('reader.useRemembered',{}),{code:'transaction_expired'});
});

test('旧WAL快照结束后重新核验租约，主存储重开不能发布旧读结果',async t=>{
 const {storage,options}=await fixture(t),reader=await storage.openReader(['reader.hold','reader.value']);
 const barrier=new SharedArrayBuffer(8),held=reader.execute('reader.hold',{barrier});
 const rejected=assert.rejects(held,{code:'stale_lease'});
 await Atomics.waitAsync(new Int32Array(barrier),0,0,5000).value;
 assert.equal(Atomics.load(new Int32Array(barrier),0),1);
 let reopened;
 try{reopened=await SqliteStorage.open({...options,intent:'open',expectedDatabaseId:storage.status.databaseId});}
 finally{Atomics.store(new Int32Array(barrier),1,1);Atomics.notify(new Int32Array(barrier),1);}
 t.after(()=>reopened?.close());
 await rejected;
 await assert.rejects(reader.execute('reader.value',{}),{code:'readonly_closed'});
});

test('主存储关闭、失败及打开竞争均撤销附属读者，主动关闭不影响主存储',async t=>{
 const {storage}=await fixture(t);
 const first=await storage.openReader(['reader.value']);await first.close();
 await assert.rejects(first.execute('reader.value',{}),{code:'readonly_closed'});
 assert.equal(await storage.execute('reader.value',{}),7n);
 const second=await storage.openReader(['reader.value']);
 const opening=assert.rejects(storage.openReader(['reader.value']));
 await storage.close();await opening;
 await assert.rejects(second.execute('reader.value',{}),{code:'readonly_closed'});
 await assert.rejects(storage.openReader(['reader.value']),{code:'worker_failed'});
 const other=await fixture(t),reader=await other.storage.openReader(['reader.value']);
 await assert.rejects(other.storage.execute('reader.crash',{}),{code:'worker_failed'});
 await assert.rejects(reader.execute('reader.value',{}),{code:'readonly_closed'});
});

test('运行中数据库文件被替换时读者和新增附属连接均拒绝',async t=>{
 const {storage,options}=await fixture(t),reader=await storage.openReader(['reader.value']);
 const database=join(options.userData,'managed/sqlite/notalone.sqlite'),displaced=join(options.userData,'original.sqlite');
 await rename(database,displaced);await writeFile(database,'合成替换文件',{mode:0o600});
 try{
  await assert.rejects(reader.execute('reader.value',{}),{code:'storage_identity_changed'});
  await assert.rejects(storage.openReader(['reader.value']),{code:'storage_identity_changed'});
 }finally{await rm(database);await rename(displaced,database);}
 await assert.rejects(reader.execute('reader.value',{}),{code:'readonly_closed'});
});

test('关闭在途附属读者后释放WAL快照且不交付迟到结果',async t=>{
 const {storage}=await fixture(t),reader=await storage.openReader(['reader.hold']);
 const barrier=new SharedArrayBuffer(8),held=assert.rejects(reader.execute('reader.hold',{barrier}),{code:'readonly_closed'});
 await Atomics.waitAsync(new Int32Array(barrier),0,0,5000).value;
 assert.equal(Atomics.load(new Int32Array(barrier),0),1);
 await storage.execute('reader.save',21);await reader.close();await held;
 assert.equal(await storage.execute('reader.checkpoint',{}),0n);
 assert.equal(await storage.execute('reader.value',{}),21n);
});
