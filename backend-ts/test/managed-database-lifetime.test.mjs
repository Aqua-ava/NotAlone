import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
test('同一内核寿命锁阻止资料服务越过仍存活的消费者，释放后可取得独占',async t=>{
 assert.equal(process.platform,'darwin','本切片只对已核验的Darwin启用');
 const directory=await mkdtemp(join(tmpdir(),'notalone-pg-lifetime-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const file=join(directory,'lifetime');await writeFile(file,'',{mode:0o600});
 const {acquireManagedDatabaseLease}=await import('../src/managed-database-lifetime.ts');
 const release=await acquireManagedDatabaseLease(file);
 const probe=()=>spawnSync(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';try{const fd=fs.openSync(${JSON.stringify(file)},fs.constants.O_RDWR|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK|0x20);fs.closeSync(fd);process.exit(0)}catch(e){process.exit(['EWOULDBLOCK','EAGAIN'].includes(e.code)?3:4)}`],{encoding:'utf8',timeout:3000});
 assert.equal(probe().status,3);await release();await release();assert.equal(probe().status,0);
});
test('寿命文件缺失、不可写、权限过宽或链接时均拒绝且不创建替代文件',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'notalone-pg-lifetime-invalid-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const {acquireManagedDatabaseLease}=await import('../src/managed-database-lifetime.ts');
 await assert.rejects(acquireManagedDatabaseLease(join(directory,'missing')),{code:'managed_lifetime_invalid'});
 const file=join(directory,'lifetime');await writeFile(file,'',{mode:0o600});await chmod(file,0o400);
 await assert.rejects(acquireManagedDatabaseLease(file),{code:'managed_lifetime_invalid'});await chmod(file,0o644);
 await assert.rejects(acquireManagedDatabaseLease(file),{code:'managed_lifetime_invalid'});await chmod(file,0o600);
 await symlink(file,join(directory,'linked'));await assert.rejects(acquireManagedDatabaseLease(join(directory,'linked')),{code:'managed_lifetime_invalid'});
});
// 旧 Python flock 互操作用例保留在固定 Git 历史入口；当前锁生命周期覆盖只执行 Node。
