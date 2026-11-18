import {prepareDatabaseStartup} from '../src/platform/database-startup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,realpath,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadManifest,saveManifest} from '../src/platform/cutover/control.ts';
import {runDefaultDatabaseStartup} from './fixtures/cutover/default-startup.mjs';

// 全部使用隔离的合成 userData；存活宿主用当前测试进程号表示，不启动真实后台。
async function fixture(t){
 const userData=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-startup-live-runtime-')));
 t.after(()=>rm(userData,{recursive:true,force:true}));
 const ready=await runDefaultDatabaseStartup({userData});
 assert.equal(ready.phase,'ready');
 return {userData,ready};
}
const handshake=(pid)=>`address=127.0.0.1:1\ntoken=synthetic\npid=${pid}\n`;
async function privateFile(location,content){await mkdir(path.dirname(location),{recursive:true,mode:0o700});await writeFile(location,content,{mode:0o600});}
// 本 App 自己启动的 SQLite 宿主仍存活时留下的握手与启动锁。
async function liveRuntime(userData,pid=process.pid){
 await privateFile(path.join(userData,'managed/sqlite-backend.info'),handshake(pid));
 await privateFile(path.join(userData,'managed/sqlite-backend.info.dsh-lock'),JSON.stringify({nonce:'synthetic-live',parentPid:pid,childPid:pid})+'\n');
}
const kept=(userData)=>{const manifest=loadManifest(userData);return {phase:manifest.phase,revision:manifest.revision,blockedCode:manifest.blockedCode};};

test('自有SQLite宿主仍存活时重连预检直接准备原目标，不把运行锁记成旧写入者',async t=>{
 const {userData,ready}=await fixture(t);
 await liveRuntime(userData);
 const before=kept(userData);
 const prepared=await prepareDatabaseStartup({userData});
 assert.equal(prepared.phase,'prepared',JSON.stringify(prepared));
 assert.equal(prepared.databaseId,ready.databaseId);assert.equal(prepared.ownerId,ready.ownerId);
 assert.deepEqual(kept(userData),before,'预检不改写已完成的切换清单');
 // 重复预检同样稳定，运行产物保持原样。
 assert.equal((await prepareDatabaseStartup({userData})).phase,'prepared');
 assert.deepEqual(kept(userData),before);
});

test('完成切换后旧写入器记录不再参与桌面准备，也不取得清理权限',async t=>{
 const {userData}=await fixture(t);
 await privateFile(path.join(userData,'managed/backend.info'),handshake(process.pid));
 const result=await prepareDatabaseStartup({userData});
 assert.equal(result.phase,'prepared');assert.equal(result.code,'sqlite_prepared');
 assert.equal(loadManifest(userData).phase,'completed');
 assert.equal(await readFile(path.join(userData,'managed/backend.info'),'utf8'),handshake(process.pid));
});

test('重开会打开数据库，自有宿主存活时拒绝但不把已完成清单改成阻断',async t=>{
 const {userData}=await fixture(t);
 await liveRuntime(userData);
 const before=kept(userData);
 const blocked=await runDefaultDatabaseStartup({userData});
 assert.equal(blocked.phase,'maintenance');assert.equal(blocked.code,'cutover_legacy_writer_running');
 assert.deepEqual(kept(userData),before);
 await rm(path.join(userData,'managed/sqlite-backend.info'));await rm(path.join(userData,'managed/sqlite-backend.info.dsh-lock'));
 const reopened=await runDefaultDatabaseStartup({userData});
 assert.equal(reopened.phase,'ready',JSON.stringify(reopened));assert.equal(reopened.code,'sqlite_reopened');
});

test('已被旧缺陷标成阻断的清单：宿主仍存活时恢复预检，宿主退出后沿原实例自愈',async t=>{
 const {userData,ready}=await fixture(t);
 await liveRuntime(userData);
 const completed=loadManifest(userData);
 // 旧缺陷的落盘现场：phase 被写成 blocked，原因是自有运行锁。
 saveManifest(userData,{...completed,phase:'blocked',blockedCode:'cutover_legacy_writer_running'});
 const stuck=kept(userData);
 const prepared=await prepareDatabaseStartup({userData});
 assert.equal(prepared.phase,'prepared',JSON.stringify(prepared));
 assert.equal(prepared.databaseId,ready.databaseId);assert.deepEqual(kept(userData),stuck,'存活期间不触碰清单，也不清理运行产物');
 // 宿主退出后的下一次启动沿同一实例完成切换并恢复完成态。
 await rm(path.join(userData,'managed/sqlite-backend.info'));await rm(path.join(userData,'managed/sqlite-backend.info.dsh-lock'));
 const healed=await prepareDatabaseStartup({userData});
 assert.ok(['ready','prepared'].includes(healed.phase),JSON.stringify(healed));
 assert.equal(healed.databaseId,ready.databaseId);assert.equal(healed.ownerId,ready.ownerId);
 assert.equal(loadManifest(userData).phase,'completed');
});

test('清单因其他原因阻断时，存活宿主不能绕过阻断',async t=>{
 const {userData}=await fixture(t);
 await liveRuntime(userData);
 const completed=loadManifest(userData);
 saveManifest(userData,{...completed,phase:'blocked',blockedCode:'cutover_checks_failed'});
 const result=await prepareDatabaseStartup({userData});
 assert.equal(result.phase,'maintenance',JSON.stringify(result));
});
