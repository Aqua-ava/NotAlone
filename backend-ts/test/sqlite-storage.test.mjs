import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
async function fixture(t){
 const userData=await realpath(await mkdtemp(join(tmpdir(),'notalone-sqlite-01-')));
 t.after(()=>rm(userData,{recursive:true,force:true}));
 return {userData,intent:'create',role:'test'};
}
test('首次创建并重开同一实例，旧运行租约不能写入',async t=>{
 const options=await fixture(t);
 const first=await SqliteStorage.open(options);const status=first.status;
 assert.equal(status.schemaVersion,baseRegistry.migrations.length);assert.equal(typeof status.epoch,'bigint');
 assert.match(status.databaseId,/^[a-f0-9-]{36}$/);assert.equal(status.role,'test');
 assert.equal((await stat(join(options.userData,'managed/sqlite/notalone.sqlite'))).mode&0o777,0o600);
 assert.equal((await stat(join(options.userData,'managed/sqlite'))).mode&0o777,0o700);
 assert.equal((await first.check()).integrity,'ok');await first.close();
 const second=await SqliteStorage.open({...options,intent:'open',expectedDatabaseId:status.databaseId});
 t.after(()=>second.close());
 assert.equal(second.status.databaseId,status.databaseId);assert.equal(second.status.epoch,status.epoch+1n);
 await assert.rejects(second.execute('storage.check',{},status),{code:'stale_lease'});
});

const registryModule=new URL('./fixtures/sqlite/registry.mjs',import.meta.url).href;
test('具名事务精确整数、NULL分支、唯一与复合FK隔离并原子回滚',async t=>{
 const options={...await fixture(t),registryModule};const storage=await SqliteStorage.open(options);
 try{
  await storage.execute('facts.addScope',['o','a']);await storage.execute('facts.addScope',['o','b']);
  await storage.execute('facts.save',['o','a','1',9007199254740993n,'known','r']);
  await storage.execute('facts.save',['o','a','2',null,'unknown',null]);
  await assert.rejects(storage.execute('facts.save',['o','a','unsafe',9007199254740992,'known','unsafe']),{code:'storage_value_invalid'});
  assert.equal((await storage.execute('facts.list',['o','a']))[0].value,9007199254740993n);
  assert.equal((await storage.execute('facts.list',['o','a']))[1].value,null);
  assert.deepEqual(await storage.execute('facts.list',['o','b']),[]);
  for(const row of [['other','a','3',null,'unknown',null],['o','a','3',null,'known','z'],['o','a','3',1n,'known','r']])await assert.rejects(storage.execute('facts.save',row));
  await assert.rejects(storage.execute('facts.atomicFailure',{}));
  assert.equal(await storage.execute('facts.addScope',['rollback','contact']),'committed');
  await assert.rejects(storage.execute('facts.asyncWrite',{}),{code:'async_transaction_forbidden'});
  assert.equal(await storage.execute('facts.addScope',['async','contact']),'committed');
  await assert.rejects(storage.execute('facts.illegalReadWrite',{}));
  assert.equal(await storage.execute('facts.addScope',['read','contact']),'committed');
  await assert.rejects(storage.execute('arbitrary.sql','DELETE FROM fact'),{code:'action_unavailable'});
  assert.equal(await storage.execute('facts.compact',{}),'compacted');
  assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
 }finally{await storage.close();}
});

import {chmod,writeFile,readFile,symlink,mkdir,rename} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {registry as baseRegistry} from '../src/storage/sqlite/registry.ts';
const databasePath=o=>join(o.userData,'managed/sqlite/notalone.sqlite');
async function makeRegistry(options,name,sql,version=baseRegistry.migrations.length+1){
 const file=join(options.userData,`${name}.mjs`);
 await writeFile(file,`import {registry as base} from ${JSON.stringify(new URL('../src/storage/sqlite/registry.ts',import.meta.url).href)}; export const registry={migrations:[...base.migrations,{version:${version},sql:${JSON.stringify(sql)}}],actions:[]};`);
 return new URL(`file://${file}`).href;
}
test('升级失败保留实例与原版本，修正后升级且重复打开不重放',async t=>{
 const options=await fixture(t);let s=await SqliteStorage.open(options);const id=s.status.databaseId;await s.close();
 const bad=await makeRegistry(options,'bad','CREATE TABLE upgraded(id INTEGER); INSERT INTO nonexistent VALUES(1);');
 await assert.rejects(SqliteStorage.open({...options,intent:'open',expectedDatabaseId:id,registryModule:bad}));
 s=await SqliteStorage.open({...options,intent:'open',expectedDatabaseId:id});assert.equal(s.status.schemaVersion,baseRegistry.migrations.length);await s.close();
 const good=await makeRegistry(options,'good','CREATE TABLE upgraded(id INTEGER); INSERT INTO upgraded VALUES(7);');
 s=await SqliteStorage.open({...options,intent:'open',expectedDatabaseId:id,registryModule:good});assert.equal(s.status.schemaVersion,baseRegistry.migrations.length+1);await s.close();
 s=await SqliteStorage.open({...options,intent:'open',expectedDatabaseId:id,registryModule:good});assert.equal(s.status.schemaVersion,baseRegistry.migrations.length+1);await s.close();
 await assert.rejects(SqliteStorage.open({...options,intent:'open',expectedDatabaseId:id}),{code:'schema_too_new'});
});
test('普通打开拒绝缺失、实例不符、损坏、漂移和未知高版本，不换空库',async t=>{
 const options=await fixture(t);const s=await SqliteStorage.open(options),id=s.status.databaseId;await s.close();
 const reopen=()=>SqliteStorage.open({...options,intent:'open',expectedDatabaseId:id});
 const before=await readFile(databasePath(options));
 await assert.rejects(SqliteStorage.open({...options,intent:'open',expectedDatabaseId:'wrong'}),{code:'instance_mismatch'});
 await assert.rejects(SqliteStorage.open({...options,intent:'reset',expectedDatabaseId:id}),{code:'reset_requires_cutover'});
 assert.deepEqual(await readFile(databasePath(options)),before);
 const db=new DatabaseSync(databasePath(options));db.exec('CREATE TABLE drift(id TEXT)');db.close();
 await assert.rejects(reopen(),{code:'schema_drift'});
 await writeFile(databasePath(options),Buffer.from('synthetic corrupted SQLite'));
 await assert.rejects(reopen());assert.equal((await readFile(databasePath(options))).toString(),'synthetic corrupted SQLite');
 await rm(databasePath(options));await assert.rejects(reopen(),{code:'storage_missing'});
 await assert.rejects(SqliteStorage.open({...options,intent:'open'}),{code:'instance_required'});
});
test('迁移账本checksum篡改拒绝打开',async t=>{
 const options=await fixture(t);const s=await SqliteStorage.open(options),id=s.status.databaseId;await s.close();
 const db=new DatabaseSync(databasePath(options));db.exec("UPDATE schema_migration SET checksum='wrong'");db.close();
 await assert.rejects(SqliteStorage.open({...options,intent:'open',expectedDatabaseId:id}),{code:'migration_drift'});
});
test('权限、符号链接及运行中换文件拒绝，已有数据库不截断',async t=>{
 const options=await fixture(t);const s=await SqliteStorage.open(options),id=s.status.databaseId;
 await assert.rejects(SqliteStorage.open(options),{code:'storage_already_exists'});
 await chmod(databasePath(options),0o644);await assert.rejects(s.check(),{code:'unsafe_storage_path'});
 await s.close();await chmod(databasePath(options),0o600);
 const target=join(options.userData,'target');await writeFile(target,'keep',{mode:0o600});
 await rm(databasePath(options));await symlink(target,databasePath(options));
 await assert.rejects(SqliteStorage.open({...options,intent:'open',expectedDatabaseId:id}),{code:'unsafe_storage_path'});
 assert.equal(await readFile(target,'utf8'),'keep');
});
test('两连接WAL读取不阻塞，busy有界且Worker异常回滚后旧句柄拒绝',async t=>{
 const options={...await fixture(t),registryModule};const s=await SqliteStorage.open(options),id=s.status.databaseId;
 const db=new DatabaseSync(databasePath(options));db.exec('PRAGMA foreign_keys=ON;BEGIN IMMEDIATE');
 try{
  assert.deepEqual(await s.execute('facts.list',['o','a']),[]);
  let heartbeat=false;const tick=setTimeout(()=>{heartbeat=true;},10);
  const start=performance.now();await assert.rejects(s.execute('facts.addScope',['o','a']),{code:'storage_busy'});
  clearTimeout(tick);assert.equal(heartbeat,true);assert.ok(performance.now()-start<2000);
 }finally{db.exec('ROLLBACK');db.close();}
 await s.execute('facts.addScope',['o','a']);
 await assert.rejects(s.execute('facts.crash',{}),{code:'worker_failed'});
 await assert.rejects(s.check(),{code:'worker_failed'});await s.close();
 const reopened=await SqliteStorage.open({...options,intent:'open',expectedDatabaseId:id});
 try{assert.equal(await reopened.execute('facts.addScope',['crash','contact']),'committed');assert.deepEqual(await reopened.check(),{integrity:'ok',foreignKeys:'ok'});}finally{await reopened.close();}
});

import {spawn} from 'node:child_process';
import {once} from 'node:events';
test('进程中断升级后由同一实例回滚恢复，未提交版本不留成功账本',async t=>{
 const options=await fixture(t);const first=await SqliteStorage.open(options),id=first.status.databaseId;await first.close();
 const module=await makeRegistry(options,'interrupted',`PRAGMA cache_size=10;CREATE TABLE interrupted(value TEXT);WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000000) INSERT INTO interrupted SELECT printf('%01000d',x) FROM n;`);
 const script=join(options.userData,'upgrade.mjs');
 await writeFile(script,`import {SqliteStorage} from ${JSON.stringify(new URL('../src/storage/sqlite/client.ts',import.meta.url).href)};const s=await SqliteStorage.open(${JSON.stringify({...options,intent:'open',expectedDatabaseId:id,registryModule:module})});await s.close();`);
 const child=spawn(process.execPath,[script],{stdio:['ignore','ignore','pipe']});const exited=once(child,'exit');
 try{
  await new Promise((resolve,reject)=>{
   const deadline=Date.now()+5000;
   const timer=setInterval(async()=>{
    try{if((await stat(databasePath(options)+'-wal')).size>500000){clearInterval(timer);resolve();}}
    catch{}
    if(Date.now()>deadline){clearInterval(timer);reject(new Error('没有观察到升级中的WAL写入'));}
   },10);
  });
  child.kill('SIGKILL');await exited;
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
 const recovered=await SqliteStorage.open({...options,intent:'open',expectedDatabaseId:id});
 try{assert.equal(recovered.status.databaseId,id);assert.equal(recovered.status.schemaVersion,baseRegistry.migrations.length);assert.deepEqual(await recovered.check(),{integrity:'ok',foreignKeys:'ok'});}finally{await recovered.close();}
});

 test('运行中数据库文件被替换及配置根符号链接时拒绝访问',async t=>{
 const options=await fixture(t);const s=await SqliteStorage.open(options);
 await rename(databasePath(options),databasePath(options)+'.original');
 await writeFile(databasePath(options),'synthetic replacement',{mode:0o600});
 await assert.rejects(s.check(),{code:'storage_identity_changed'});await s.close();
 assert.equal(await readFile(databasePath(options),'utf8'),'synthetic replacement');
 const alias=join(options.userData,'alias');await symlink(options.userData,alias);
 await assert.rejects(SqliteStorage.open({...options,userData:alias}),{code:'unsafe_storage_path'});
 });

test('外键损坏与页面完整性分别核验：普通打开不再预扫全库，显式check仍拒绝FK损坏',async t=>{
 const options={...await fixture(t),registryModule};const s=await SqliteStorage.open(options),id=s.status.databaseId;await s.close();
 const db=new DatabaseSync(databasePath(options),{enableForeignKeyConstraints:false});
 db.exec("INSERT INTO fact VALUES('missing','contact','orphan',NULL,'unknown',NULL)");
 assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();
 // 普通打开不再同步执行 quick_check／foreign_key_check：FK 损坏在打开时不被发现。
 const reopened=await SqliteStorage.open({...options,intent:'open',expectedDatabaseId:id});
 try{
  assert.equal(reopened.status.databaseId,id);
  // 显式 check 仍分别核验：FK 失败不能被 integrity 通过掩盖。
  await assert.rejects(reopened.check(),{code:'foreign_keys_failed'});
 }finally{await reopened.close();}
});

test('升级仍先拒绝原有外键损坏，不让后续迁移掩盖损坏资料；普通打开不再预扫',async t=>{
 const options={...await fixture(t),registryModule};
 const first=await SqliteStorage.open(options),id=first.status.databaseId;await first.close();
 const db=new DatabaseSync(databasePath(options));
 db.exec("PRAGMA foreign_keys=OFF; INSERT INTO fact VALUES('missing','contact','invalid',NULL,'unknown',NULL)");db.close();
 // 普通打开不执行全库检查：同样的损坏在无升级、无残留的重开中不会被发现。
 const reopened=await SqliteStorage.open({...options,intent:'open',expectedDatabaseId:id});
 assert.equal(reopened.status.databaseId,id);await reopened.close();
 const before=await readFile(databasePath(options));
 const repairFile=join(options.userData,'invalid-repair.mjs');
 await writeFile(repairFile,`import {registry as base} from ${JSON.stringify(registryModule)};export const registry={...base,migrations:[...base.migrations,{version:base.migrations.length+1,sql:"DELETE FROM fact WHERE owner_id='missing'"}]};`);
 await assert.rejects(SqliteStorage.open({...options,intent:'open',expectedDatabaseId:id,registryModule:new URL(`file://${repairFile}`).href}),{code:'foreign_keys_failed'});
 assert.deepEqual(await readFile(databasePath(options)),before);
});

test('create 建库仍执行全库完整性检查，CHECK 违规的数据不能建成实例',async t=>{
 const options=await fixture(t);
 const sql="PRAGMA ignore_check_constraints=ON; INSERT INTO fact VALUES('owner','contact','invalid',NULL,'known',NULL); PRAGMA ignore_check_constraints=OFF;";
 const createBadFile=join(options.userData,'create-bad-check.mjs');
 await writeFile(createBadFile,`import {registry as base} from ${JSON.stringify(registryModule)};export const registry={...base,migrations:[...base.migrations,{version:base.migrations.length+1,sql:${JSON.stringify(sql)}}]};`);
 await assert.rejects(SqliteStorage.open({...options,registryModule:new URL(`file://${createBadFile}`).href}),{code:'integrity_failed'});
});

test('上次非正常退出（-wal/-shm残留）的下次打开即使无升级也补一次检查',async t=>{
 const options={...await fixture(t),registryModule};
 const first=await SqliteStorage.open(options),id=first.status.databaseId;await first.close();
 // 模拟崩溃：子进程关闭FK约束写入孤儿行后保持连接不关，随后被 SIGKILL，留下残留旁路文件。
 const script=join(options.userData,'crash-orphan.mjs');
 await writeFile(script,`import {DatabaseSync} from 'node:sqlite';
 const db=new DatabaseSync(${JSON.stringify(databasePath(options))});
 db.exec("PRAGMA foreign_keys=OFF; INSERT INTO fact VALUES('missing','contact','crash',NULL,'unknown',NULL);");
 setTimeout(()=>{},30000);`);
 const child=spawn(process.execPath,[script],{stdio:'ignore'});const exited=once(child,'exit');
 for(let i=0;i<300;i++){try{if((await stat(databasePath(options)+'-wal')).size>0)break;}catch{}await new Promise(r=>setTimeout(r,10));}
 child.kill('SIGKILL');await exited;
 // 无升级、已是WAL，但残留信号要求打开时补检查：FK 损坏仍被拒绝。
 await assert.rejects(SqliteStorage.open({...options,intent:'open',expectedDatabaseId:id}),{code:'foreign_keys_failed'});
});

test('升级后完整性失败仍回滚，旧版本及既有资料保持可用',async t=>{
 const options={...await fixture(t),registryModule};
 const first=await SqliteStorage.open(options),id=first.status.databaseId;
 await first.execute('facts.addScope',['owner','contact']);await first.close();
 const migrationFile=join(options.userData,'invalid-check.mjs');
 const sql="PRAGMA ignore_check_constraints=ON; INSERT INTO fact VALUES('owner','contact','invalid',NULL,'known',NULL); PRAGMA ignore_check_constraints=OFF;";
 await writeFile(migrationFile,`import {registry as base} from ${JSON.stringify(registryModule)};export const registry={...base,migrations:[...base.migrations,{version:base.migrations.length+1,sql:${JSON.stringify(sql)}}]};`);
 await assert.rejects(SqliteStorage.open({...options,intent:'open',expectedDatabaseId:id,registryModule:new URL(`file://${migrationFile}`).href}),{code:'integrity_failed'});
 const reopened=await SqliteStorage.open({...options,intent:'open',expectedDatabaseId:id});
 try{assert.equal(reopened.status.schemaVersion,baseRegistry.migrations.length+1);assert.deepEqual(await reopened.execute('facts.list',['owner','contact']),[]);}
 finally{await reopened.close();}
});
