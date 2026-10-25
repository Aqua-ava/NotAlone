import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RunJournal} from './run-journal.mjs';

test('重开后未完成的同一 run 保留 unknown，不能盲目重放',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'na-orchestration-contract-'));await chmod(directory,0o700);
  const binding={problem_id:'synthetic-resume-contract',plan_sha256:'a'.repeat(64),source_sha256:'b'.repeat(64)};
  try{
    let journal=await RunJournal.open({directory,binding});
    journal.start({run_id:'original-run',domain:'memory_extraction'});
    await journal.close();
    journal=await RunJournal.open({directory,binding});
    assert.equal(journal.get('original-run').terminal_status,'unknown');
    assert.equal(journal.get('original-run').recovery_reason,'interrupted_run_no_automatic_replay');
    assert.throws(()=>journal.start({run_id:'original-run'}),/run_already_recorded/);
    await journal.close();
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('失败终态不可覆盖，变更source不能重开为新账本',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'na-orchestration-contract-'));await chmod(directory,0o700);
  const binding={problem_id:'synthetic-immutable-contract',plan_sha256:'a'.repeat(64),source_sha256:'b'.repeat(64)};
  try{
    let journal=await RunJournal.open({directory,binding});
    journal.start({run_id:'failed-run'});journal.finish('failed-run',{run_id:'failed-run',terminal_status:'failed'});
    assert.throws(()=>journal.finish('failed-run',{run_id:'failed-run',terminal_status:'succeeded'}),/run_terminal_immutable/);
    await journal.close();
    await assert.rejects(RunJournal.open({directory,binding:{...binding,source_sha256:'c'.repeat(64)}}),/run_journal_binding_changed/);
    journal=await RunJournal.open({directory,binding});assert.equal(journal.get('failed-run').terminal_status,'failed');await journal.close();
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('只有物理journal而无业务终态也回收为unknown，不能换attempt重放同run',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'na-orchestration-contract-'));await chmod(directory,0o700);
  const binding={problem_id:'synthetic-orphan-contract',plan_sha256:'a'.repeat(64),source_sha256:'b'.repeat(64)};
  try{
    const journal=await RunJournal.open({directory,binding});
    journal.recoverOrphan({run_id:'orphan-run'},[{attempt_id:'prior-attempt',state:'responded'}]);
    assert.equal(journal.get('orphan-run').terminal_status,'unknown');assert.deepEqual(journal.get('orphan-run').broker_attempt_ids,['prior-attempt']);
    assert.throws(()=>journal.start({run_id:'orphan-run'}),/run_already_recorded/);await journal.close();
  }finally{await rm(directory,{recursive:true,force:true});}
});
