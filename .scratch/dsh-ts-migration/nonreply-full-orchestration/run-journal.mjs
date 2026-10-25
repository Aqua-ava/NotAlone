/** 运行级持久记录；与物理 attempt journal 分离，重开不会获得新的执行资格。 */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {open,lstat,readFile,unlink,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha} from '../nonreply-persistent-broker/attempt-journal.mjs';

export const TERMINALS=Object.freeze(['succeeded','failed','unknown','rejected','idle','cancelled']);
export class RunJournal {
  #db;#lock;#inode;#closed=false;
  static async open({directory,binding,recoverStaleLock}){
    const parent=await lstat(directory);
    assert.ok(parent.isDirectory()&&!parent.isSymbolicLink()&&(parent.mode&0o777)===0o700&&parent.uid===process.getuid(),'run_private_directory_required');
    directory=await realpath(directory);
    assert.ok(binding?.problem_id&&/^[a-f0-9]{64}$/.test(binding.plan_sha256)&&/^[a-f0-9]{64}$/.test(binding.source_sha256),'run_binding_required');
    const lock=join(directory,'runs.lock');let handle;
    try{handle=await open(lock,'wx',0o600);}catch(error){
      if(error.code!=='EEXIST')throw error;
      assert.equal(typeof recoverStaleLock,'function','run_journal_locked');
      const before=await lstat(lock);assert.ok(before.isFile()&&!before.isSymbolicLink()&&(before.mode&0o777)===0o600&&before.uid===parent.uid,'run_lock_invalid');
      const prior=JSON.parse(await readFile(lock,'utf8'));
      assert.equal(prior.binding_sha256,sha(binding),'run_lock_binding_changed');
      assert.equal(await recoverStaleLock(Object.freeze(prior)),true,'run_recovery_not_authorized');
      assert.equal((await lstat(lock)).ino,before.ino,'run_lock_changed');
      let alive=true;try{process.kill(prior.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
      assert.equal(alive,false,'run_previous_owner_alive');await unlink(lock);handle=await open(lock,'wx',0o600);
    }
    await handle.writeFile(JSON.stringify({pid:process.pid,token:randomUUID(),binding_sha256:sha(binding)}));await handle.sync();
    const inode=(await handle.stat()).ino;await handle.close();let db;
    try{
      const path=join(directory,'runs.sqlite');try{const h=await open(path,'wx',0o600);await h.close();}catch(e){if(e.code!=='EEXIST')throw e;}
      const file=await lstat(path);assert.ok(file.isFile()&&!file.isSymbolicLink()&&(file.mode&0o777)===0o600&&file.uid===parent.uid,'run_private_file_required');
      db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,record TEXT NOT NULL);CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,record TEXT NOT NULL,previous_sha256 TEXT NOT NULL,event_sha256 TEXT NOT NULL);');
      db.prepare('INSERT OR IGNORE INTO meta VALUES(?,?)').run('binding',JSON.stringify(binding));
      assert.equal(db.prepare('SELECT value FROM meta WHERE key=?').get('binding').value,JSON.stringify(binding),'run_journal_binding_changed');
      const journal=new RunJournal();journal.#db=db;journal.#lock=lock;journal.#inode=inode;journal.verify();
      for(const row of journal.list())if(row.terminal_status==='running')journal.finish(row.run_id,{...row,terminal_status:'unknown',recovery_reason:'interrupted_run_no_automatic_replay',physical_calls:null});
      return journal;
    }catch(error){db?.close();await unlink(lock);throw error;}
  }
  #assertOpen(){assert.ok(!this.#closed,'run_journal_closed');}
  #save(record,insert){
    this.#assertOpen();this.#db.exec('BEGIN IMMEDIATE');
    try{
      if(insert){assert.equal(this.get(record.run_id),null,'run_already_recorded');this.#db.prepare('INSERT INTO runs VALUES(?,?,?)').run(record.run_id,record.terminal_status,JSON.stringify(record));}
      else{assert.equal(this.get(record.run_id)?.terminal_status,'running','run_terminal_immutable');this.#db.prepare('UPDATE runs SET status=?,record=? WHERE id=?').run(record.terminal_status,JSON.stringify(record),record.run_id);}
      const last=this.#db.prepare('SELECT seq,event_sha256 FROM events ORDER BY seq DESC LIMIT 1').get();
      const event={seq:(last?.seq??0)+1,record,previous_sha256:last?.event_sha256??'0'.repeat(64)};
      this.#db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(event.seq,JSON.stringify(record),event.previous_sha256,sha(event));this.#db.exec('COMMIT');return record;
    }catch(error){this.#db.exec('ROLLBACK');throw error;}
  }
  start(run){return this.#save({...structuredClone(run),terminal_status:'running',started_at:new Date().toISOString()},true);}
  finish(id,record){assert.equal(record.run_id,id,'run_result_identity_changed');assert.ok(TERMINALS.includes(record.terminal_status),'run_terminal_invalid');return this.#save({...record,ended_at:new Date().toISOString()},false);}
  recoverOrphan(run,attempts){
    assert.ok(attempts.length,'orphan_attempts_required');
    assert.equal(this.get(run.run_id),null,'run_already_recorded');
    this.start(run);return this.finish(run.run_id,{...run,terminal_status:'unknown',attempts:[],broker_attempt_ids:attempts.map(a=>a.attempt_id),recovery_reason:'physical_journal_exists_business_terminal_missing',physical_calls:null});
  }
  get(id){this.#assertOpen();const row=this.#db.prepare('SELECT record FROM runs WHERE id=?').get(id);return row?JSON.parse(row.record):null;}
  list(){this.#assertOpen();return this.#db.prepare('SELECT record FROM runs ORDER BY rowid').all().map(r=>JSON.parse(r.record));}
  verify(){
    this.#assertOpen();let previous='0'.repeat(64),seq=0;const latest=new Map();
    for(const event of this.#db.prepare('SELECT * FROM events ORDER BY seq').all()){
      const record=JSON.parse(event.record);assert.equal(event.seq,++seq,'run_event_sequence_changed');assert.equal(event.previous_sha256,previous,'run_event_chain_changed');
      assert.equal(sha({seq,record,previous_sha256:previous}),event.event_sha256,'run_event_hash_changed');previous=event.event_sha256;latest.set(record.run_id,sha(record));
    }
    assert.equal(this.list().length,latest.size,'run_record_set_changed');
    for(const [id,digest]of latest)assert.equal(sha(this.get(id)),digest,'run_record_changed');return {events:seq,tail_sha256:previous};
  }
  async close(){if(this.#closed)return;this.verify();this.#db.close();this.#closed=true;assert.equal((await lstat(this.#lock)).ino,this.#inode,'run_lock_changed');await unlink(this.#lock);}
}
