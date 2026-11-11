import {observedProcessingAction,recordProcessingRunChange} from '../diagnostics.ts';
import {randomUUID} from 'node:crypto';
import {sha256} from '../../../platform/sha256.ts';
import {runTargetsReleased} from '../run-retirement.ts';
import type {StorageAction,StorageMigration,StorageTransaction,StorageRow,StorageLease} from '../../../storage/sqlite/contracts.ts';
import type {MemoryScope} from '../management/contracts.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import {available} from '../management/qualification.ts';
import {assertContribution,assertInputs} from '../qualification.ts';
import {memoryBasis,documentSources} from './basis.ts';
import type {ReplySource} from '../../../reply/sqlite/candidates/contracts.ts';

const sceneWindowMs=60*60*1000,profileWindowMs=24*60*60*1000;
const schema=`CREATE TABLE memory_document_later_schedule (
 owner_id TEXT NOT NULL,scope_kind TEXT NOT NULL CHECK(scope_kind IN (\'self\',\'contact\')),scope_key TEXT NOT NULL,contact_id TEXT,
 generation INTEGER NOT NULL CHECK(generation>0),stage TEXT NOT NULL CHECK(stage IN (\'document_scene\',\'document_profile\')),
 state TEXT NOT NULL CHECK(state IN (\'scheduled\',\'running\',\'succeeded\',\'failed\',\'unknown\',\'superseded\')),
 first_changed_at INTEGER NOT NULL CHECK(first_changed_at>=0),last_changed_at INTEGER NOT NULL CHECK(last_changed_at>=0),due_at INTEGER NOT NULL CHECK(due_at>=0),
 requested_memory_revision INTEGER NOT NULL CHECK(requested_memory_revision>=0),frozen_memory_revision INTEGER,frozen_document_revision INTEGER,frozen_publication_id TEXT,
 task_id TEXT,error_code TEXT,scene_body_digest TEXT,
 PRIMARY KEY(owner_id,scope_key,generation),FOREIGN KEY(owner_id) REFERENCES owner(owner_id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,task_id) REFERENCES processing_task(owner_id,id) ON DELETE CASCADE,
 CHECK((scope_kind=\'self\' AND contact_id IS NULL AND scope_key=\'self\') OR (scope_kind=\'contact\' AND contact_id IS NOT NULL AND scope_key=contact_id)),
 CHECK((state=\'running\' AND task_id IS NOT NULL) OR state<>\'running\'),
 CHECK((frozen_memory_revision IS NULL AND frozen_document_revision IS NULL AND frozen_publication_id IS NULL) OR frozen_memory_revision IS NOT NULL AND frozen_document_revision IS NOT NULL)
) STRICT;
CREATE INDEX memory_document_later_due ON memory_document_later_schedule(owner_id,state,due_at);
CREATE TABLE memory_document_later_cursor (
 owner_id TEXT NOT NULL,scope_kind TEXT NOT NULL CHECK(scope_kind IN (\'self\',\'contact\')),scope_key TEXT NOT NULL,contact_id TEXT,
 scene_body_digest TEXT,profile_scene_body_digest TEXT,last_profile_success_at INTEGER,
 PRIMARY KEY(owner_id,scope_key),FOREIGN KEY(owner_id) REFERENCES owner(owner_id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id) ON DELETE CASCADE,
 CHECK((scope_kind=\'self\' AND contact_id IS NULL AND scope_key=\'self\') OR (scope_kind=\'contact\' AND contact_id IS NOT NULL AND scope_key=contact_id))
) STRICT;
CREATE TABLE memory_document_later_run_requirement (
 owner_id TEXT NOT NULL,run_id TEXT NOT NULL,scope_kind TEXT NOT NULL CHECK(scope_kind IN (\'self\',\'contact\')),scope_key TEXT NOT NULL,contact_id TEXT,
 generation INTEGER,outcome TEXT NOT NULL CHECK(outcome IN (\'pending\',\'completed\',\'failed\',\'unknown\',\'revoked\',\'no_formal_change\')),
 paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),reason TEXT,updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,run_id,scope_key),FOREIGN KEY(owner_id,run_id) REFERENCES processing_run(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,scope_key,generation) REFERENCES memory_document_later_schedule(owner_id,scope_key,generation) ON DELETE CASCADE,
 CHECK((scope_kind=\'self\' AND contact_id IS NULL AND scope_key=\'self\') OR (scope_kind=\'contact\' AND contact_id IS NOT NULL AND scope_key=contact_id)),
 CHECK((outcome=\'no_formal_change\' AND generation IS NULL) OR (outcome<>\'no_formal_change\' AND generation IS NOT NULL))
) STRICT;
ALTER TABLE processing_run ADD COLUMN followup_state TEXT NOT NULL DEFAULT \'none\' CHECK(followup_state IN (\'none\',\'pending\',\'enrolled\'));`;

export const laterScheduleMigration=(version:number):StorageMigration=>({version,sql:schema});
export interface LaterScheduleSnapshot {scene:Record<string,unknown>|null;profile:Record<string,unknown>|null}
export interface LaterStagesProjection {state:'completed'|'pending'|'scheduled'|'running'|'unknown'|'failed'|'revoked';reasons:string[];nextDueAt:number|null;stage:'document_scene'|'document_profile'|null}
const action=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,input:any)=>unknown):StorageAction=>observedProcessingAction({name:`memoryDocuments.${name}`,mode,retryBusy:false,execute});
const scopeParts=(scope:MemoryScope)=>({scopeKind:scope.scopeKind,contactId:scope.contactId,scopeKey:scope.scopeKind==='self'?'self':scope.contactId!});
const exists=(tx:StorageTransaction)=>!!tx.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_document_later_schedule'");
const safeTime=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:(()=>{throw new StorageFailure('document_schedule_time_invalid')})();
const scopeRow=(tx:StorageTransaction,ownerId:string,scope:MemoryScope)=>scope.scopeKind==='self'
 ?tx.get("SELECT memory_revision,document_revision,current_publication_id FROM owner WHERE owner_id=? AND state='active'",[ownerId])
 :tx.get("SELECT memory_revision,document_revision,current_publication_id FROM contact WHERE owner_id=? AND id=? AND state='active'",[ownerId,scope.contactId]);
function requirement(tx:StorageTransaction,ownerId:string,runId:string,scope:MemoryScope,generation:number|null,outcome:'pending'|'completed'|'failed'|'unknown'|'revoked'|'no_formal_change',reason:string|null,now:number):void {
 const p=scopeParts(scope);
 tx.run(`INSERT INTO memory_document_later_run_requirement(owner_id,run_id,scope_kind,scope_key,contact_id,generation,outcome,paused,reason,updated_at)
 VALUES(?,?,?,?,?,?,?,0,?,?) ON CONFLICT(owner_id,run_id,scope_key) DO UPDATE SET generation=excluded.generation,outcome=excluded.outcome,reason=excluded.reason,updated_at=excluded.updated_at`,
 [ownerId,runId,p.scopeKind,p.scopeKey,p.contactId,generation,outcome,reason,now]);
}
function scheduleRow(tx:StorageTransaction,ownerId:string,scope:MemoryScope,stage:string='document_scene'){
 const p=scopeParts(scope);return tx.get('SELECT * FROM memory_document_later_schedule WHERE owner_id=? AND scope_key=? AND stage=? ORDER BY generation DESC LIMIT 1',[ownerId,p.scopeKey,stage]);
}
function snapshot(tx:StorageTransaction,ownerId:string,scope:MemoryScope):LaterScheduleSnapshot {
 if(!exists(tx))return {scene:null,profile:null};
 const convert=(row:any)=>row?{state:String(row.state),stage:String(row.stage),generation:Number(row.generation),firstChangedAt:Number(row.first_changed_at),lastChangedAt:Number(row.last_changed_at),dueAt:Number(row.due_at),memoryRevision:String(row.requested_memory_revision),frozenMemoryRevision:row.frozen_memory_revision===null?null:String(row.frozen_memory_revision),taskId:row.task_id===null?null:String(row.task_id),errorCode:row.error_code===null?null:String(row.error_code)}:null;
 const cursor=tx.get('SELECT last_profile_success_at FROM memory_document_later_cursor WHERE owner_id=? AND scope_key=?',[ownerId,scopeParts(scope).scopeKey]);
 const profile:any=convert(scheduleRow(tx,ownerId,scope,'document_profile'));
 if(profile)profile.lastSuccessAt=cursor?.last_profile_success_at===null||cursor?.last_profile_success_at===undefined?null:Number(cursor.last_profile_success_at);
 return {scene:convert(scheduleRow(tx,ownerId,scope,'document_scene')),profile};
}
function transferRequirements(tx:StorageTransaction,ownerId:string,scope:MemoryScope,fromGeneration:number,toGeneration:number,now:number):void {
 const p=scopeParts(scope);
 for(const row of tx.all("SELECT run_id,paused FROM memory_document_later_run_requirement WHERE owner_id=? AND scope_key=? AND generation=? AND outcome='pending'",[ownerId,p.scopeKey,fromGeneration])){
  requirement(tx,ownerId,String(row.run_id),scope,toGeneration,'pending',null,now);
  tx.run('UPDATE memory_document_later_run_requirement SET paused=?,updated_at=? WHERE owner_id=? AND run_id=? AND scope_key=?',[row.paused,now,ownerId,row.run_id,p.scopeKey]);
 }
}
function maybeCompleteL1Run(tx:StorageTransaction,ownerId:string,runId:string):void {
 const run=tx.get('SELECT state,pause_requested_at FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId]);
 if(!run||run.pause_requested_at!==null||!['running','incomplete'].includes(String(run.state)))return;
 const tasks=tx.all('SELECT state,scope_kind FROM processing_task WHERE owner_id=? AND run_id=?',[ownerId,runId]);
 // 本人任务在没有待审候选时可稳定停留于 awaiting_decision；控制投影也将其视为L1已结束。
 if(!tasks.length||tasks.some(task=>task.state!=='succeeded'&&!(task.scope_kind==='self'&&task.state==='awaiting_decision')))return;
 if(tx.get("SELECT 1 FROM memory_candidate c JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.produced_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND s.task_id=t.id WHERE t.owner_id=? AND t.run_id=? AND c.state='pending' LIMIT 1",[ownerId,runId]))return;
 if(tx.get("SELECT 1 FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id LEFT JOIN step_attempt a ON a.owner_id=s.owner_id AND a.step_id=s.id LEFT JOIN model_call c ON c.owner_id=a.owner_id AND c.step_attempt_id=a.id WHERE t.owner_id=? AND t.run_id=? AND (s.state='unknown' OR a.state='unknown' OR c.state='unknown') LIMIT 1",[ownerId,runId]))return;
 if(tx.get("SELECT 1 FROM memory_document_later_run_requirement WHERE owner_id=? AND run_id=? AND outcome NOT IN ('completed','no_formal_change') LIMIT 1",[ownerId,runId]))return;
 tx.run("UPDATE processing_run SET state='completed' WHERE owner_id=? AND id=? AND state IN ('running','incomplete') AND pause_requested_at IS NULL",[ownerId,runId]);
 recordProcessingRunChange(tx,runId,String(run.state),'completed','completed');
}

/** 在正式记忆 revision 已递增的同一事务内登记；同一待执行 L2 窗口只保留首个 due anchor。 */
export function scheduleMemoryChange(tx:StorageTransaction,ownerId:string,scope:MemoryScope,changedAt=Date.now(),runId?:string):LaterScheduleSnapshot|null {
 if(!exists(tx))return null;
 const now=safeTime(changedAt),parts=scopeParts(scope),base=scopeRow(tx,ownerId,scope);
 if(!base)throw new StorageFailure('document_scope_stale');
 const memoryRevision=base.memory_revision as bigint;
 const active=scheduleRow(tx,ownerId,scope,'document_scene');
 if(active&&active.state==='scheduled'){
  // 更晚的正式版本加入同一个首变窗口，不重置首变时间或到期时间。
  tx.run('UPDATE memory_document_later_schedule SET requested_memory_revision=?,last_changed_at=? WHERE owner_id=? AND scope_key=? AND generation=?',[memoryRevision,now,ownerId,parts.scopeKey,active.generation]);
  if(runId)requirement(tx,ownerId,runId,scope,Number(active.generation),'pending',null,now);
  return snapshot(tx,ownerId,scope);
 }
 if(active&&active.requested_memory_revision===memoryRevision&&['running','succeeded'].includes(String(active.state))){
  if(runId)requirement(tx,ownerId,runId,scope,Number(active.generation),active.state==='succeeded'?'completed':'pending',null,now);
  return snapshot(tx,ownerId,scope);
 }
 const profile=scheduleRow(tx,ownerId,scope,'document_profile');
 const generation=Number((tx.get('SELECT coalesce(max(generation),0)+1 AS n FROM memory_document_later_schedule WHERE owner_id=? AND scope_key=?',[ownerId,parts.scopeKey])!.n as bigint));
 if(profile?.state==='scheduled')tx.run("UPDATE memory_document_later_schedule SET state='superseded' WHERE owner_id=? AND scope_key=? AND generation=? AND state='scheduled'",[ownerId,parts.scopeKey,profile.generation]);
 tx.run(`INSERT INTO memory_document_later_schedule(owner_id,scope_kind,scope_key,contact_id,generation,stage,state,first_changed_at,last_changed_at,due_at,requested_memory_revision)
 VALUES(?,?,?,?,?,'document_scene','scheduled',?,?,?,?)`,[ownerId,parts.scopeKind,parts.scopeKey,parts.contactId,generation,now,now,now+sceneWindowMs,memoryRevision]);
 if(profile?.state==='scheduled')transferRequirements(tx,ownerId,scope,Number(profile.generation),generation,now);
 if(runId)requirement(tx,ownerId,runId,scope,generation,'pending',null,now);
 return snapshot(tx,ownerId,scope);
}

/** 即时 L1 轮登记：仅绑定本轮同一 scope 的 dirty generation，其他 scope 落为持久 no-op。 */
export function enrollRun(tx:StorageTransaction,ownerId:string,runId:string,now=Date.now()):boolean {
 if(!exists(tx))return false;
 if(!tx.get('SELECT 1 FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId]))return false;
 const changed=safeTime(now);
 for(const t of tx.all('SELECT scope_kind,contact_id FROM processing_task WHERE owner_id=? AND run_id=? ORDER BY scope_kind,contact_id',[ownerId,runId])){
  const scope={scopeKind:String(t.scope_kind) as MemoryScope['scopeKind'],contactId:t.contact_id===null?null:String(t.contact_id)} as MemoryScope;
  if(tx.get('SELECT 1 FROM memory_document_later_run_requirement WHERE owner_id=? AND run_id=? AND scope_key=?',[ownerId,runId,scopeParts(scope).scopeKey]))continue;
  requirement(tx,ownerId,runId,scope,null,'no_formal_change','no_formal_memory_change',changed);
 }
 tx.run("UPDATE processing_run SET followup_state='enrolled' WHERE owner_id=? AND id=? AND followup_state='pending'",[ownerId,runId]);
 maybeCompleteL1Run(tx,ownerId,runId);
 return true;
}

/** pause只作用于该 run 已登记的未完成后续窗口，返回是否确有可暂停工作。 */
export function setRunSchedulePaused(tx:StorageTransaction,ownerId:string,runId:string,paused:boolean,now=Date.now()):boolean {
 if(!exists(tx))return false;
 const p=safeTime(now),rows=tx.all(`SELECT s.scope_key,s.generation,s.state,s.task_id,s.stage FROM memory_document_later_run_requirement q JOIN memory_document_later_schedule s ON s.owner_id=q.owner_id AND s.scope_key=q.scope_key AND s.generation=q.generation
  WHERE q.owner_id=? AND q.run_id=? AND q.outcome='pending' AND s.state IN ('scheduled','running')`,[ownerId,runId]);
 const row=rows[0];
 if(!row)return false;
 tx.run("UPDATE memory_document_later_run_requirement SET paused=?,updated_at=? WHERE owner_id=? AND run_id=? AND outcome='pending'",[paused?1:0,p,ownerId,runId]);
 if(!paused)for(const item of rows){
  if(item.state!=='running'||item.task_id===null)continue;
  const step=tx.get("SELECT 1 FROM processing_step WHERE owner_id=? AND task_id=? AND kind=? LIMIT 1",[ownerId,item.task_id,item.stage]);
  if(step)continue;
  // 窗口已领取但还没有创建模型步骤，继续时可安全归还队列并重新领取。
  tx.run("UPDATE memory_document_later_schedule SET state='scheduled',task_id=NULL,frozen_memory_revision=NULL,frozen_document_revision=NULL,frozen_publication_id=NULL,due_at=min(due_at,?) WHERE owner_id=? AND scope_key=? AND generation=? AND state='running'",[p,ownerId,item.scope_key,item.generation]);
  tx.run("UPDATE processing_run SET state='incomplete' WHERE owner_id=? AND id=(SELECT run_id FROM processing_task WHERE owner_id=? AND id=?) AND state='running'",[ownerId,ownerId,item.task_id]);
 }
 return true;
}

/** 仅当未知阶段的每次实际调用都收到可验证的结算回执时，继续操作才可将其降为已知失败。 */
function reconcileSettledUnknownStage(tx:StorageTransaction,ownerId:string,row:StorageRow,now:number):boolean {
 if(row.task_id===null)return false;
 const step=tx.get("SELECT id,state FROM processing_step WHERE owner_id=? AND task_id=? AND kind=?",[ownerId,row.task_id,row.stage]);
 if(!step||step.state!=='unknown')return false;
 const attempts=tx.all('SELECT id,state FROM step_attempt WHERE owner_id=? AND step_id=? ORDER BY attempt_no',[ownerId,step.id]);
 if(!attempts.length)return false;
 let unknownAttempts=0;
 for(const attempt of attempts){
  if(!['succeeded','failed','unknown'].includes(String(attempt.state)))return false;
  const calls=tx.all(`SELECT c.state,c.settlement_state,c.receipt,o.state AS operation_state FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE c.owner_id=? AND c.step_attempt_id=? ORDER BY c.attempt_no`,[ownerId,attempt.id]);
  if(attempt.state==='unknown'){
   if(!calls.length)return false;
   unknownAttempts++;
  }
  if(calls.some(call=>!['succeeded','failed'].includes(String(call.state))||call.settlement_state!=='settled'||call.receipt===null||!['resolved','failed'].includes(String(call.operation_state))))return false;
 }
 if(!unknownAttempts)return false;
 for(const attempt of attempts)if(attempt.state==='unknown')tx.run("UPDATE step_attempt SET state='failed',finished_at=coalesce(finished_at,?),error_code='document_late_receipt_resolved' WHERE owner_id=? AND id=? AND state='unknown'",[now,ownerId,attempt.id]);
 tx.run("UPDATE processing_step SET state='failed' WHERE owner_id=? AND id=? AND state='unknown'",[ownerId,step.id]);
 return true;
}

/** 仅用户明确继续时重排回执已知的失败；未结算的unknown不会自动重发，旧记录保留供审计。 */
export function resumeRunSchedule(tx:StorageTransaction,ownerId:string,runId:string,now=Date.now()):boolean {
 if(!exists(tx))return false;
 const instant=safeTime(now),unknown=tx.all(`SELECT s.* FROM memory_document_later_run_requirement q JOIN memory_document_later_schedule s
   ON s.owner_id=q.owner_id AND s.scope_key=q.scope_key AND s.generation=q.generation
   WHERE q.owner_id=? AND q.run_id=? AND q.outcome='unknown' AND s.state='unknown' ORDER BY s.scope_key,s.generation`,[ownerId,runId]);
 for(const row of unknown)if(reconcileSettledUnknownStage(tx,ownerId,row,instant)){
  tx.run("UPDATE memory_document_later_schedule SET state='failed',error_code='document_late_receipt_resolved' WHERE owner_id=? AND scope_key=? AND generation=? AND state='unknown'",[ownerId,row.scope_key,row.generation]);
  tx.run("UPDATE memory_document_later_run_requirement SET outcome='failed',reason='document_late_receipt_resolved',updated_at=? WHERE owner_id=? AND scope_key=? AND generation=? AND outcome='unknown'",[instant,ownerId,row.scope_key,row.generation]);
 }
 const linked=tx.all(`SELECT s.* FROM memory_document_later_run_requirement q JOIN memory_document_later_schedule s
   ON s.owner_id=q.owner_id AND s.scope_key=q.scope_key AND s.generation=q.generation
   WHERE q.owner_id=? AND q.run_id=? AND q.outcome='failed' AND s.state='failed' ORDER BY s.scope_key,s.generation`,[ownerId,runId]);
 let resumed=false;
 for(const failed of linked){
  const scope={scopeKind:String(failed.scope_kind) as MemoryScope['scopeKind'],contactId:failed.contact_id===null?null:String(failed.contact_id)} as MemoryScope,parts=scopeParts(scope);
  if(tx.get("SELECT 1 FROM memory_document_later_schedule WHERE owner_id=? AND scope_key=? AND state='unknown' LIMIT 1",[ownerId,parts.scopeKey])||
   tx.get("SELECT 1 FROM memory_document_later_run_requirement WHERE owner_id=? AND scope_key=? AND outcome='unknown' LIMIT 1",[ownerId,parts.scopeKey])||
   tx.get(`SELECT 1 FROM processing_step s LEFT JOIN step_attempt a ON a.owner_id=s.owner_id AND a.step_id=s.id LEFT JOIN model_call c ON c.owner_id=a.owner_id AND c.step_attempt_id=a.id
    JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.scope_kind=? AND t.contact_id IS ?
     AND (s.state='unknown' OR a.state='unknown' OR c.state='unknown') LIMIT 1`,[ownerId,parts.scopeKind,parts.contactId]))continue;
  const base=scopeRow(tx,ownerId,scope);if(!base)continue;
  const pendingScene=scheduleRow(tx,ownerId,scope,'document_scene');
  const stage: 'document_scene'|'document_profile'=failed.stage==='document_profile'&&base.memory_revision===failed.requested_memory_revision&&pendingScene?.state!=='scheduled'
   ?'document_profile':'document_scene';
  const generation=Number((tx.get('SELECT coalesce(max(generation),0)+1 AS n FROM memory_document_later_schedule WHERE owner_id=? AND scope_key=?',[ownerId,parts.scopeKey])!.n as bigint));
  const replaced=tx.all("SELECT generation FROM memory_document_later_schedule WHERE owner_id=? AND scope_key=? AND state IN ('failed','scheduled')",[ownerId,parts.scopeKey]);
  tx.run(`INSERT INTO memory_document_later_schedule(owner_id,scope_kind,scope_key,contact_id,generation,stage,state,first_changed_at,last_changed_at,due_at,requested_memory_revision)
   VALUES(?,?,?,?,?,?, 'scheduled',?,?,?,?)`,[ownerId,parts.scopeKind,parts.scopeKey,parts.contactId,generation,stage,instant,instant,instant,base.memory_revision]);
  for(const old of replaced){
   const oldGeneration=Number(old.generation);
   tx.run("UPDATE memory_document_later_schedule SET state='superseded' WHERE owner_id=? AND scope_key=? AND generation=? AND state IN ('failed','scheduled')",[ownerId,parts.scopeKey,oldGeneration]);
   tx.run("UPDATE memory_document_later_run_requirement SET generation=?,outcome='pending',reason=NULL,updated_at=? WHERE owner_id=? AND scope_key=? AND generation=? AND outcome IN ('pending','failed')",[generation,instant,ownerId,parts.scopeKey,oldGeneration]);
  }
  tx.run("UPDATE memory_document_later_run_requirement SET paused=0,updated_at=? WHERE owner_id=? AND run_id=? AND scope_key=? AND generation=? AND outcome='pending'",[instant,ownerId,runId,parts.scopeKey,generation]);
  resumed=true;
 }
 return resumed;
}

export function laterStagesState(tx:StorageTransaction,ownerId:string,runId:string,contactId?:string):LaterStagesProjection|null {
 if(!exists(tx)||!tx.get('SELECT 1 FROM memory_document_later_run_requirement WHERE owner_id=? AND run_id=?',[ownerId,runId]))return null;
 const rows=tx.all(`SELECT q.scope_key,q.generation,q.outcome,q.paused,q.reason,s.stage,s.state,s.due_at,s.error_code FROM memory_document_later_run_requirement q
  LEFT JOIN memory_document_later_schedule s ON s.owner_id=q.owner_id AND s.scope_key=q.scope_key AND s.generation=q.generation
  WHERE q.owner_id=? AND q.run_id=?${contactId===undefined?'':" AND q.scope_kind='contact' AND q.contact_id=?"} ORDER BY q.scope_key`,contactId===undefined?[ownerId,runId]:[ownerId,runId,contactId]);
 if(!rows.length)return null;
 const linkedScopes=rows.filter(row=>row.outcome==='pending'&&row.generation!==null).map(row=>String(row.scope_key));
 const scopeUnknown=linkedScopes.some(scopeKey=>!!tx.get("SELECT 1 FROM memory_document_later_schedule WHERE owner_id=? AND scope_key=? AND state='unknown' LIMIT 1",[ownerId,scopeKey]));
 if(scopeUnknown||rows.some(row=>row.outcome==='unknown'||row.state==='unknown'))return {state:'unknown',reasons:['document_call_unknown'],nextDueAt:null,stage:null};
 const l1=tx.get('SELECT state FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId]);
 if(!l1)return {state:'pending',reasons:['document_run_missing'],nextDueAt:null,stage:null};
 if(l1.state==='revoked')return {state:'revoked',reasons:['document_run_revoked'],nextDueAt:null,stage:null};
 if(tx.get(`SELECT 1 FROM processing_task t WHERE t.owner_id=? AND t.run_id=? AND
  (t.state='unknown' OR EXISTS(SELECT 1 FROM processing_step s LEFT JOIN step_attempt a ON a.owner_id=s.owner_id AND a.step_id=s.id LEFT JOIN model_call c ON c.owner_id=a.owner_id AND c.step_attempt_id=a.id
   WHERE s.owner_id=t.owner_id AND s.task_id=t.id AND (s.state='unknown' OR a.state='unknown' OR c.state='unknown')))${contactId===undefined?'':" AND t.scope_kind='contact' AND t.contact_id=?"} LIMIT 1`,contactId===undefined?[ownerId,runId]:[ownerId,runId,contactId]))
  return {state:'unknown',reasons:['extraction_call_unknown'],nextDueAt:null,stage:null};
 const l1Tasks=tx.all(`SELECT state,scope_kind,error_code FROM processing_task WHERE owner_id=? AND run_id=?${contactId===undefined?'':" AND scope_kind='contact' AND contact_id=?"}`,contactId===undefined?[ownerId,runId]:[ownerId,runId,contactId]);
 if(contactId===undefined&&l1.state==='failed'||l1Tasks.some(task=>task.state==='failed'))return {state:'failed',reasons:['l1_preceding_stage_failed'],nextDueAt:null,stage:null};
 const scopeFailed=linkedScopes.some(scopeKey=>!!tx.get("SELECT 1 FROM memory_document_later_schedule WHERE owner_id=? AND scope_key=? AND state='failed' LIMIT 1",[ownerId,scopeKey]));
 if(scopeFailed||rows.some(row=>row.outcome==='failed'||row.state==='failed'))return {state:'failed',reasons:['later_stage_failed'],nextDueAt:null,stage:null};
 const pendingCandidate=!!tx.get(`SELECT 1 FROM memory_candidate c JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.produced_attempt_id
  JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
  WHERE t.owner_id=? AND t.run_id=? AND c.state='pending'${contactId===undefined?'':" AND t.scope_kind='contact' AND t.contact_id=?"} LIMIT 1`,contactId===undefined?[ownerId,runId]:[ownerId,runId,contactId]);
 const unfinishedTask=l1Tasks.some(task=>task.state!=='succeeded'&&task.state!=='revoked'&&
  !(task.scope_kind==='self'&&task.state==='awaiting_decision')&&
  !(task.scope_kind==='contact'&&task.state==='incomplete'&&task.error_code==='targets_completed_elsewhere'));
 if(!l1Tasks.length||pendingCandidate||unfinishedTask||contactId===undefined&&!['completed','incomplete','paused'].includes(String(l1.state)))
  return {state:'pending',reasons:['l1_preceding_stage_incomplete'],nextDueAt:null,stage:null};
 const unresolved=rows.filter(row=>row.outcome==='pending');
 const scheduled=unresolved.filter(row=>row.state==='scheduled');
 if(scheduled.length){const next=Math.min(...scheduled.map(row=>Number(row.due_at)));const first=scheduled.find(row=>Number(row.due_at)===next)!;
  return {state:'scheduled',reasons:['later_stages_scheduled'],nextDueAt:next,stage:String(first.stage) as LaterStagesProjection['stage']};}
 const running=unresolved.find(row=>row.state==='running');
 if(running)return {state:'running',reasons:['later_stages_running'],nextDueAt:null,stage:String(running.stage) as LaterStagesProjection['stage']};
 if(unresolved.length)return {state:'pending',reasons:['later_stages_running'],nextDueAt:null,stage:null};
 if(rows.some(row=>row.outcome==='revoked'))return {state:'revoked',reasons:['later_stages_revoked'],nextDueAt:null,stage:null};
 return {state:'completed',reasons:[],nextDueAt:null,stage:null};
}

export function queueSummary(tx:StorageTransaction,ownerId:string,now=Date.now(),contactId?:string):{pending:number;nextDueAt:number|null;stage:'document_scene'|'document_profile'|null} {
 if(!exists(tx))return {pending:0,nextDueAt:null,stage:null};
 const pending=tx.get(`SELECT count(*) AS n FROM memory_document_later_schedule WHERE owner_id=? AND state IN ('scheduled','running','failed','unknown')${contactId===undefined?'':" AND scope_kind='contact' AND contact_id=?"}`,contactId===undefined?[ownerId]:[ownerId,contactId])!;
 const due=dueRows(tx,ownerId,now,true).find(row=>contactId===undefined||row.scope_kind==='contact'&&row.contact_id===contactId);
 return {pending:Number(pending.n),nextDueAt:due?Number(due.due_at):null,stage:due?String(due.stage) as 'document_scene'|'document_profile':null};
}

function scopeBlocked(tx:StorageTransaction,ownerId:string,row:StorageRow,releasedRuns:Map<string,boolean>):boolean {
 const scopeKey=String(row.scope_key);
 if(tx.get("SELECT 1 FROM deletion_operation d WHERE d.owner_identity=? AND d.state<>'completed' LIMIT 1",[ownerId]))return true;
 if(tx.get('SELECT 1 FROM memory_document_later_run_requirement WHERE owner_id=? AND scope_key=? AND generation=? AND paused=1',[ownerId,scopeKey,row.generation]))return true;
 if(tx.get("SELECT 1 FROM memory_document_later_schedule WHERE owner_id=? AND scope_key=? AND state IN ('failed','unknown') LIMIT 1",[ownerId,scopeKey]))return true;
 const isSelf=row.scope_kind==='self',contactId=row.contact_id===null?null:String(row.contact_id);
 const blockers=tx.all(`SELECT t.id AS task_id,t.state AS task_state,t.error_code AS task_error,t.scope_kind AS task_scope_kind,t.contact_id AS task_contact_id,
   r.id AS run_id,r.state AS run_state,r.started_at,r.pause_requested_at,
   EXISTS(SELECT 1 FROM processing_step s LEFT JOIN step_attempt a ON a.owner_id=s.owner_id AND a.step_id=s.id LEFT JOIN model_call c ON c.owner_id=a.owner_id AND c.step_attempt_id=a.id
    WHERE s.owner_id=t.owner_id AND s.task_id=t.id AND (s.state='unknown' OR a.state='unknown' OR c.state='unknown')) AS has_unknown
  FROM processing_task t JOIN processing_run r ON r.owner_id=t.owner_id AND r.id=t.run_id
  LEFT JOIN task_contribution contribution ON contribution.owner_id=t.owner_id AND contribution.task_id=t.id
  WHERE t.owner_id=? AND coalesce(json_extract(r.policy_config,'$.intent'),'')<>'memory_document_later_stage'
   AND (?=1 OR (t.scope_kind='contact' AND t.contact_id=?) OR contribution.source_contact_id=?) GROUP BY t.id`,
 [ownerId,isSelf?1:0,contactId,contactId]);
 for(const blocker of blockers){
  // 一个同步只读扫描内按运行复验一次；先缩小到当前范围任务，避免每个任务展开完整回执链。
  const runId=String(blocker.run_id);
  if(['failed','revoked','completed'].includes(String(blocker.run_state))){
   let released=releasedRuns.get(runId);
   if(released===undefined){released=runTargetsReleased(tx,ownerId,runId);releasedRuns.set(runId,released);}
   if(released)continue;
  }
  if(blocker.pause_requested_at!==null||blocker.run_state==='paused'||blocker.task_state==='paused'||blocker.task_state==='unknown'||blocker.has_unknown===1n)return true;
  const failed=blocker.run_state==='failed'||blocker.task_state==='failed'||blocker.task_state==='incomplete'&&blocker.task_error!==null&&blocker.task_error!=='targets_completed_elsewhere';
  if(!failed||blocker.run_state==='completed')continue;
  const newer=isSelf
   ?tx.get(`SELECT 1 FROM processing_run newer JOIN processing_task task ON task.owner_id=newer.owner_id AND task.run_id=newer.id
     WHERE newer.owner_id=? AND newer.state='completed' AND newer.started_at>? AND task.scope_kind='self' AND task.state='succeeded'
      AND coalesce(json_extract(newer.policy_config,'$.intent'),'')<>'memory_document_later_stage' LIMIT 1`,[ownerId,blocker.started_at])
   :tx.get(`SELECT 1 FROM processing_run newer JOIN run_contact rc ON rc.owner_id=newer.owner_id AND rc.run_id=newer.id
     WHERE newer.owner_id=? AND newer.state='completed' AND newer.started_at>? AND rc.contact_id=? AND rc.state='active'
      AND EXISTS(SELECT 1 FROM run_input i WHERE i.owner_id=newer.owner_id AND i.run_id=newer.id AND i.source_contact_id=rc.contact_id AND i.role='target')
      AND coalesce(json_extract(newer.policy_config,'$.intent'),'')<>'memory_document_later_stage' LIMIT 1`,[ownerId,blocker.started_at,contactId]);
  if(!newer)return true;
 }
 return false;
}
export function laterTaskPaused(tx:StorageTransaction,ownerId:string,taskId:string):boolean {
 if(!exists(tx))return false;
 return !!tx.get("SELECT 1 FROM memory_document_later_schedule s JOIN memory_document_later_run_requirement q ON q.owner_id=s.owner_id AND q.scope_key=s.scope_key AND q.generation=s.generation WHERE s.owner_id=? AND s.task_id=? AND q.paused=1 LIMIT 1",[ownerId,taskId]);
}
function dueRows(tx:StorageTransaction,ownerId:string,now:number,includeFuture=false):StorageRow[]{
 const candidates=tx.all(`SELECT * FROM memory_document_later_schedule s WHERE s.owner_id=? AND s.state='scheduled' AND (?=1 OR s.due_at<=?)
  AND (s.stage='document_scene' OR NOT EXISTS(SELECT 1 FROM memory_document_later_schedule newer WHERE newer.owner_id=s.owner_id AND newer.scope_key=s.scope_key AND newer.stage='document_scene' AND newer.generation>s.generation AND newer.state IN ('scheduled','running')))
  ORDER BY s.due_at,s.scope_key,s.generation`,[ownerId,includeFuture?1:0,now]);
 const releasedRuns=new Map<string,boolean>();
 return candidates.filter(row=>!scopeBlocked(tx,ownerId,row,releasedRuns));
}
function validCurrentMemories(tx:StorageTransaction,ownerId:string,scope:MemoryScope):{memories:unknown[];sources:ReplySource[]} {
 const memories:unknown[]=[],sources:ReplySource[]=[];
 for(const m of tx.all("SELECT * FROM memory WHERE owner_id=? AND scope_kind=? AND contact_id IS ? AND state='active' ORDER BY id",[ownerId,scope.scopeKind,scope.contactId])){
  const v=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,m.id,m.current_version_no]);if(!v)continue;
  try{const value=memoryBasis(tx,ownerId,m,v);memories.push(value.memory);sources.push(...value.sources);}
  catch(error){if(error instanceof StorageFailure&&['document_memory_stale','document_time_invalid','document_time_pending','document_memory_unverified','memory_source_stale','document_source_stale'].includes(error.code))continue;throw error;}
 }
 return {memories,sources};
}
function currentRunContact(tx:StorageTransaction,ownerId:string,contactId:string):StorageRow|null {
 for(const row of tx.all(`SELECT rc.* FROM run_contact rc JOIN processing_run r ON r.owner_id=rc.owner_id AND r.id=rc.run_id
  WHERE rc.owner_id=? AND rc.contact_id=? AND rc.state='active' ORDER BY r.started_at DESC,r.rowid DESC`,[ownerId,contactId])){
  try{assertContribution(tx,ownerId,String(row.run_id),contactId);return row;}catch(error){if(!(error instanceof StorageFailure)||error.code!=='memory_extraction_scope_stale')throw error;}
 }
 return null;
}
function failSchedule(tx:StorageTransaction,ownerId:string,row:StorageRow,code:string):void {
 const state=code.includes('unknown')?'unknown':'failed';
 tx.run('UPDATE memory_document_later_schedule SET state=?,error_code=? WHERE owner_id=? AND scope_key=? AND generation=? AND state IN (\'scheduled\',\'running\')',[state,code,ownerId,row.scope_key,row.generation]);
 tx.run('UPDATE memory_document_later_run_requirement SET outcome=?,reason=?,updated_at=? WHERE owner_id=? AND scope_key=? AND generation=? AND outcome=\'pending\'',[state,code,Date.now(),ownerId,row.scope_key,row.generation]);
}
function createLaterRun(tx:StorageTransaction,ownerId:string,row:StorageRow,now:number):{runId:string;taskId:string} {
 const scope={scopeKind:String(row.scope_kind) as MemoryScope['scopeKind'],contactId:row.contact_id===null?null:String(row.contact_id)} as MemoryScope;
 available(tx,ownerId,scope);
 const base=scopeRow(tx,ownerId,scope);if(!base)throw new StorageFailure('document_scope_stale');
 if((base.memory_revision as bigint)<(row.requested_memory_revision as bigint))throw new StorageFailure('document_schedule_revision_stale');
 if(base.memory_revision!==row.requested_memory_revision){
  // 正式版本在排队期间可能因 protect 等元数据决定递增；到期时才固定当前版本，窗口不变。
  tx.run("UPDATE memory_document_later_schedule SET requested_memory_revision=? WHERE owner_id=? AND scope_key=? AND generation=? AND state='scheduled' AND requested_memory_revision=?",
   [base.memory_revision,ownerId,row.scope_key,row.generation,row.requested_memory_revision]);
 }
 const active=validCurrentMemories(tx,ownerId,scope),sources=[...active.sources];
 const publicationId=base.current_publication_id===null?null:String(base.current_publication_id);
 if(publicationId){
  const prior=tx.all(`SELECT m.document_id,m.version_no FROM publication_member m JOIN document_publication p ON p.owner_id=m.owner_id AND p.id=m.publication_id
   JOIN memory_document d ON d.owner_id=m.owner_id AND d.id=m.document_id
   WHERE m.owner_id=? AND m.publication_id=? AND p.availability='available'`,[ownerId,publicationId]);
  for(const member of prior)try{sources.push(...documentSources(tx,ownerId,String(member.document_id),member.version_no as bigint));}catch(error){if(!(error instanceof StorageFailure))throw error;}
 }
 const uniqueSources=[...new Map(sources.map(source=>[JSON.stringify([source.contactId,source.messageId]),source])).values()].sort((a,b)=>a.contactId.localeCompare(b.contactId)||a.messageId.localeCompare(b.messageId));
 const contacts=[...new Set(uniqueSources.map(source=>source.contactId))].sort();
 const contactsById=new Map<string,StorageRow>();
 for(const contactId of contacts){const template=currentRunContact(tx,ownerId,contactId);if(!template)throw new StorageFailure('document_scope_stale');contactsById.set(contactId,template);}
 const runId=randomUUID(),taskId=randomUUID(),requestKey=`later-document:${String(row.scope_key)}:${String(row.generation)}:${randomUUID()}`;
 const owner=tx.get("SELECT feedback_revision FROM owner WHERE owner_id=? AND state='active'",[ownerId]);if(!owner)throw new StorageFailure('document_scope_stale');
 const policy={intent:'memory_document_later_stage',stage:String(row.stage),generation:Number(row.generation),scopeKind:scope.scopeKind,contactId:scope.contactId};
 tx.run("INSERT INTO processing_run(owner_id,id,start_request_key,state,started_at,accepted_owner_feedback_revision,policy_config) VALUES(?,?,?,'preparing',?,?,?)",[ownerId,runId,requestKey,now,owner.feedback_revision,JSON.stringify(policy)]);
 for(const contactId of contacts){
  const template=contactsById.get(contactId)!;
  tx.run('INSERT INTO run_contact VALUES(?,?,?,?,?,?,?,?,?,?,?,\'active\')',[ownerId,runId,contactId,template.grant_id,template.binding_id,template.accepted_selection_generation,template.accepted_data_generation,template.accepted_identity_generation,template.accepted_account_revision,template.accepted_source_generation,template.accepted_feedback_revision]);
  assertContribution(tx,ownerId,runId,contactId);
 }
 for(const [index,source] of uniqueSources.entries())tx.run("INSERT INTO run_input(owner_id,run_id,input_no,role,kind,source_contact_id,item_id,message_id,record_id,accepted_interpretation_revision) VALUES(?,?,?,'context','message',?,NULL,?,?,?)",[ownerId,runId,index+1,source.contactId,source.messageId,source.recordId,source.acceptedRevision]);
 tx.run("INSERT INTO processing_task(owner_id,id,run_id,scope_kind,contact_id,state) VALUES(?,?,?,?,?,'succeeded')",[ownerId,taskId,runId,scope.scopeKind,scope.contactId]);
 for(const contactId of contacts)tx.run('INSERT INTO task_contribution VALUES(?,?,?,?)',[ownerId,taskId,runId,contactId]);
 assertInputs(tx,ownerId,runId,tx.all('SELECT * FROM run_input WHERE owner_id=? AND run_id=? ORDER BY input_no',[ownerId,runId]));
 tx.run(`UPDATE memory_document_later_schedule SET state='running',task_id=?,frozen_memory_revision=?,frozen_document_revision=?,frozen_publication_id=?
  WHERE owner_id=? AND scope_key=? AND generation=? AND state='scheduled'`,[taskId,base.memory_revision,base.document_revision,base.current_publication_id,ownerId,row.scope_key,row.generation]);
 tx.run("UPDATE processing_run SET state='running' WHERE owner_id=? AND id=? AND state='preparing'",[ownerId,runId]);
 return {runId,taskId};
}
function claimDue(tx:StorageTransaction,ownerId:string,now:number):unknown {
 const row=dueRows(tx,ownerId,now)[0];if(!row)return null;
 try{return {...createLaterRun(tx,ownerId,row,now),stage:String(row.stage),scope:{scopeKind:String(row.scope_kind),contactId:row.contact_id===null?null:String(row.contact_id)},generation:Number(row.generation)};}
 catch(error){const value=error as {code?:unknown};const code=error instanceof StorageFailure?error.code:typeof value?.code==='string'?`document_schedule_${value.code.toLowerCase().replace(/[^a-z0-9_]/g,'_')}`:'document_schedule_failed';failSchedule(tx,ownerId,row,code);return {failed:true,errorCode:code};}
}
function bodyDigest(tx:StorageTransaction,ownerId:string,scope:MemoryScope):string {
 const base=scopeRow(tx,ownerId,scope),publicationId=base?.current_publication_id;
 if(publicationId===null||publicationId===undefined)return sha256('[]');
 // 单条按 document_id、block_no、statement_no 排序的查询替代逐文档 N+1 查询；无正文文档仍贡献空数组成员。
 // 排序沿用原比较器的 localeCompare，只是预计算每个文档的 JSON 键避免逐次重复序列化；
 // 最终摘要串按 JSON 数组规则增量拼装，与 JSON.stringify(排序后成员) 逐字节相同。
 const rows=tx.all(`SELECT m.document_id AS document_id,s.block_no AS block_no,s.statement_no AS statement_no,s.body AS body
  FROM publication_member m JOIN memory_document d ON d.owner_id=m.owner_id AND d.id=m.document_id
  LEFT JOIN document_statement s ON s.owner_id=m.owner_id AND s.document_id=m.document_id AND s.version_no=m.version_no
  WHERE m.owner_id=? AND m.publication_id=? AND d.kind='scene' ORDER BY m.document_id,s.block_no,s.statement_no`,[ownerId,publicationId]);
 const groups=new Map<string,string[]>();
 for(const row of rows){
  const documentId=String(row.document_id);
  let bodies=groups.get(documentId);
  if(!bodies){bodies=[];groups.set(documentId,bodies);}
  if(row.body!==null)bodies.push(String(row.body));
 }
 const members=[...groups.values()],keys=members.map(bodies=>JSON.stringify(bodies));
 const order=members.map((_,index)=>index).sort((a,b)=>keys[a]!.localeCompare(keys[b]!));
 return sha256('['+order.map(index=>keys[index]!).join(',')+']');
}
/** 旧入口可能仍发布完整双阶段任务；只有真实当前publication且版本完全匹配时才结清同版队列。 */
function finishLegacyFullPublication(tx:StorageTransaction,ownerId:string,taskId:string,now:number):boolean {
 const task=tx.get(`SELECT t.*,r.policy_config FROM processing_task t JOIN processing_run r ON r.owner_id=t.owner_id AND r.id=t.run_id WHERE t.owner_id=? AND t.id=?`,[ownerId,taskId]);
 if(!task||task.document_basis_state!=='frozen')return false;
 try{if(JSON.parse(String(task.policy_config))?.intent==='memory_document_later_stage')return false;}catch{return false;}
 const stages=tx.all("SELECT kind,state FROM processing_step WHERE owner_id=? AND task_id=? AND kind IN ('document_scene','document_profile') ORDER BY kind",[ownerId,taskId]);
 if(stages.length!==2||stages.some(row=>row.state!=='succeeded')||new Set(stages.map(row=>String(row.kind))).size!==2)return false;
 const scope={scopeKind:String(task.scope_kind) as MemoryScope['scopeKind'],contactId:task.contact_id===null?null:String(task.contact_id)} as MemoryScope,parts=scopeParts(scope),base=scopeRow(tx,ownerId,scope);
 if(!base||base.memory_revision!==task.accepted_memory_revision||base.current_publication_id===null)return false;
 const publication=tx.get("SELECT id FROM document_publication WHERE owner_id=? AND id=? AND basis_task_id=? AND scope_kind=? AND contact_id IS ? AND availability='available'",[ownerId,base.current_publication_id,taskId,parts.scopeKind,parts.contactId]);
 if(!publication)return false;
 const digest=bodyDigest(tx,ownerId,scope),instant=safeTime(now);
 tx.run(`INSERT INTO memory_document_later_cursor(owner_id,scope_kind,scope_key,contact_id,scene_body_digest,profile_scene_body_digest,last_profile_success_at) VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(owner_id,scope_key) DO UPDATE SET scene_body_digest=excluded.scene_body_digest,profile_scene_body_digest=excluded.profile_scene_body_digest,last_profile_success_at=excluded.last_profile_success_at`,[ownerId,parts.scopeKind,parts.scopeKey,parts.contactId,digest,digest,instant]);
 const eligible=tx.all("SELECT generation,stage FROM memory_document_later_schedule WHERE owner_id=? AND scope_key=? AND state='scheduled' AND requested_memory_revision=?",[ownerId,parts.scopeKey,task.accepted_memory_revision]);
 for(const row of eligible){
  tx.run("UPDATE memory_document_later_schedule SET state='succeeded',task_id=?,frozen_memory_revision=?,frozen_document_revision=?,frozen_publication_id=?,scene_body_digest=?,error_code=NULL WHERE owner_id=? AND scope_key=? AND generation=? AND state='scheduled' AND requested_memory_revision=?",
   [taskId,task.accepted_memory_revision,task.accepted_document_revision,publication.id,digest,ownerId,parts.scopeKey,row.generation,task.accepted_memory_revision]);
  const runIds=tx.all("SELECT run_id FROM memory_document_later_run_requirement WHERE owner_id=? AND scope_key=? AND generation=? AND outcome='pending'",[ownerId,parts.scopeKey,row.generation]);
  tx.run("UPDATE memory_document_later_run_requirement SET outcome='completed',reason='legacy_full_publication',updated_at=? WHERE owner_id=? AND scope_key=? AND generation=? AND outcome='pending'",[instant,ownerId,parts.scopeKey,row.generation]);
  for(const item of runIds){tx.run("UPDATE processing_run SET followup_state='enrolled' WHERE owner_id=? AND id=? AND followup_state='pending'",[ownerId,item.run_id]);maybeCompleteL1Run(tx,ownerId,String(item.run_id));}
 }
 return eligible.length>0;
}
function finishLaterStage(tx:StorageTransaction,ownerId:string,taskId:string,now=Date.now()):boolean {
 const row=tx.get("SELECT s.* FROM memory_document_later_schedule s WHERE s.owner_id=? AND s.task_id=? AND s.state='running'",[ownerId,taskId]);if(!row)return finishLegacyFullPublication(tx,ownerId,taskId,now);
 const scope={scopeKind:String(row.scope_kind) as MemoryScope['scopeKind'],contactId:row.contact_id===null?null:String(row.contact_id)} as MemoryScope;
 const parts=scopeParts(scope),instant=safeTime(now);
 if(row.stage==='document_scene'){
  const digest=bodyDigest(tx,ownerId,scope),cursor=tx.get('SELECT * FROM memory_document_later_cursor WHERE owner_id=? AND scope_key=?',[ownerId,parts.scopeKey]);
  const profileSceneDigest=cursor?.profile_scene_body_digest===null||cursor?.profile_scene_body_digest===undefined?null:String(cursor.profile_scene_body_digest);
  tx.run('INSERT INTO memory_document_later_cursor(owner_id,scope_kind,scope_key,contact_id,scene_body_digest,profile_scene_body_digest,last_profile_success_at) VALUES(?,?,?,?,?,NULL,NULL) ON CONFLICT(owner_id,scope_key) DO UPDATE SET scene_body_digest=excluded.scene_body_digest',[ownerId,parts.scopeKind,parts.scopeKey,parts.contactId,digest]);
  tx.run("UPDATE memory_document_later_schedule SET state='succeeded',scene_body_digest=? WHERE owner_id=? AND scope_key=? AND generation=? AND state='running'",[digest,ownerId,parts.scopeKey,row.generation]);
  const hasScene=!!tx.get("SELECT 1 FROM publication_member m JOIN memory_document d ON d.owner_id=m.owner_id AND d.id=m.document_id WHERE m.owner_id=? AND m.publication_id=(SELECT current_publication_id FROM "+(scope.scopeKind==='self'?'owner':'contact')+" WHERE owner_id=?"+(scope.scopeKind==='contact'?' AND id=?':'')+") AND d.kind='scene' LIMIT 1",scope.scopeKind==='contact'?[ownerId,ownerId,scope.contactId]:[ownerId,ownerId]);
  if(!hasScene||profileSceneDigest===digest){
   const runIds=tx.all("SELECT run_id FROM memory_document_later_run_requirement WHERE owner_id=? AND scope_key=? AND generation=? AND outcome='pending'",[ownerId,parts.scopeKey,row.generation]);
   tx.run("UPDATE memory_document_later_run_requirement SET outcome='completed',reason=?,updated_at=? WHERE owner_id=? AND scope_key=? AND generation=? AND outcome='pending'",[hasScene?'scene_body_unchanged':'no_scene_body',instant,ownerId,parts.scopeKey,row.generation]);
   for(const item of runIds)maybeCompleteL1Run(tx,ownerId,String(item.run_id));return true;
  }
  const profile=scheduleRow(tx,ownerId,scope,'document_profile');
  if(profile&&profile.state==='scheduled'){
   tx.run('UPDATE memory_document_later_schedule SET requested_memory_revision=?,scene_body_digest=? WHERE owner_id=? AND scope_key=? AND generation=?',[scopeRow(tx,ownerId,scope)!.memory_revision, digest,ownerId,parts.scopeKey,profile.generation]);
   transferRequirements(tx,ownerId,scope,Number(row.generation),Number(profile.generation),instant);
  }else{
   const generation=Number((tx.get('SELECT coalesce(max(generation),0)+1 AS n FROM memory_document_later_schedule WHERE owner_id=? AND scope_key=?',[ownerId,parts.scopeKey])!.n as bigint));
   const last=cursor?.last_profile_success_at===null||cursor?.last_profile_success_at===undefined?null:Number(cursor.last_profile_success_at);
   const dueAt=last===null?instant:Math.max(instant,last+profileWindowMs);
   tx.run("INSERT INTO memory_document_later_schedule(owner_id,scope_kind,scope_key,contact_id,generation,stage,state,first_changed_at,last_changed_at,due_at,requested_memory_revision,scene_body_digest) VALUES(?,?,?, ?,?,'document_profile','scheduled',?,?,?,?,?)",[ownerId,parts.scopeKind,parts.scopeKey,parts.contactId,generation,instant,instant,dueAt,scopeRow(tx,ownerId,scope)!.memory_revision,digest]);
   transferRequirements(tx,ownerId,scope,Number(row.generation),generation,instant);
  }
  return true;
 }
 tx.run("UPDATE memory_document_later_schedule SET state='succeeded' WHERE owner_id=? AND scope_key=? AND generation=? AND state='running'",[ownerId,parts.scopeKey,row.generation]);
 const consumedSceneDigest=row.scene_body_digest===null?bodyDigest(tx,ownerId,scope):String(row.scene_body_digest);
 tx.run('UPDATE memory_document_later_cursor SET last_profile_success_at=?,profile_scene_body_digest=? WHERE owner_id=? AND scope_key=?',[instant,consumedSceneDigest,ownerId,parts.scopeKey]);
 const runIds=tx.all("SELECT run_id FROM memory_document_later_run_requirement WHERE owner_id=? AND scope_key=? AND generation=? AND outcome='pending'",[ownerId,parts.scopeKey,row.generation]);
 tx.run("UPDATE memory_document_later_run_requirement SET outcome='completed',reason=NULL,updated_at=? WHERE owner_id=? AND scope_key=? AND generation=? AND outcome='pending'",[instant,ownerId,parts.scopeKey,row.generation]);
 for(const item of runIds)maybeCompleteL1Run(tx,ownerId,String(item.run_id));
 return true;
}
export function finishLaterStagePublication(tx:StorageTransaction,ownerId:string,taskId:string,now=Date.now()):boolean{return exists(tx)?finishLaterStage(tx,ownerId,taskId,now):false;}
/** 仅结清专用文档轮的已知终态；不发布内容，不把活租约、未决调用或用户暂停当作已完成。 */
export function reconcileTerminalLaterRuns(tx:StorageTransaction,ownerId:string):number {
 if(!exists(tx))return 0;
 const rows=tx.all(`SELECT DISTINCT r.id,s.state AS schedule_state FROM memory_document_later_schedule s
  JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
  JOIN processing_run r ON r.owner_id=t.owner_id AND r.id=t.run_id
  WHERE s.owner_id=? AND s.state IN ('failed','superseded') AND r.state IN ('preparing','running') AND r.pause_requested_at IS NULL
   AND json_extract(r.policy_config,'$.intent')='memory_document_later_stage'
   AND NOT EXISTS(SELECT 1 FROM processing_task active WHERE active.owner_id=r.owner_id AND active.run_id=r.id AND active.state IN ('paused','unknown','running'))
   AND NOT EXISTS(SELECT 1 FROM processing_step step JOIN processing_task task ON task.owner_id=step.owner_id AND task.id=step.task_id
    LEFT JOIN step_attempt attempt ON attempt.owner_id=step.owner_id AND attempt.step_id=step.id
    WHERE task.owner_id=r.owner_id AND task.run_id=r.id AND (step.state IN ('running','unknown') OR attempt.state IN ('running','unknown')))
   AND NOT EXISTS(SELECT 1 FROM model_operation operation JOIN processing_step step ON step.owner_id=operation.owner_id AND step.id=operation.memory_step_id
    JOIN processing_task task ON task.owner_id=step.owner_id AND task.id=step.task_id LEFT JOIN model_call call ON call.owner_id=operation.owner_id AND call.operation_id=operation.id
    WHERE task.owner_id=r.owner_id AND task.run_id=r.id AND (operation.state IN ('prepared','in_flight','unknown') OR call.state IN ('prepared','sending','unknown')))
  ORDER BY r.id`,[ownerId]);
 let settled=0;
 for(const row of rows){
  tx.run("UPDATE processing_run SET state=? WHERE owner_id=? AND id=? AND state IN ('preparing','running') AND pause_requested_at IS NULL",[row.schedule_state==='failed'?'failed':'incomplete',ownerId,row.id]);
  settled++;
 }
 return settled;
}
export function failLaterStage(tx:StorageTransaction,ownerId:string,taskId:string,code:string,now=Date.now()):boolean {
 if(!exists(tx))return false;
 const row=tx.get("SELECT * FROM memory_document_later_schedule WHERE owner_id=? AND task_id=? AND state='running'",[ownerId,taskId]);if(!row)return false;
 const instant=safeTime(now),scope={scopeKind:String(row.scope_kind) as MemoryScope['scopeKind'],contactId:row.contact_id===null?null:String(row.contact_id)} as MemoryScope;
 const unknown=!!tx.get("SELECT 1 FROM processing_step s LEFT JOIN step_attempt a ON a.owner_id=s.owner_id AND a.step_id=s.id LEFT JOIN model_call c ON c.owner_id=a.owner_id AND c.step_attempt_id=a.id WHERE s.owner_id=? AND s.task_id=? AND (s.state='unknown' OR a.state='unknown' OR c.state='unknown') LIMIT 1",[ownerId,taskId]);
 if(unknown){
  tx.run("UPDATE memory_document_later_schedule SET state='unknown',error_code=? WHERE owner_id=? AND scope_key=? AND generation=?",[code,ownerId,row.scope_key,row.generation]);
  tx.run("UPDATE memory_document_later_run_requirement SET outcome='unknown',reason=?,updated_at=? WHERE owner_id=? AND scope_key=? AND generation=? AND outcome='pending'",[code,instant,ownerId,row.scope_key,row.generation]);return true;
 }
 const current=scopeRow(tx,ownerId,scope),newer=tx.get("SELECT generation FROM memory_document_later_schedule WHERE owner_id=? AND scope_key=? AND stage='document_scene' AND state='scheduled' ORDER BY generation DESC LIMIT 1",[ownerId,row.scope_key]);
 if(current&&current.memory_revision!==row.frozen_memory_revision&&newer){
  tx.run("UPDATE memory_document_later_schedule SET state='superseded',error_code=? WHERE owner_id=? AND scope_key=? AND generation=?",[code,ownerId,row.scope_key,row.generation]);
  transferRequirements(tx,ownerId,scope,Number(row.generation),Number(newer.generation),instant);reconcileTerminalLaterRuns(tx,ownerId);return true;
 }
 tx.run("UPDATE memory_document_later_schedule SET state='failed',error_code=? WHERE owner_id=? AND scope_key=? AND generation=?",[code,ownerId,row.scope_key,row.generation]);
 tx.run("UPDATE memory_document_later_run_requirement SET outcome='failed',reason=?,updated_at=? WHERE owner_id=? AND scope_key=? AND generation=? AND outcome='pending'",[code,instant,ownerId,row.scope_key,row.generation]);reconcileTerminalLaterRuns(tx,ownerId);return true;
}

export const memoryDocumentsLaterScheduleActions:StorageAction[]=[
 action('scheduleMemoryChange','write',(tx,i)=>scheduleMemoryChange(tx,String(i.ownerId),i.scope as MemoryScope,safeTime(i.changedAt??Date.now()),typeof i.runId==='string'?i.runId:undefined)),
 action('enrollRun','write',(tx,i)=>enrollRun(tx,String(i.ownerId),String(i.runId))),
 action('pauseRunSchedule','write',(tx,i)=>setRunSchedulePaused(tx,String(i.ownerId),String(i.runId),i.paused===true)),
 action('resumeRunSchedule','write',(tx,i)=>resumeRunSchedule(tx,String(i.ownerId),String(i.runId),safeTime(i.now??Date.now()))),
 action('readSchedule','read',(tx,i)=>snapshot(tx,String(i.ownerId),i.scope as MemoryScope)),
 action('queueSummary','read',(tx,i)=>queueSummary(tx,String(i.ownerId))),
 action('nextDueAt','read',(tx,i)=>queueSummary(tx,String(i.ownerId)).nextDueAt),
 action('claimDue','write',(tx,i)=>claimDue(tx,String(i.ownerId),safeTime(i.now))),
 action('recoverableLaterRuns','read',(tx,i)=>tx.all(`SELECT DISTINCT t.run_id FROM memory_document_later_schedule s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
  JOIN processing_step p ON p.owner_id=t.owner_id AND p.task_id=t.id AND p.kind=s.stage AND p.state='succeeded'
  WHERE s.owner_id=? AND s.state='running' AND NOT EXISTS(SELECT 1 FROM document_publication d WHERE d.owner_id=t.owner_id AND d.basis_task_id=t.id AND d.availability='available') ORDER BY t.run_id`,[String(i.ownerId)]).map(row=>String(row.run_id))),
];
