import { createHash, randomUUID } from 'node:crypto';
import { StorageFailure, type StorageAction, type StorageTransaction, type StorageRow } from '../../storage/sqlite/contracts.ts';
import { assertReadEligibility } from '../../contacts/sqlite/actions.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistoryPage, HistoryTailPage, HistoryTarget, HistorySupportReport } from './contracts.ts';
import { ingestRecords } from './ingest.ts';
import { readCoverage, readMessages } from './read.ts';
import { clearBoundaryExclusion, completeRestoreGoal, restoreOperationForGoal } from './clear-actions.ts';
import { assertHistoryCursor, historyCursorScheme, historyCursorScopeDigest } from './cursor.ts';
import { assertHistoryReadBoundary } from './suppression.ts';
const fail:(code:string)=>never=(code)=>{throw new StorageFailure(code);};
const action=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,i:any)=>unknown):StorageAction=>({name,mode,retryBusy:true,execute});
export const serializeSupport=(report:HistorySupportReport):string=>JSON.stringify(Object.fromEntries(Object.entries(report).sort(([a],[b])=>a.localeCompare(b))));
export function assertSupport(report:HistorySupportReport):void {
 if(report?.status==='unsupported')fail('history_support_unsupported');
 if(report?.status!=='supported'||report.protocol!=='private-history-v1'||report.identity!=='source-table-local-v1'
  ||!report.accountKey||!report.conversationKey||!report.sourceGeneration||!report.profileId||!report.adapterVersion||!report.programVersion||!report.build||!report.statusSemantics||!report.continuity
  ||!Array.isArray(report.declaredPrimaryKey)||!report.declaredPrimaryKey.length
  ||!/^[a-f0-9]{64}$/.test(report.artifactSha256)||!/^[a-f0-9]{64}$/.test(report.schemaFingerprint))fail('history_support_unverified');
}
function goalFor(tx:StorageTransaction,owner:string,id:string):StorageRow {return tx.get('SELECT * FROM read_goal WHERE owner_id=? AND id=?',[owner,id])??fail('history_goal_not_found');}
function currentGoal(tx:StorageTransaction,token:ReadEligibility,id:string):StorageRow {
 assertReadEligibility(tx,token);const goal=goalFor(tx,token.owner_id,id);
 if(goal.eligibility_json!==JSON.stringify(token)||goal.contact_id!==token.contact_id||goal.binding_id!==token.binding_id)fail('history_goal_stale');
 return goal;
}
function targetOf(value:unknown,token:ReadEligibility):HistoryTarget {
 const target=value as HistoryTarget;
 if(target?.protocol!=='private-history-v1'||target.sourceGeneration!==token.source_generation||typeof target.descriptor!=='string'||!target.descriptor||target.descriptor.length>64_000||!Array.isArray(target.partitions)||!target.partitions.length||target.partitions.length>10_000||target.partitions.some(p=>typeof p!=='string'||!p||p.length>512)||new Set(target.partitions).size!==target.partitions.length)fail('history_target_unverified');
 if(!Array.isArray(target.tables)||target.tables.length>10_000||target.partitions.some(p=>!target.tables.some(t=>t.partition===p))
  ||target.tables.some(t=>!target.partitions.includes(t.partition)||typeof t.instance!=='string'||!t.instance||t.instance.length>512)
  ||new Set(target.tables.map(t=>JSON.stringify([t.partition,t.instance]))).size!==target.tables.length)fail('history_target_unverified');
 return target;
}
function currentIncremental(tx:StorageTransaction,token:ReadEligibility,report:HistorySupportReport):StorageRow|undefined {
 const goal=tx.get("SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND kind='incremental' AND state IN ('running','incomplete') AND eligibility_json=? ORDER BY created_at DESC,rowid DESC LIMIT 1",[token.owner_id,token.contact_id,JSON.stringify(token)]);
 if(!goal)return undefined;
 if(goal.support_json!==serializeSupport(report))fail('history_support_changed');
 if(String(goal.accepted_barrier_generation)!==String(token.barrier_generation))fail('history_suppression_changed');
 const target=JSON.parse(String(goal.target_json)) as HistoryTarget;
 if(historyCursorScopeDigest(token,report,target)!==goal.cursor_scope_digest)fail('history_cursor_scope_changed');
 if(!goal.cursor)fail('history_cursor_invalid');
 return goal;
}
export const historyActions:StorageAction[]=[
 action('history.scope','read',(tx,i)=>{assertReadEligibility(tx,i.token);const row=tx.get(`SELECT a.external_key AS account_key,c.external_key AS conversation_key FROM channel_account a JOIN channel_conversation c ON c.owner_id=a.owner_id AND c.account_id=a.id WHERE a.owner_id=? AND a.id=? AND c.id=?`,[i.token.owner_id,i.token.account_id,i.token.conversation_id])??fail('history_scope_invalid');return {token:i.token,accountKey:row.account_key,conversationKey:row.conversation_key};}),
 action('history.pending','read',(tx,i)=>{assertReadEligibility(tx,i.token);const goal=tx.get("SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND kind='history' AND state IN ('running','incomplete') AND eligibility_json=? ORDER BY created_at DESC,rowid DESC LIMIT 1",[i.token.owner_id,i.token.contact_id,JSON.stringify(i.token)]);if(goal&&goal.support_json!==serializeSupport(i.report))fail('history_support_changed');return goal?{id:goal.id,target:JSON.parse(String(goal.target_json)),cursor:goal.cursor}:null;}),
 action('history.begin','write',(tx,i)=>{
  const token=i.token as ReadEligibility;assertReadEligibility(tx,token);assertSupport(i.report);
  const target=targetOf(i.target,token);assertHistoryReadBoundary(tx,token,{kind:'history'});
  tx.run(`INSERT INTO read_goal(owner_id,id,contact_id,binding_id,grant_id,accepted_data_generation,accepted_barrier_generation,kind,target_protocol,target_descriptor,target_json,eligibility_json,support_json,state,coverage_state,created_at) VALUES(?,?,?,?,?,?,?,'history',?,?,?,?,?,'running','partial',?)`,[token.owner_id,i.id,token.contact_id,token.binding_id,token.grant_id,BigInt(token.data_generation),BigInt(token.barrier_generation),target.protocol,target.descriptor,JSON.stringify(target),JSON.stringify(token),serializeSupport(i.report),i.at]);
  return {id:i.id,target,cursor:null};
 }),
 action('history.acceptPage','write',(tx,i)=>{
  const token=i.token as ReadEligibility;const goal=currentGoal(tx,token,i.goalId);const page=i.page as HistoryPage;
  const digest=createHash('sha256').update(JSON.stringify(page)).digest('hex');
  const prior=tx.get('SELECT response_digest FROM sync_capture WHERE owner_id=? AND id=?',[token.owner_id,i.captureId]);
  if(prior){if(prior.response_digest!==digest)fail('history_capture_replay_conflict');return readCoverage(tx,token.owner_id,token.contact_id);}
  if(goal.kind!=='history')fail('history_goal_kind_invalid');
  if(goal.state!=='running'&&goal.state!=='incomplete')fail('history_goal_closed');
  assertHistoryReadBoundary(tx,token,{kind:'history'});
  const target=JSON.parse(String(goal.target_json)) as HistoryTarget;
  if(page?.target!==goal.target_descriptor||page.cursorIn!==goal.cursor||!Array.isArray(page.records)||page.records.length>1000||!Array.isArray(page.completedPartitions)||page.completedPartitions.some(p=>!target.partitions.includes(p))||typeof page.exhausted!=='boolean'||page.exhausted&&page.cursorOut!==null||!page.exhausted&&(typeof page.cursorOut!=='string'||!page.cursorOut||page.cursorOut===page.cursorIn))fail('history_page_invalid');
  const resumeCursor=page.resumeCursor===undefined||page.resumeCursor===null?null:assertHistoryCursor(page.resumeCursor,'history_page_invalid');
  if(resumeCursor!==null&&!page.exhausted)fail('history_page_invalid');
  const report=JSON.parse(String(goal.support_json)) as HistorySupportReport;
  tx.run("INSERT INTO sync_capture(owner_id,id,contact_id,goal_id,read_epoch,runtime_token,captured_at,adapter_version,cursor_in,cursor_out,state,response_digest) VALUES(?,?,?,?,?,?,?,?,?,?,'accepted',?)",[token.owner_id,i.captureId,token.contact_id,goal.id,BigInt(token.read_epoch),i.runtimeToken,i.at,report.adapterVersion,page.cursorIn,page.cursorOut,digest]);
  const restoreOperationId=restoreOperationForGoal(tx,token.owner_id,String(goal.id))??null;
  const {quarantined}=ingestRecords({tx,token,report,target,captureId:i.captureId,at:i.at,records:page.records,
   exclude:observed=>observed.localKey&&clearBoundaryExclusion(tx,{ownerId:token.owner_id,conversationId:token.conversation_id,externalKey:observed.localKey,restoreOperationId})?'clear_excluded':null});
  const partitions=new Set<string>([...JSON.parse(String(goal.completed_partitions)),...page.completedPartitions]);
  const unresolved=quarantined||Boolean(tx.get("SELECT 1 FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id WHERE c.owner_id=? AND c.goal_id=? AND r.state='quarantined'",[token.owner_id,goal.id]));
  const complete=page.exhausted&&target.partitions.every(p=>partitions.has(p))&&!unresolved;
  const state=complete?'complete':page.exhausted?'incomplete':'running';const code=unresolved?'history_identity_quarantined':page.exhausted&&!complete?'history_partitions_missing':null;
  if(quarantined)tx.run("UPDATE sync_capture SET state='quarantined',error_code='history_identity_quarantined' WHERE owner_id=? AND id=?",[token.owner_id,i.captureId]);
  tx.run('UPDATE read_goal SET cursor=?,completed_partitions=?,state=?,coverage_state=?,failure_code=? WHERE owner_id=? AND id=?',[page.cursorOut,JSON.stringify([...partitions]),state,complete?'complete':'partial',code,token.owner_id,goal.id]);
  // 历史终页与增量交接在同一事务：先固定保守续读游标及完整作用域证据，再原子创建增量目标，窗口内无缺口。
  if(complete&&resumeCursor!==null){
   const scopeDigest=historyCursorScopeDigest(token,report,target);
   tx.run('UPDATE read_goal SET resume_cursor=?,cursor_scope_digest=?,cursor_scheme=? WHERE owner_id=? AND id=?',[resumeCursor,scopeDigest,historyCursorScheme,token.owner_id,goal.id]);
   const existing=tx.get("SELECT id FROM read_goal WHERE owner_id=? AND contact_id=? AND kind='incremental' ORDER BY created_at DESC,rowid DESC LIMIT 1",[token.owner_id,token.contact_id]);
   if(!existing)tx.run(`INSERT INTO read_goal(owner_id,id,contact_id,binding_id,grant_id,accepted_data_generation,accepted_barrier_generation,kind,target_protocol,target_descriptor,target_json,eligibility_json,support_json,cursor,state,coverage_state,created_at,cursor_scope_digest,cursor_scheme,handoff_from_goal_id,pages_accepted) VALUES(?,?,?,?,?,?,?,'incremental',?,?,?,?,?,?,'running','ready',?,?,?,?,0)`,
    [token.owner_id,randomUUID(),token.contact_id,token.binding_id,token.grant_id,BigInt(token.data_generation),BigInt(token.barrier_generation),target.protocol,target.descriptor,JSON.stringify(target),JSON.stringify(token),serializeSupport(report),resumeCursor,i.at,scopeDigest,historyCursorScheme,goal.id]);
  }
  if(complete)completeRestoreGoal(tx,token.owner_id,String(goal.id),i.at);
  return readCoverage(tx,token.owner_id,token.contact_id);
 }),
 action('history.interrupt','write',(tx,i)=>{const goal=currentGoal(tx,i.token,i.goalId);if(goal.state==='running'||goal.state==='incomplete')tx.run("UPDATE read_goal SET state='incomplete',failure_code=? WHERE owner_id=? AND id=?",[i.code,i.token.owner_id,goal.id]);return readCoverage(tx,i.token.owner_id,i.token.contact_id);}),
 action('history.incrementalPending','read',(tx,i)=>{assertReadEligibility(tx,i.token);const goal=currentIncremental(tx,i.token,i.report);return goal?{id:String(goal.id),target:JSON.parse(String(goal.target_json)),cursor:String(goal.cursor)}:null;}),
 action('history.beginIncremental','write',(tx,i)=>{
  const token=i.token as ReadEligibility;const report=i.report as HistorySupportReport;assertReadEligibility(tx,token);assertSupport(report);
  assertHistoryReadBoundary(tx,token,{kind:'incremental'});
  const existing=currentIncremental(tx,token,report);
  if(existing)return {id:String(existing.id),target:JSON.parse(String(existing.target_json)),cursor:String(existing.cursor)};
  // 只从同一完整作用域的既有检查点续读；来源/账号/分片/目标/语义变化会失配并显式停止。
  const resumable=tx.get(`SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND cursor_scope_digest IS NOT NULL AND ((kind='incremental' AND cursor IS NOT NULL) OR (kind='history' AND resume_cursor IS NOT NULL AND state='complete')) ORDER BY created_at DESC,rowid DESC LIMIT 1`,[token.owner_id,token.contact_id]);
  if(!resumable)fail('history_incremental_not_ready');
  const target=targetOf(JSON.parse(String(resumable.target_json)),token);
  const scopeDigest=historyCursorScopeDigest(token,report,target);
  if(resumable.cursor_scope_digest!==scopeDigest)fail('history_cursor_scope_changed');
  if(String(resumable.accepted_barrier_generation)!==String(token.barrier_generation))fail('history_suppression_changed');
  const cursor=assertHistoryCursor(resumable.kind==='incremental'?resumable.cursor:resumable.resume_cursor,'history_cursor_invalid');
  // 旧执行不复活：旧增量目标标记失效，新资格建立新目标，检查点只作为续读位置。
  tx.run("UPDATE read_goal SET state='invalidated',failure_code='history_eligibility_changed' WHERE owner_id=? AND contact_id=? AND kind='incremental' AND state IN ('running','incomplete')",[token.owner_id,token.contact_id]);
  const id=i.id as string;
  tx.run(`INSERT INTO read_goal(owner_id,id,contact_id,binding_id,grant_id,accepted_data_generation,accepted_barrier_generation,kind,target_protocol,target_descriptor,target_json,eligibility_json,support_json,cursor,state,coverage_state,created_at,cursor_scope_digest,cursor_scheme,handoff_from_goal_id,pages_accepted) VALUES(?,?,?,?,?,?,?,'incremental',?,?,?,?,?,?,'running','partial',?,?,?,?,0)`,
   [token.owner_id,id,token.contact_id,token.binding_id,token.grant_id,BigInt(token.data_generation),BigInt(token.barrier_generation),target.protocol,target.descriptor,JSON.stringify(target),JSON.stringify(token),serializeSupport(report),cursor,i.at,scopeDigest,historyCursorScheme,resumable.id]);
  return {id,target,cursor};
 }),
 action('history.acceptIncrementalPage','write',(tx,i)=>{
  const token=i.token as ReadEligibility;const goal=currentGoal(tx,token,i.goalId);const page=i.page as HistoryTailPage;
  const digest=createHash('sha256').update(JSON.stringify(page)).digest('hex');
  const prior=tx.get('SELECT response_digest FROM sync_capture WHERE owner_id=? AND id=?',[token.owner_id,i.captureId]);
  if(prior){if(prior.response_digest!==digest)fail('history_capture_replay_conflict');return readCoverage(tx,token.owner_id,token.contact_id);}
  if(goal.kind!=='incremental')fail('history_goal_kind_invalid');
  if(goal.state!=='running'&&goal.state!=='incomplete')fail('history_goal_closed');
  assertHistoryReadBoundary(tx,token,{kind:'incremental'});
  if(String(goal.accepted_barrier_generation)!==String(token.barrier_generation))fail('history_suppression_changed');
  const target=JSON.parse(String(goal.target_json)) as HistoryTarget;
  if(page?.target!==goal.target_descriptor||page.cursorIn!==goal.cursor||!Array.isArray(page.records)||page.records.length>1000||typeof page.cursorOut!=='string'||(page.cursorOut===page.cursorIn&&page.caughtUp===false)||typeof page.caughtUp!=='boolean')fail('history_page_invalid');
  const cursorOut=assertHistoryCursor(page.cursorOut,'history_page_invalid');
  const report=JSON.parse(String(goal.support_json)) as HistorySupportReport;
  if(historyCursorScopeDigest(token,report,target)!==goal.cursor_scope_digest)fail('history_cursor_scope_changed');
  tx.run("INSERT INTO sync_capture(owner_id,id,contact_id,goal_id,read_epoch,runtime_token,captured_at,adapter_version,cursor_in,cursor_out,state,response_digest) VALUES(?,?,?,?,?,?,?,?,?,?,'accepted',?)",[token.owner_id,i.captureId,token.contact_id,goal.id,BigInt(token.read_epoch),i.runtimeToken,i.at,report.adapterVersion,page.cursorIn,cursorOut,digest]);
  const incrementalRestoreId=restoreOperationForGoal(tx,token.owner_id,String(goal.id))??null;
  ingestRecords({tx,token,report,target,captureId:i.captureId,at:i.at,records:page.records,
   exclude:observed=>observed.localKey&&clearBoundaryExclusion(tx,{ownerId:token.owner_id,conversationId:token.conversation_id,externalKey:observed.localKey,restoreOperationId:incrementalRestoreId})?'clear_excluded':null});
  // 成功接受的一页同时恢复目标为运行态：此前的中断原因不再代表当前状态。
  tx.run("UPDATE read_goal SET cursor=?,pages_accepted=pages_accepted+1,last_accepted_at=?,coverage_state=?,state='running',failure_code=NULL WHERE owner_id=? AND id=?",[cursorOut,BigInt(i.at),page.caughtUp?'caught_up':'partial',token.owner_id,goal.id]);
  return readCoverage(tx,token.owner_id,token.contact_id);
 }),
 action('history.incrementalInterrupt','write',(tx,i)=>{
  const goal=tx.get('SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND id=?',[i.ownerId,i.contactId,i.goalId])??fail('history_goal_not_found');
  if(goal.kind!=='incremental')fail('history_goal_kind_invalid');
  if(goal.state==='running'||goal.state==='incomplete')tx.run('UPDATE read_goal SET state=?,failure_code=? WHERE owner_id=? AND id=?',[i.invalidated===true?'invalidated':'incomplete',i.code,i.ownerId,i.goalId]);
  return readCoverage(tx,i.ownerId,i.contactId);
 }),
 action('history.source','read',(tx,i)=>{
  readCoverage(tx,i.ownerId,i.contactId);
  const row=tx.get(`SELECT r.*,c.goal_id,c.captured_at,c.adapter_version,c.cursor_in,c.cursor_out,g.support_json
   FROM capture_record r JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id
   JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
   JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
   WHERE r.owner_id=? AND r.contact_id=? AND r.id=? AND r.state='normalized' AND r.availability='available' AND m.availability='available'`,[i.ownerId,i.contactId,i.recordId])??fail('history_source_not_found');
  return {recordId:row.id,contactId:row.contact_id,messageId:row.message_id,captureId:row.capture_id,goalId:row.goal_id,
   itemNo:Number(row.item_no),capturedAt:String(row.captured_at),adapterVersion:row.adapter_version,normalizerVersion:row.normalizer_version,
   cursorIn:row.cursor_in,cursorOut:row.cursor_out,raw:JSON.parse(String(row.raw_payload)),support:JSON.parse(String(row.support_json))};
 }),
 action('history.coverage','read',(tx,i)=>readCoverage(tx,i.ownerId,i.contactId)),
 action('history.read','read',(tx,i)=>readMessages(tx,i.ownerId,i.contactId,i.limit,i.before)),
];
