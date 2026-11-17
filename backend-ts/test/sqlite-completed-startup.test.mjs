import {prepareDatabaseStartup} from '../src/platform/database-startup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runDefaultDatabaseStartup} from '../src/platform/cutover/startup.ts';
import {loadStartupConfiguration,saveStartupConfiguration} from '../src/platform/cutover/control.ts';

test('切换完成后的桌面准备只核验当前实例，不再解释或清理旧写入器记录',async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-completed-startup-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const ready=await runDefaultDatabaseStartup({userData:root});assert.equal(ready.phase,'ready');
 const retired=path.join(root,'managed','backend.info'),content=`pid=${process.pid}\n`;
 await writeFile(retired,content,{mode:0o600});
 const prepared=await prepareDatabaseStartup({userData:root});
 assert.equal(prepared.phase,'prepared',JSON.stringify(prepared));
 assert.equal(prepared.databaseId,ready.databaseId);assert.equal(prepared.ownerId,ready.ownerId);
 assert.equal(await readFile(retired,'utf8'),content,'退役记录保留，不取得删除权限');
});

test('完成态最小准备仍拒绝实例配置错配，恢复配置后沿用原库',async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-completed-identity-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const ready=await runDefaultDatabaseStartup({userData:root});assert.equal(ready.phase,'ready');
 const configuration=loadStartupConfiguration(root);
 saveStartupConfiguration(root,{...configuration,expectedDatabaseId:'different-synthetic-instance'});
 const blocked=await prepareDatabaseStartup({userData:root});
 assert.equal(blocked.phase,'maintenance');assert.equal(blocked.code,'cutover_configuration_conflict');
 saveStartupConfiguration(root,configuration);
 const restored=await prepareDatabaseStartup({userData:root});
 assert.equal(restored.phase,'prepared');assert.equal(restored.databaseId,ready.databaseId);
});

test('完成态最小准备仍拒绝未知受管条目且不删除现场',async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-completed-unknown-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const ready=await runDefaultDatabaseStartup({userData:root});assert.equal(ready.phase,'ready');
 const unknown=path.join(root,'managed','unexpected');await writeFile(unknown,'合成现场',{mode:0o600});
 const blocked=await prepareDatabaseStartup({userData:root});
 assert.equal(blocked.phase,'maintenance');assert.equal(blocked.code,'cutover_legacy_target_unclassified');
 assert.equal(await readFile(unknown,'utf8'),'合成现场');
});
