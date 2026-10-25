/** 仅保存无正文尝试元数据；崩溃后未知不自动重放。 */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {open,lstat,realpath,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
export const sha=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const terminal=new Set(['responded','failed','unknown']);
export class AttemptJournal {
  #db;#lock;#lockIdentity;#closed=false;#problem;
  static async open({directory,problemId,recoverStaleLock}){
    assert.ok(typeof problemId==='string'&&problemId,'journal_problem_required');
    const dir=await lstat(directory);
    assert.ok(dir.isDirectory()&&!dir.isSymbolicLink()&&(dir.mode&0o777)===0o700&&dir.uid===process.getuid(),'journal_private_directory_required');
    directory=await realpath(directory);
    const lock=join(directory,'attempts.lock');let handle;
    try{handle=await open(lock,'wx',0o600);}catch(error){
      if(error.code!=='EEXIST')throw error;
      assert.equal(typeof recoverStaleLock,'function','journal_locked');
      const before=await lstat(lock);
      assert.ok(before.isFile()&&!before.isSymbolicLink()&&(before.mode&0o777)===0o600&&before.uid===dir.uid,'journal_lock_invalid');
      const prior=JSON.parse(await readFile(lock,'utf8'));
      assert.equal(prior.problem_id,problemId,'journal_lock_problem_changed');
      assert.equal(await recoverStaleLock(Object.freeze(prior)),true,'journal_recovery_not_authorized');
      const after=await lstat(lock);assert.equal(after.ino,before.ino,'journal_lock_changed');
      // 只有根已证实旧持有者停止才可释放；PID存在或重用一律失败关闭。
      let alive=true;try{process.kill(prior.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
      assert.equal(alive,false,'journal_previous_owner_alive');
      await unlink(lock);handle=await open(lock,'wx',0o600);
    }
    await handle.writeFile(JSON.stringify({pid:process.pid,token:randomUUID(),problem_id:problemId}));await handle.sync();
    const lockIdentity=(await handle.stat()).ino;await handle.close();
    const path=join(directory,'attempts.sqlite');let db;
    try{
      try{const f=await open(path,'wx',0o600);await f.close();}catch(e){if(e.code!=='EEXIST')throw e;}
      const s=await lstat(path);assert.ok(s.isFile()&&!s.isSymbolicLink()&&(s.mode&0o777)===0o600&&s.uid===dir.uid,'journal_private_file_required');
      db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA busy_timeout=1000;CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,logical_key TEXT UNIQUE NOT NULL,run_id TEXT NOT NULL,state TEXT NOT NULL,record TEXT NOT NULL);CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,kind TEXT NOT NULL,attempt_id TEXT NOT NULL,at TEXT NOT NULL,payload TEXT NOT NULL,previous_sha256 TEXT NOT NULL,event_sha256 TEXT NOT NULL);');
      db.prepare('INSERT OR IGNORE INTO meta VALUES(?,?)').run('problem_id',problemId);
      assert.equal(db.prepare('SELECT value FROM meta WHERE key=?').get('problem_id').value,problemId,'journal_problem_changed');
      const journal=new AttemptJournal();Object.assign(journal,{});journal.#db=db;journal.#lock=lock;journal.#lockIdentity=lockIdentity;journal.#problem=problemId;
      journal.verify();
      for(const row of journal.list())if(!terminal.has(row.state))journal.#change(row.attempt_id,'unknown','recovery_unknown',{
        recovered_from:row.state,physical_attempted:null,
        outcome_reason:'process_interrupted_no_automatic_replay',usage:null,cost:null});
      return journal;
    }catch(e){db?.close();await unlink(lock);throw e;}
  }
  #assertOpen(){assert.ok(!this.#closed,'journal_closed');}
  bindBroker({snapshot_sha256,deadline,observed_used}){
    this.#assertOpen();const context={snapshot_sha256,deadline,initial_used:observed_used};
    this.#db.prepare('INSERT OR IGNORE INTO meta VALUES(?,?)').run('broker_context',JSON.stringify(context));
    const bound=JSON.parse(this.#db.prepare('SELECT value FROM meta WHERE key=?').get('broker_context').value);
    assert.equal(bound.snapshot_sha256,snapshot_sha256,'journal_source_snapshot_changed');assert.equal(bound.deadline,deadline,'journal_deadline_changed');
    assert.ok(observed_used>=bound.initial_used,'journal_outer_used_counter_decreased');return bound;
  }
  #event(kind,id,payload){
    const last=this.#db.prepare('SELECT seq,event_sha256 FROM events ORDER BY seq DESC LIMIT 1').get();
    const row={seq:(last?.seq??0)+1,kind,attempt_id:id,at:new Date().toISOString(),payload,previous_sha256:last?.event_sha256??'0'.repeat(64)};
    this.#db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(row.seq,kind,id,row.at,JSON.stringify(payload),row.previous_sha256,sha(row));
  }
  #change(id,state,kind,data={}){
    this.#assertOpen();this.#db.exec('BEGIN IMMEDIATE');
    try{
      const prior=this.get(id);assert.ok(prior,'journal_attempt_missing');
      assert.ok(!terminal.has(prior.state),'journal_attempt_terminal');
      const row={...prior,...data,state,updated_at:new Date().toISOString()};
      this.#db.prepare('UPDATE attempts SET state=?,record=? WHERE id=?').run(state,JSON.stringify(row),id);
      this.#event(kind,id,{state,...data,record_sha256:sha(row)});this.#db.exec('COMMIT');return row;
    }catch(e){this.#db.exec('ROLLBACK');throw e;}
  }
  ready(binding){
    this.#assertOpen();assert.equal(binding.problem_id,this.#problem,'journal_problem_changed');
    assert.ok(binding.attempt_id&&binding.run_id,'journal_binding_required');
    assert.match(binding.request_sha256??'',/^[a-f0-9]{64}$/,'journal_request_sha_required');
    this.#db.exec('BEGIN IMMEDIATE');try{
      assert.equal(this.#db.prepare("SELECT count(*) n FROM attempts WHERE run_id=? AND state IN ('ready','reserved','dispatching','unknown')").get(binding.run_id).n,0,'journal_run_unresolved');
      const logical=sha({problem_id:binding.problem_id,run_id:binding.run_id,route:binding.route,request_sha256:binding.request_sha256});
      assert.ok(!this.#db.prepare('SELECT id FROM attempts WHERE logical_key=? OR id=?').get(logical,binding.attempt_id),'journal_attempt_replay');
      const row={attempt_id:binding.attempt_id,run_id:binding.run_id,route:binding.route,request_sha256:binding.request_sha256,
        binding_sha256:sha(binding),source_snapshot_sha256:binding.source_snapshot_sha256??null,logical_key:logical,
        state:'ready',physical_attempted:false,reservation:null,usage:null,cost:null,ready_at:new Date().toISOString()};
      this.#db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?)').run(binding.attempt_id,logical,binding.run_id,'ready',JSON.stringify(row));
      this.#event('ready',binding.attempt_id,{...row,record_sha256:sha(row)});this.#db.exec('COMMIT');return row;
    }catch(e){this.#db.exec('ROLLBACK');throw e;}
  }
  reserving(id){assert.equal(this.get(id)?.state,'ready','journal_ready_required');return this.#change(id,'ready','reserve_requested',{reserve_requested:true});}
  reserved(id,reservation){assert.equal(this.get(id)?.state,'ready','journal_ready_required');return this.#change(id,'reserved','reserved',{reservation:structuredClone(reservation),reserved_at:new Date().toISOString()});}
  acknowledge(id,ack){assert.equal(this.get(id)?.state,'reserved','journal_reserved_required');return this.#change(id,'reserved','ack',{ack_sha256:sha(ack),ack_at:new Date().toISOString()});}
  dispatching(id,data){assert.equal(this.get(id)?.state,'reserved','journal_reserved_required');return this.#change(id,'dispatching','dispatching',{...data,physical_attempted:null,dispatching_at:new Date().toISOString()});}
  finish(id,state,data){assert.ok(terminal.has(state),'journal_terminal_invalid');return this.#change(id,state,state,data);}
  get(id){this.#assertOpen();const r=this.#db.prepare('SELECT record FROM attempts WHERE id=?').get(id);return r?JSON.parse(r.record):null;}
  list(){this.#assertOpen();return this.#db.prepare('SELECT record FROM attempts ORDER BY rowid').all().map(r=>JSON.parse(r.record));}
  events(){this.#assertOpen();return this.#db.prepare('SELECT * FROM events ORDER BY seq').all().map(r=>({...r,payload:JSON.parse(r.payload)}));}
  verify(){let previous='0'.repeat(64),seq=0;const latest=new Map();for(const e of this.events()){
    assert.equal(e.seq,++seq,'journal_sequence_changed');assert.equal(e.previous_sha256,previous,'journal_chain_changed');
    assert.equal(sha({seq:e.seq,kind:e.kind,attempt_id:e.attempt_id,at:e.at,payload:e.payload,previous_sha256:e.previous_sha256}),e.event_sha256,'journal_event_changed');previous=e.event_sha256;latest.set(e.attempt_id,e.payload.record_sha256);
    }for(const [id,digest]of latest)assert.equal(sha(this.get(id)),digest,'journal_record_changed');
    assert.equal(this.list().length,latest.size,'journal_record_set_changed');return {events:seq,tail_sha256:previous};}
  async close(){if(this.#closed)return;this.verify();this.#db.close();this.#closed=true;assert.equal((await lstat(this.#lock)).ino,this.#lockIdentity,'journal_lock_changed');await unlink(this.#lock);}
}
