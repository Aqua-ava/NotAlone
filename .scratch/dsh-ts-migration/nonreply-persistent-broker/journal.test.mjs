/** 持久边界测试只使用合成标识与私有临时目录。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AttemptJournal,sha} from './attempt-journal.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const binding={problem_id:'synthetic-broker',attempt_id:'synthetic-attempt-1',run_id:'synthetic-run',route:'messages',
  request_sha256:'a'.repeat(64),source_snapshot_sha256:'b'.repeat(64)};
test('持久化dispatching在重开后保留unknown，禁止换attempt ID重放',async()=>{
  const root=await mkdtemp(join(tmpdir(),'na-broker-journal-'));await chmod(root,0o700);
  try{
    let j=await AttemptJournal.open({directory:root,problemId:'synthetic-broker'});
    j.ready(binding);j.reserved(binding.attempt_id,{reservation_id:'synthetic-reservation',ordinal:1,binding_sha256:sha(binding)});
    j.dispatching(binding.attempt_id,{ack_sha256:'c'.repeat(64)});await j.close();
    j=await AttemptJournal.open({directory:root,problemId:'synthetic-broker'});
    assert.equal(j.get(binding.attempt_id).state,'unknown');
    assert.equal(j.get(binding.attempt_id).physical_attempted,null);
    assert.throws(()=>j.ready({...binding,attempt_id:'synthetic-attempt-2'}),/journal_run_unresolved/);
    assert.ok(j.events().some(e=>e.kind==='recovery_unknown'));
    await j.close();
  }finally{await rm(root,{recursive:true,force:true});}
});
test('实际进程退出留下dispatching和锁，根核验旧进程停止后恢复为unknown',async()=>{
  const root=await mkdtemp(join(tmpdir(),'na-broker-crash-'));await chmod(root,0o700);
  try{
    const code=`import {AttemptJournal,sha} from ${JSON.stringify(new URL('./attempt-journal.mjs',import.meta.url).href)};
      const j=await AttemptJournal.open({directory:process.argv[1],problemId:'synthetic-broker'});
      const b=${JSON.stringify(binding)};j.ready(b);j.reserved(b.attempt_id,{reservation_id:'synthetic-crash-reservation',ordinal:1,binding_sha256:sha(b)});
      j.dispatching(b.attempt_id,{ack_sha256:'c'.repeat(64)});process.exit(41);`;
    await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','-e',code,root]),e=>e.code===41);
    await assert.rejects(AttemptJournal.open({directory:root,problemId:'synthetic-broker'}),/journal_locked/);
    const j=await AttemptJournal.open({directory:root,problemId:'synthetic-broker',recoverStaleLock:async prior=>Number.isSafeInteger(prior.pid)&&prior.problem_id==='synthetic-broker'});
    assert.equal(j.get(binding.attempt_id).state,'unknown');assert.equal(j.get(binding.attempt_id).reservation.ordinal,1);
    assert.equal(j.get(binding.attempt_id).physical_attempted,null);assert.equal(j.verify().events,4);await j.close();
  }finally{await rm(root,{recursive:true,force:true});}
});
