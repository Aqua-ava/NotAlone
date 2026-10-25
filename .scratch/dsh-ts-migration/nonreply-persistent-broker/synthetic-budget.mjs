/** 纯 Node 合成问题账本；禁止绑定已有文件，不能用于根真实累计账本。 */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {open,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha} from './attempt-journal.mjs';
export async function createSyntheticBudget({directory,limit=1000,deadline=Date.now()+180000,problemId='synthetic-persistent-broker'}){
  assert.ok(problemId.startsWith('synthetic-'),'synthetic_problem_required');
  assert.ok(Number.isSafeInteger(limit)&&limit>0&&Number.isFinite(deadline)&&deadline>Date.now(),'synthetic_budget_invalid');
  const dir=await lstat(directory);assert.ok(dir.isDirectory()&&!dir.isSymbolicLink()&&(dir.mode&0o777)===0o700,'synthetic_private_directory_required');
  const path=join(directory,'synthetic-budget.sqlite');const f=await open(path,'wx',0o600);await f.close();
  const db=new DatabaseSync(path);db.exec('PRAGMA synchronous=FULL;CREATE TABLE budget(problem TEXT,deadline REAL,limit_count INTEGER,used INTEGER);CREATE TABLE reservations(id TEXT PRIMARY KEY,ordinal INTEGER UNIQUE,binding_sha256 TEXT);');
  db.prepare('INSERT INTO budget VALUES(?,?,?,0)').run(problemId,deadline,limit);let closed=false;
  const read=()=>{assert.ok(!closed,'synthetic_budget_closed');return db.prepare('SELECT * FROM budget').get();};
  const port=Object.freeze({persistent:true,reservationOwner:'outer_broker',problemId,deadline,maxReservations:limit,
    async inspect(){const r=read();return {problemId:r.problem,deadline:r.deadline,maxReservations:r.limit_count,used:r.used,remaining:r.limit_count-r.used};},
    async reserve(binding){db.exec('BEGIN IMMEDIATE');try{
      const r=read();assert.ok(Date.now()<r.deadline&&r.used<r.limit_count,'synthetic_budget_unavailable');assert.equal(binding.problem_id,problemId);
      const id=randomUUID(),ordinal=r.used+1,digest=sha(binding);
      db.prepare('UPDATE budget SET used=?').run(ordinal);db.prepare('INSERT INTO reservations VALUES(?,?,?)').run(id,ordinal,digest);db.exec('COMMIT');
      return Object.freeze({reservation_id:id,ordinal,binding_sha256:digest,problemId,deadline,reservation_owner:'outer_broker'});
    }catch(e){db.exec('ROLLBACK');throw e;}},
    async ack(reservation){const row=db.prepare('SELECT * FROM reservations WHERE id=?').get(reservation?.reservation_id??'');
      assert.ok(row&&row.ordinal===reservation.ordinal&&row.binding_sha256===reservation.binding_sha256,'synthetic_ack_unrecognized');
      const r=read();assert.equal(r.used,row.ordinal,'synthetic_ack_not_fresh');assert.ok(Date.now()<r.deadline,'synthetic_deadline');return reservation;},
  });
  return {port,read,async close(){if(!closed){closed=true;db.close();}}};
}
