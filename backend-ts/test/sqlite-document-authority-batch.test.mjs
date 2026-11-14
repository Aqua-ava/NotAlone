import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {deletionFixture} from './fixtures/memory-documents/deletion-support.mjs';
import {memoryDocumentsStageActions} from '../src/memory/sqlite/documents/stages.ts';
import * as basis from '../src/memory/sqlite/documents/basis.ts';
import {assertSourceEligibility} from '../src/history/sqlite/source.ts';

async function prepared(t){
 const f=await deletionFixture(t,{twoContacts:true,laterScheduling:true});
 const run=await f.extraction.start('document-source-authority-batch');await f.extraction.waitForIdle(run.runId);
 const task=(await f.extraction.read(run.runId)).tasks.find(value=>value.contactId===f.contactId);
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});t.after(()=>db.close());
 let authority=0,revisions=0;const revisionMessages=new Set();
 const query=(sql,values=[],one=false)=>{
  if(sql.includes('history_scope_request')&&sql.includes('wanted AS ('))authority++;
  if(sql.includes('FROM message WHERE owner_id=')&&sql.includes("availability='available'")){revisions++;revisionMessages.add(String(values?.[2]));}
  const statement=db.prepare(sql);statement.setReadBigInts(true);return one?statement.get(...values):statement.all(...values);
 };
 const stop={},tx={all:(sql,values)=>query(sql,values),get:(sql,values)=>query(sql,values,true),run(){throw stop;}};
 const refs=query("SELECT DISTINCT source_contact_id AS contact_id,message_id,record_id FROM run_input WHERE owner_id=? AND run_id=? AND source_contact_id=?",[f.owner,run.runId,f.contactId]).map(ref=>({owner_id:f.owner,...ref}));
 return {...f,taskId:task.taskId,tx,refs,stop,get authority(){return authority;},get revisions(){return revisions;},revisionMessages,snapshot:work=>{db.exec('BEGIN');authority=0;revisions=0;try{return work();}finally{db.exec('ROLLBACK');}}};
}

test('文档领取同动作批验精确任务来源，authority只解析一次且每条消息修订仍复验',async t=>{
 const f=await prepared(t),claim=memoryDocumentsStageActions.find(action=>action.name==='memoryDocuments.claimScene');
 assert.equal(f.refs.length,2);
 f.snapshot(()=>assert.throws(()=>claim.execute(f.tx,{ownerId:f.owner,taskId:f.taskId},f.storage.status),error=>error===f.stop));
 assert.equal(f.authority,1,'同任务两个来源应走一次官方批量authority');
 assert.ok(f.refs.every(ref=>f.revisionMessages.has(ref.message_id)),'批验不替代每一条冻结消息的修订与可用性检查');
});

test('批验跨联系人的任一组失败不种部分缓存，异常退出与其他策略均重新核验',async t=>{
 const f=await prepared(t),good=f.refs[0],bad={...good,contact_id:f.otherContactId};
 const prime=basis.primeDocumentSourceQualifications;
 f.snapshot(()=>basis.withDocumentSourceQualifications(f.tx,()=>{
  assert.throws(()=>prime(f.tx,[good,bad]),{code:'history_source_not_available'});
  basis.documentSourceEligibility(f.tx,good);
 }));
 assert.equal(f.authority,3,'失败批次不缓存第一组已成功的来源');
 f.snapshot(()=>{
  assert.throws(()=>basis.withDocumentSourceQualifications(f.tx,()=>{prime(f.tx,[good]);throw new Error('synthetic_rollback');}),/synthetic_rollback/);
  basis.documentSourceEligibility(f.tx,good);
 });
 assert.equal(f.authority,2,'异常清理后不沿用前一动作的缓存');
 f.snapshot(()=>basis.withDocumentSourceQualifications(f.tx,()=>{prime(f.tx,[good]);basis.documentSourceEligibility(f.tx,good);assertSourceEligibility(f.tx,good);}));
 assert.equal(f.authority,2,'doc策略缓存不能代替其他来源策略');
 const binding=f.saved.find(value=>value.contact_id===f.contactId);await f.contacts.revoke(binding.contact_id,binding.binding_id,binding.selection_generation);
 const claim=memoryDocumentsStageActions.find(action=>action.name==='memoryDocuments.claimScene');
 f.snapshot(()=>assert.throws(()=>claim.execute(f.tx,{ownerId:f.owner,taskId:f.taskId},f.storage.status),{code:'memory_extraction_scope_stale'}));
});
