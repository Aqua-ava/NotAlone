import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,writeFile,readFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {loadManifest} from '../src/platform/cutover/control.ts';
import * as startup from '../src/platform/cutover/startup.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';

async function fixture(t){
 const userData=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-startup-preflight-')));
 t.after(()=>rm(userData,{recursive:true,force:true}));
 const ready=await startup.runDefaultDatabaseStartup({userData});
 assert.equal(ready.phase,'ready');
 return {userData,ready};
}
test('桌面重开预检只准备既有目标，不打开数据库或让正在使用的租约失效',async t=>{
 const {userData,ready}=await fixture(t);
 const storage=await SqliteStorage.open({userData,intent:'open',role:'test',expectedDatabaseId:ready.databaseId});
 try{
  const prepared=await startup.prepareDefaultDatabaseStartup({userData});
  assert.equal(prepared.phase,'prepared');
  assert.equal(prepared.databaseId,ready.databaseId);assert.equal(prepared.ownerId,ready.ownerId);
  assert.equal(prepared.schemaVersion,undefined,'预检没有核验数据库版本，不能宣称已就绪');
  assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
  assert.equal(await storage.execute('identity.resolveOwner',{proposedOwnerId:'should-not-replace-owner',at:1}),ready.ownerId);
 }finally{await storage.close();}
});

test('预检不把损坏文件宣称为就绪，正式打开仍拒绝并保留原文件',async t=>{
 const {userData,ready}=await fixture(t),file=path.join(userData,'managed/sqlite/notalone.sqlite');
 await writeFile(file,'synthetic corrupted SQLite');
 const prepared=await startup.prepareDefaultDatabaseStartup({userData});
 assert.equal(prepared.phase,'prepared');
 await assert.rejects(SqliteStorage.open({userData,intent:'open',role:'test',expectedDatabaseId:prepared.databaseId}));
 assert.equal(await readFile(file,'utf8'),'synthetic corrupted SQLite');
 await rm(file);
 const missing=await startup.prepareDefaultDatabaseStartup({userData});
 assert.equal(missing.phase,'maintenance');
 assert.equal(missing.code,'cutover_storage_failed');
 await assert.rejects(readFile(file),{code:'ENOENT'});
});

test('首次资料准备仍完整创建并验证，已有目录中新出现的未知资料仍阻断',async t=>{
 const userData=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-preflight-create-')));
 t.after(()=>rm(userData,{recursive:true,force:true}));
 const created=await startup.prepareDefaultDatabaseStartup({userData});
 assert.equal(created.phase,'ready');assert.equal(created.created,true);
 const unknown=path.join(userData,'managed/unknown-store');await writeFile(unknown,'保留未知资料',{mode:0o600});
 const blocked=await startup.prepareDefaultDatabaseStartup({userData});
 assert.equal(blocked.phase,'maintenance');assert.equal(blocked.code,'cutover_legacy_target_unclassified');
 assert.equal(await readFile(unknown,'utf8'),'保留未知资料');
});


for(const mode of ['complete','prepared'])test(`已有本人身份缺失后${mode}阻断重试仍保留原身份，不生成新本人`,async t=>{
 const {userData,ready}=await fixture(t),file=path.join(userData,'managed/sqlite/notalone.sqlite');
 const remove=new DatabaseSync(file);remove.exec('DELETE FROM owner');remove.close();
 const run=mode==='complete'?startup.runDefaultDatabaseStartup:startup.prepareDefaultDatabaseStartup;
 if(mode==='prepared')await chmod(file,0o644);
 const first=await run({userData});assert.equal(first.phase,'maintenance');
 if(mode==='prepared')await chmod(file,0o600);
 assert.equal(loadManifest(userData).target.ownerId,ready.ownerId);
 for(let retry=0;retry<2;retry++){
  const result=await run({userData});assert.equal(result.phase,'maintenance','重试不能把缺失本人补成新的成功启动');
  assert.equal(loadManifest(userData).target.ownerId,ready.ownerId,'清单中原本人身份不能被随机身份覆盖');
  const check=new DatabaseSync(file,{readOnly:true});
  try{assert.equal(check.prepare('SELECT COUNT(*) AS n FROM owner').get().n,0);}
  finally{check.close();}
 }
});

test('接管已有启动配置时沿用现存本人，缺失本人不能按首次创建补齐',async t=>{
 for(const missing of [false,true])await t.test(missing?'缺失本人':'现存本人',async sub=>{
  const {userData,ready}=await fixture(sub),file=path.join(userData,'managed/sqlite/notalone.sqlite');
  if(missing){const db=new DatabaseSync(file);db.exec('DELETE FROM owner');db.close();}
  await rm(path.join(userData,'database-cutover/manifest.json'));
  const result=await startup.runDefaultDatabaseStartup({userData});
  if(!missing){assert.equal(result.phase,'ready');assert.equal(result.ownerId,ready.ownerId);return;}
  assert.equal(result.phase,'maintenance');
  const check=new DatabaseSync(file,{readOnly:true});
  try{assert.equal(check.prepare('SELECT COUNT(*) AS n FROM owner').get().n,0);}
  finally{check.close();}
 });
});
