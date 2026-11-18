import {randomUUID} from 'node:crypto';
import {paginationUpgradeActions} from './pagination-upgrade-registry.mjs';
import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {pageScope} from '../../../src/memory/sqlite/management/pagination.ts';
const parameters=new URL(import.meta.url).searchParams,legacy=parameters.has('legacy'),failing=parameters.has('failing');
const migrations=legacy?base.migrations.filter(m=>m.version<=49):failing?[...base.migrations,{version:base.migrations.at(-1).version+1,sql:'INSERT INTO deliberately_missing_table VALUES(1);'}]:base.migrations;
const decide=base.actions.find(action=>action.name==='memory.applyDecision');
const read=base.actions.find(action=>action.name==='memory.read'),prepare=base.actions.find(action=>action.name==='memory.prepareTimeline');
const revision=(tx,self=false)=>tx.get(self?"SELECT management_revision n FROM owner WHERE owner_id='owner-a'":"SELECT management_revision n FROM contact WHERE owner_id='owner-a' AND id='contact-a'").n;
const state=tx=>({owner:revision(tx,true),contact:revision(tx),memories:tx.all("SELECT id,management_timeline_dirty dirty FROM memory WHERE owner_id='owner-a' ORDER BY id")});
export const registry={...base,migrations,actions:[...base.actions,...paginationUpgradeActions,
 {name:'fixture.batchSeed',mode:'write',retryBusy:false,execute(tx){
  tx.run("INSERT INTO owner(owner_id,created_at) VALUES('owner-a',0)");
  tx.run("INSERT INTO contact(owner_id,id,display_name) VALUES('owner-a','contact-a','合成对象甲')");
  tx.run("INSERT INTO contact(owner_id,id,display_name) VALUES('owner-a','contact-b','合成对象乙')");
 }},
 {name:'fixture.batchManual',mode:'write',retryBusy:false,execute(tx,{count=1,self=false},lease){
  const before=revision(tx,self),at=performance.now(),ids=[];
  for(let n=0;n<count;n++)ids.push(decide.execute(tx,{ownerId:'owner-a',request:{requestKey:`manual-${self}-${n}`,action:'manual',scope:{scopeKind:self?'self':'contact',contactId:self?null:'contact-a'},body:`合成事项${n}`}},lease).memoryId);
  tx.flushDerived?.();return {ids,revisionDelta:revision(tx,self)-before,ms:performance.now()-at};
 }},
 {name:'fixture.batchCreateAndRead',mode:'write',retryBusy:false,execute(tx,{count=21},lease){
  const scope={scopeKind:'contact',contactId:'contact-a'};
  for(let n=0;n<count;n++)decide.execute(tx,{ownerId:'owner-a',request:{requestKey:`page-${n}`,action:'manual',scope,body:`分页合成事项${n}`}},lease);
  while(!prepare.execute(tx,{ownerId:'owner-a',scope},lease).ready){}
  return read.execute(tx,{ownerId:'owner-a',scope},lease);
 }},
 {name:'fixture.batchSavepoint',mode:'write',retryBusy:false,execute(tx,{memoryId,fail=false,flushInSavepoint=false}){
  const before=revision(tx);tx.run('SAVEPOINT draft');
  for(let n=0;n<7;n++)tx.run("UPDATE memory SET state=state WHERE owner_id='owner-a' AND id=?",[memoryId]);
  if(flushInSavepoint)tx.flushDerived?.();
  tx.run('ROLLBACK TO draft');tx.run('RELEASE draft');
  tx.run("UPDATE memory SET state=state WHERE owner_id='owner-a' AND id=?",[memoryId]);tx.flushDerived?.();
  if(fail)throw Error('fixture_batch_rollback');return {revisionDelta:revision(tx)-before};
 }},
 {name:'fixture.batchExerciseChildren',mode:'write',retryBusy:false,execute(tx,{ownerId,contactId,memoryId,count=9,measure=false}){
  let previous=performance.now();
  const trace=[],observe=label=>{tx.flushDerived?.();const now=performance.now();trace.push({label,...(measure?{ms:now-previous}:{}),owner:tx.get('SELECT management_revision n FROM owner WHERE owner_id=?',[ownerId]).n,contact:tx.get('SELECT management_revision n FROM contact WHERE owner_id=? AND id=?',[ownerId,contactId]).n,dirty:tx.get('SELECT management_timeline_dirty n FROM memory WHERE owner_id=? AND id=?',[ownerId,memoryId])?.n??null});previous=now;};
  const source=tx.get('SELECT * FROM memory_citation WHERE owner_id=? AND memory_id=? AND version_no=2 LIMIT 1',[ownerId,memoryId]);
  if(!source)throw Error('missing_synthetic_citation');
  const extra=randomUUID();
  for(let n=0;n<count;n++)tx.run(`INSERT INTO memory_citation(owner_id,id,candidate_id,memory_id,version_no,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end,explanation)
   VALUES(?,?,NULL,?,2,?,?,?,?,0,1,NULL)`,[ownerId,n===0?extra:randomUUID(),memoryId,source.source_contact_id,source.message_id,source.record_id,source.accepted_revision]);
  observe('citation-insert');
  tx.run('UPDATE memory_citation SET version_no=1 WHERE owner_id=? AND id=?',[ownerId,extra]);observe('citation-out');
  tx.run('UPDATE memory_citation SET version_no=2 WHERE owner_id=? AND id=?',[ownerId,extra]);
  tx.run("UPDATE memory_citation SET explanation='合成核验' WHERE owner_id=? AND id=?",[ownerId,extra]);
  tx.run('DELETE FROM memory_citation WHERE owner_id=? AND id=?',[ownerId,extra]);observe('citation-in-update-delete');
  tx.run('UPDATE message SET sent_at=sent_at+1000 WHERE owner_id=? AND contact_id=? AND id=?',[ownerId,source.source_contact_id,source.message_id]);observe('message-time');
  tx.run("UPDATE memory_version SET body=NULL,content_state='redacted',provenance_state='invalidated' WHERE owner_id=? AND memory_id=? AND version_no=2",[ownerId,memoryId]);
  tx.run("UPDATE memory_decision SET execution_id=NULL,request_seal=NULL,outcome='redacted' WHERE owner_id=? AND target_memory_id=?",[ownerId,memoryId]);observe('version-decision-update');
  tx.run('DELETE FROM memory_citation WHERE owner_id=? AND memory_id=?',[ownerId,memoryId]);
  tx.run('DELETE FROM memory_required_message WHERE owner_id=? AND memory_id=?',[ownerId,memoryId]);
  tx.run('DELETE FROM memory_version WHERE owner_id=? AND memory_id=?',[ownerId,memoryId]);
  tx.run('DELETE FROM memory_decision WHERE owner_id=? AND target_memory_id=?',[ownerId,memoryId]);
  tx.run('DELETE FROM memory WHERE owner_id=? AND id=?',[ownerId,memoryId]);observe('memory-version-decision-delete');
  tx.run("INSERT INTO memory_candidate(owner_id,id,scope_kind,contact_id,proposed_body,produced_attempt_id,event_id,output_no,state) VALUES(?,?,'contact',?,NULL,NULL,NULL,0,'deleted')",[ownerId,extra,contactId]);
  tx.run('UPDATE memory_candidate SET state_revision=state_revision+1 WHERE owner_id=? AND id=?',[ownerId,extra]);
  tx.run('DELETE FROM memory_candidate WHERE owner_id=? AND id=?',[ownerId,extra]);observe('candidate-insert-update-delete');return trace;
 }},
 {name:'fixture.batchCaughtFlushFailure',mode:'write',retryBusy:false,execute(tx){
  const before=revision(tx,true);
  for(const self of [true,false])tx.run("INSERT INTO memory_candidate(owner_id,id,scope_kind,contact_id,proposed_body,produced_attempt_id,event_id,output_no,state) VALUES(?,?,?,?,NULL,NULL,NULL,0,'deleted')",['owner-a',`flush-failure-${self}`,self?'self':'contact',self?null:'contact-a']);
  tx.run("CREATE TEMP TRIGGER fixture_contact_flush_failure BEFORE UPDATE OF management_revision ON main.contact BEGIN SELECT RAISE(ABORT,'fixture_forced_flush_failure'); END");
  try{tx.flushDerived();}catch{}
  if(revision(tx,true)!==before+1n)throw Error('fixture_owner_was_not_partially_updated');
  tx.run('DROP TRIGGER fixture_contact_flush_failure');return true;
 }},
 {name:'fixture.batchParentDelete',mode:'write',retryBusy:false,execute(tx){
  for(const self of [true,false])tx.run("INSERT INTO memory_candidate(owner_id,id,scope_kind,contact_id,proposed_body,produced_attempt_id,event_id,output_no,state) VALUES(?,?,?,?,NULL,NULL,NULL,0,'deleted')",['owner-a',`parent-delete-${self}`,self?'self':'contact',self?null:'contact-a']);
  tx.run("DELETE FROM memory_candidate WHERE owner_id='owner-a'");
  tx.run("DELETE FROM contact WHERE owner_id='owner-a'");tx.run("DELETE FROM owner WHERE owner_id='owner-a'");
  tx.run("INSERT INTO owner(owner_id,created_at) VALUES('owner-a',0)");
  tx.run("INSERT INTO contact(owner_id,id,display_name) VALUES('owner-a','contact-a','合成重建对象')");
  tx.flushDerived?.();return {owner:revision(tx,true),contact:revision(tx)};
 }},
 {name:'fixture.batchSchema'   ,mode:'read',retryBusy:false,execute(tx){return {ledger:tx.all('SELECT version,checksum FROM schema_migration ORDER BY version'),triggers:tx.all("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name"),temporary:tx.all("SELECT name FROM temp.sqlite_schema WHERE type='trigger' ORDER BY name")};}},
 {name:'fixture.batchState'  ,mode:'read',retryBusy:false,execute:state},
 {name:'fixture.batchAudit',mode:'write',retryBusy:false,execute(tx){
  tx.run('CREATE TEMP TABLE fixture_main_writes(kind TEXT PRIMARY KEY,n INTEGER NOT NULL)');
  for(const table of ['owner','contact','memory']){
   tx.run(`INSERT INTO fixture_main_writes VALUES('${table}',0)`);
   tx.run(`CREATE TEMP TRIGGER fixture_${table}_write AFTER UPDATE ON main.${table} BEGIN UPDATE fixture_main_writes SET n=n+1 WHERE kind='${table}'; END`);
  }
 }},
 {name:'fixture.batchTouch',mode:'write',retryBusy:false,execute(tx,{memoryId,count=10,self=false,dirty=0,fail=false,readPage=false}){
  tx.run('UPDATE memory SET management_timeline_dirty=? WHERE owner_id=? AND id=?',[dirty,'owner-a',memoryId]);tx.flushDerived?.();
  const before=revision(tx,self),total=tx.get('SELECT total_changes() n').n,at=performance.now();
  for(let n=0;n<count;n++)tx.run("UPDATE memory SET state=state WHERE owner_id='owner-a' AND id=?",[memoryId]);
  const page=readPage?pageScope(tx,'owner-a',{scopeKind:self?'self':'contact',contactId:self?null:'contact-a'}):null;
  tx.flushDerived?.();
  const result={revisionDelta:revision(tx,self)-before,writeDelta:tx.get('SELECT total_changes() n').n-total,dirty:tx.get("SELECT management_timeline_dirty n FROM memory WHERE owner_id='owner-a' AND id=?",[memoryId]).n,ms:performance.now()-at,page,audit:tx.get("SELECT 1 FROM temp.sqlite_schema WHERE name='fixture_main_writes'")?tx.all('SELECT * FROM fixture_main_writes ORDER BY kind'):null};
  if(fail)throw Error('fixture_batch_rollback');return result;
 }},
 {name:'fixture.batchCandidates',mode:'write',retryBusy:false,execute(tx,{count=1000,self=false,fail=false}){
  const before=revision(tx,self),at=performance.now();
  for(let n=0;n<count;n++)tx.run("INSERT INTO memory_candidate(owner_id,id,scope_kind,contact_id,proposed_body,produced_attempt_id,event_id,output_no,state) VALUES(?,?,?,?,NULL,NULL,NULL,?,'deleted')",['owner-a',`deleted-${self}-${n}`,self?'self':'contact',self?null:'contact-a',n]);
  tx.flushDerived?.();if(fail)throw Error('fixture_batch_rollback');return {revisionDelta:revision(tx,self)-before,ms:performance.now()-at};
 }},
]};
