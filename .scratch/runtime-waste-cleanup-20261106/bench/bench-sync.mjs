// 测量 SQLite synchronous=FULL/NORMAL 的单次写事务耗时与 sha256 吞吐（合成数据，临时目录用完即删）。
// 用法：node bench/bench-sync.mjs
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
for(const mode of ['FULL','NORMAL']){
  const dir=mkdtempSync(join(tmpdir(),'notalone-bench-'));const db=new DatabaseSync(join(dir,'t.db'));
  db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=${mode};CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)`);
  const N=300;const t=performance.now();
  for(let i=0;i<N;i++){db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO t(v) VALUES(?)').run('x'.repeat(200));db.exec('COMMIT');}
  console.log(mode,'per-write-tx ms',((performance.now()-t)/N).toFixed(3));
  db.close();rmSync(dir,{recursive:true,force:true});
}
// hash cost
const buf=Buffer.alloc(5*1024*1024,1);let t=performance.now();for(let i=0;i<10;i++)createHash('sha256').update(buf).digest('hex');
console.log('sha256 5MB ms',((performance.now()-t)/10).toFixed(2));
const big=Buffer.alloc(40*1024*1024,1);t=performance.now();createHash('sha256').update(big).digest('hex');console.log('sha256 40MB ms',(performance.now()-t).toFixed(1));
