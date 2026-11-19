import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {owner,record,fixture,select} from './fixtures/history/sync-support.mjs';
import {MaintenanceRefusal,assertBackupDirSafe,assertDatabaseIdle,assertDiskSpace,backupDatabase,compactAll,readIdentity} from '../scripts/maintenance/compact-read-goals-lib.mjs';

const script=new URL('../scripts/maintenance/compact-read-goals.mjs',import.meta.url).pathname;
const tempDir=t=>{const dir=realpathSync(mkdtempSync(join(tmpdir(),'notalone-compact-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
const goalCount=root=>{const db=new DatabaseSync(join(root,'managed/sqlite/notalone.sqlite'),{readOnly:true});try{return Number(db.prepare('SELECT count(*) n FROM read_goal').get().n);}finally{db.close();}};

/** 合成库：一位联系人，另造 n 个已过期、无记录的链式增量目标；返回已关闭存储的 userData 根。 */
async function closedDatabase(t,n=450){
 const f=await fixture(t);f.state.historyRecords=[record('1')];const binding=await select(f);await f.history.synchronize(binding.contact_id);
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));db.function('notalone_sha256',{deterministic:true},v=>v);
 try{
  const columns=db.prepare('SELECT name FROM pragma_table_info(?)').all('read_goal').map(c=>c.name);
  const template=db.prepare("SELECT * FROM read_goal WHERE kind='incremental' LIMIT 1").get();
  const insert=db.prepare(`INSERT INTO read_goal(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
  let no=Number(db.prepare('SELECT max(creation_no) m FROM read_goal').get().m),previous=null;
  for(let i=0;i<n;i++){const id=randomUUID();insert.run(...columns.map(c=>({...template,id,state:'invalidated',failure_code:'history_eligibility_changed',creation_no:BigInt(++no),created_at:BigInt(Date.now()-3*86400000-i),handoff_from_goal_id:previous})[c]));previous=id;}
 }finally{db.close();}
 await f.history.close();await f.contacts.close();await f.storage.close();
 return {root:f.root,binding};
}
const run=(args)=>spawnSync(process.execPath,['--no-warnings',script,...args],{encoding:'utf8',timeout:240000});

test('占用检测：lsof 报告持有进程时拒绝，无持有者时放行',()=>{
 assert.throws(()=>assertDatabaseIdle(process.execPath,{exec:()=>'123\n456\n'}),error=>error instanceof MaintenanceRefusal&&/123,456/.test(error.message));
 assert.doesNotThrow(()=>assertDatabaseIdle(process.execPath,{exec:()=>{const e=new Error('none');e.status=1;throw e;}}));
 assert.throws(()=>assertDatabaseIdle(process.execPath,{exec:()=>{const e=new Error('boom');e.status=2;throw e;}}),/boom/,'lsof 自身故障不能被当作“无占用”');
});

test('磁盘与备份目录检查：空间不足、备份目录在 managed/ 内都拒绝',t=>{
 const dir=tempDir(t),db=join(dir,'x.sqlite');writeFileSync(db,Buffer.alloc(1024));
 assert.throws(()=>assertDiskSpace(db,join(dir,'b'),{statfs:()=>({bavail:1,bsize:4096})}),error=>error instanceof MaintenanceRefusal&&/不足/.test(error.message));
 assert.ok(assertDiskSpace(db,join(dir,'b'),{statfs:()=>({bavail:1e9,bsize:4096})}).free>0);
 assert.throws(()=>assertBackupDirSafe(dir,join(dir,'managed/backups')),/managed/);
 assert.throws(()=>assertBackupDirSafe(dir,'relative/dir'),/绝对路径/);
 assert.doesNotThrow(()=>assertBackupDirSafe(dir,join(dir,'maintenance-backups/a')));
});

test('备份：复制库与 WAL 并核对大小与哈希；复制失败或内容被破坏时删除半成品并中止',async t=>{
 const dir=tempDir(t),db=join(dir,'notalone.sqlite');writeFileSync(db,'main-file-content');writeFileSync(`${db}-wal`,'wal-content');
 const ok=await backupDatabase(db,join(dir,'backup-ok'));
 assert.deepEqual(ok.manifest.map(m=>m.file).sort(),['notalone.sqlite','notalone.sqlite-wal']);
 assert.equal(readFileSync(join(dir,'backup-ok/notalone.sqlite'),'utf8'),'main-file-content');
 await assert.rejects(backupDatabase(db,join(dir,'backup-ok')),/拒绝覆盖/,'已有备份不被覆盖');
 let calls=0;
 await assert.rejects(backupDatabase(db,join(dir,'backup-fail'),{copy:(source,target,flags)=>{if(++calls===2)throw new Error('磁盘写满');writeFileSync(target,readFileSync(source));}}),error=>error instanceof MaintenanceRefusal&&/备份失败/.test(error.message));
 assert.deepEqual(readdirSync(join(dir,'backup-fail')),[],'半成品被删除');
 await assert.rejects(backupDatabase(db,join(dir,'backup-corrupt'),{copy:(source,target)=>writeFileSync(target,'corrupted!!!!!!!!!')}),/备份失败/);
});

test('CLI：默认只试算，备份目录建立，库内行数不变；--execute 备份后分批删除，重跑幂等；占用与备份失败时不改库',async t=>{
 const {root}=await closedDatabase(t);const base=[`--user-data=${root}`,'--no-warmup'];
 const before=goalCount(root);
 const dry=run([...base,`--backup-dir=${join(root,'maintenance-backups/dry')}`]);
 assert.equal(dry.status,0,dry.stderr+dry.stdout);
 assert.match(dry.stdout,/试算/);assert.match(dry.stdout,/未删除（dry-run）/);assert.match(dry.stdout,/已备份到/);
 assert.equal(goalCount(root),before,'试算不删除任何行');
 assert.ok(existsSync(join(root,'maintenance-backups/dry/notalone.sqlite')));
 const projected=Number(/可清理 (\d+)（约 (\d+) 批/.exec(dry.stdout)[1]);assert.ok(projected>=400);

 // 备份目录位于 managed/ 内：拒绝（退出码 2），未打开存储、未改库。
 const bad=run([...base,`--backup-dir=${join(root,'managed/oops')}`,'--execute']);assert.equal(bad.status,2);assert.match(bad.stderr,/managed/);assert.equal(goalCount(root),before);
 // 备份目录已有同名备份：拒绝覆盖，同样不改库。
 const dup=run([...base,`--backup-dir=${join(root,'maintenance-backups/dry')}`,'--execute']);assert.equal(dup.status,2);assert.match(dup.stderr,/拒绝覆盖/);assert.equal(goalCount(root),before);
 // 备份目录不可创建（父路径是文件）：备份失败即中止。
 writeFileSync(join(root,'not-a-dir'),'x');
 const unwritable=run([...base,`--backup-dir=${join(root,'not-a-dir/sub')}`,'--execute']);assert.notEqual(unwritable.status,0);assert.equal(goalCount(root),before,'备份失败不删除任何行');

 const exec=run([...base,`--backup-dir=${join(root,'maintenance-backups/exec')}`,'--execute']);
 assert.equal(exec.status,0,exec.stderr+exec.stdout);
 assert.match(exec.stdout,/已删除 (\d+)（(\d+) 批）/);
 const deleted=Number(/已删除 (\d+)/.exec(exec.stdout)[1]);assert.equal(deleted,projected,'执行删除数＝试算数');
 assert.equal(goalCount(root),before-deleted);
 assert.match(exec.stdout,/库校验 \{"integrity":"ok","foreignKeys":"ok"\}/);
 assert.ok(existsSync(join(root,'maintenance-backups/exec/notalone.sqlite')),'执行前已备份');
 // 备份是执行前的库：行数仍为 before。
 const backup=new DatabaseSync(join(root,'maintenance-backups/exec/notalone.sqlite'),{readOnly:true});
 try{assert.equal(Number(backup.prepare('SELECT count(*) n FROM read_goal').get().n),before);}finally{backup.close();}
 const again=run([...base,`--backup-dir=${join(root,'maintenance-backups/again')}`,'--execute']);
 assert.equal(again.status,0);assert.match(again.stdout,/已删除 0（0 批）/,'重跑幂等');
 assert.equal(goalCount(root),before-deleted);
});

test('compactAll：批间收到停止请求后保留已提交的批，重跑从断点续做',async t=>{
 const {root}=await closedDatabase(t,600);
 const {SqliteStorage}=await import('../src/storage/sqlite/client.ts');
 const identity=readIdentity(join(root,'managed/sqlite/notalone.sqlite'));
 const open=()=>SqliteStorage.open({userData:root,intent:'open',expectedDatabaseId:identity.databaseId,role:identity.role});
 let storage=await open();let batches=0;
 const first=await compactAll({storage,ownerId:identity.ownerId,execute:true,batch:200,shouldStop:()=>batches>=1,onEvent:e=>{if(e.kind==='batch')batches++;}});
 assert.equal(first.interrupted,true);assert.equal(first.deleted,200);
 await storage.close();
 const mid=goalCount(root);
 storage=await open();
 const second=await compactAll({storage,ownerId:identity.ownerId,execute:true,batch:200});
 t.after(()=>storage.close());
 assert.equal(second.interrupted,false);assert.ok(second.deleted>0);
 assert.equal(goalCount(root),mid-second.deleted);
 assert.equal((await compactAll({storage,ownerId:identity.ownerId,execute:true,batch:200})).deleted,0);
});
