import {assertRecertifyAccess} from './recertify-access.ts';
import { createHash, randomUUID } from 'node:crypto';
import { StorageFailure, type StorageAction, type StorageTransaction, type StorageRow } from '../../storage/sqlite/contracts.ts';
import { assertReadEligibility } from '../../contacts/sqlite/actions.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistoryPage, HistoryTailPage, HistoryTarget, HistorySupportReport } from './contracts.ts';
import { ingestRecords, quarantineUnverifiedRecords } from './ingest.ts';
import { isCertifiedEmptyTarget, readCoverage, readMessages, readChatMessages, readRecentMessages } from './read.ts';
import {unresolvedQuarantineCount} from './quarantine.ts';
import {currentSourceScopeCTE,currentSourcePredicate} from './current-scope.ts';
import { clearBoundaryExclusion, completeRestoreGoal, restoreOperationForGoal } from './clear-actions.ts';
import { assertHistoryCursor, historyCursorScheme, historyCursorScopeDigest } from './cursor.ts';
import { isPartitionGrowthReportChange, isPartitionGrowthTargetChange } from '../partition-growth.ts';
import { assertHistoryReadBoundary } from './suppression.ts';
import { assertSourceContinuity, assertLiveGuard, fenceContinuity, normalUseContinuity, normalUseRevalidationCandidate, prepareNormalUseTarget, preflightGeneration, preflightTarget } from './continuity.ts';
const fail:(code:string)=>never=(code)=>{throw new StorageFailure(code);};
const action=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,i:any)=>unknown):StorageAction=>({name,mode,retryBusy:true,execute});
export const serializeSupport=(report:HistorySupportReport):string=>JSON.stringify(Object.fromEntries(Object.entries(report).sort(([a],[b])=>a.localeCompare(b))));
const publicSupportReasons=new Set(['history_message_state_unverified','history_source_lifecycle_unverified',
 'history_snapshot_runtime_proof_required','history_partition_coverage_runtime_proof_required']);
const absentTargetProfile='wechat-4.0.6-29387-absent-private-target-v1';
function verifiedAbsentTarget(report:HistorySupportReport|undefined):boolean {
 return report?.profileId===absentTargetProfile&&report.status==='supported'&&report.continuity===normalUseContinuity
  &&report.statusSemantics==='no-message-table-v1'&&Array.isArray(report.declaredPrimaryKey)&&report.declaredPrimaryKey.length===0
  &&report.capabilities?.incrementalTail==='unsupported'
  &&(['normalHistory','snapshotBarrier','partitionCoverage','sourceLifecycle','restartContinuity','recoveryMapping'] as const).every(key=>report.capabilities?.[key]==='supported');
}
export function assertSupport(report:HistorySupportReport):void {
 if(report?.status==='unsupported')fail('history_support_unsupported');
 if(report?.status==='unverified')fail(publicSupportReasons.has(report.reason??'')?report.reason!:'history_support_unverified');
 if(report?.status!=='supported'||report.protocol!=='private-history-v1'||report.identity!=='source-table-local-v1'
  ||!report.accountKey||!report.conversationKey||!report.sourceGeneration||!report.profileId||!report.adapterVersion||!report.programVersion||!report.build||!report.statusSemantics||!report.continuity
  ||!Array.isArray(report.declaredPrimaryKey)||!report.declaredPrimaryKey.length&&!verifiedAbsentTarget(report)
  ||report.profileId===absentTargetProfile&&!verifiedAbsentTarget(report)
  ||!/^[a-f0-9]{64}$/.test(report.artifactSha256)||!/^[a-f0-9]{64}$/.test(report.schemaFingerprint))fail('history_support_unverified');
}
function goalFor(tx:StorageTransaction,owner:string,id:string):StorageRow {return tx.get('SELECT * FROM read_goal WHERE owner_id=? AND id=?',[owner,id])??fail('history_goal_not_found');}
function currentGoal(tx:StorageTransaction,token:ReadEligibility,id:string):StorageRow {
 assertReadEligibility(tx,token);const goal=goalFor(tx,token.owner_id,id);
 if(goal.eligibility_json!==JSON.stringify(token)||goal.contact_id!==token.contact_id||goal.binding_id!==token.binding_id)fail('history_goal_stale');
 return goal;
}
function assertCaptureReplay(prior:StorageRow,token:ReadEligibility,goal:StorageRow,digest:string,cursorIn:unknown,cursorOut:unknown):void {
 if(prior.response_digest!==digest||prior.contact_id!==token.contact_id||String(prior.goal_id)!==String(goal.id)
  ||String(prior.read_epoch)!==String(token.read_epoch)||prior.cursor_in!==cursorIn||prior.cursor_out!==cursorOut)fail('history_capture_replay_conflict');
}
function targetOf(value:unknown,token:ReadEligibility,report?:HistorySupportReport):HistoryTarget {
 const target=value as HistoryTarget;
 const absent=verifiedAbsentTarget(report);
 if(target?.protocol!=='private-history-v1'||target.sourceGeneration!==token.source_generation||typeof target.descriptor!=='string'||!target.descriptor||target.descriptor.length>64_000||!Array.isArray(target.partitions)||!target.partitions.length||target.partitions.length>10_000||target.partitions.some(p=>typeof p!=='string'||!p||p.length>512)||new Set(target.partitions).size!==target.partitions.length)fail('history_target_unverified');
 if(!Array.isArray(target.tables)||target.tables.length>10_000||absent&&target.tables.length!==0||!absent&&target.partitions.some(p=>!target.tables.some(t=>t.partition===p))
  ||target.tables.some(t=>!target.partitions.includes(t.partition)||typeof t.instance!=='string'||!t.instance||t.instance.length>512)
  ||new Set(target.tables.map(t=>JSON.stringify([t.partition,t.instance]))).size!==target.tables.length
  ||target.checkedPartitions!==undefined&&(!Array.isArray(target.checkedPartitions)||!target.checkedPartitions.length||target.checkedPartitions.length>128
    ||target.checkedPartitions.some(p=>typeof p!=='string'||!p||p.length>512)||new Set(target.checkedPartitions).size!==target.checkedPartitions.length
    ||target.tables.some(t=>!target.checkedPartitions!.includes(t.partition))||target.partitions.some(p=>!target.checkedPartitions!.includes(p))))fail('history_target_unverified');
 return target;
}
function currentIncremental(tx:StorageTransaction,token:ReadEligibility,report:HistorySupportReport):StorageRow|undefined {
 const goal=tx.get("SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND kind='incremental' AND creation_no IS NOT NULL AND state IN ('running','incomplete') AND eligibility_json=? ORDER BY creation_no DESC,created_at DESC,id DESC LIMIT 1",[token.owner_id,token.contact_id,JSON.stringify(token)]);
 if(!goal)return undefined;
 if(goal.support_json!==serializeSupport(report))fail('history_support_changed');
 if(String(goal.accepted_barrier_generation)!==String(token.barrier_generation))fail('history_suppression_changed');
 const target=JSON.parse(String(goal.target_json)) as HistoryTarget;
 if(historyCursorScopeDigest(token,report,target)!==goal.cursor_scope_digest)fail('history_cursor_scope_changed');
 if(!goal.cursor)fail('history_cursor_invalid');
 return goal;
}
function sameStringSet(left:unknown,right:unknown):boolean {
 if(!Array.isArray(left)||!Array.isArray(right)||left.length!==right.length
  ||left.some(value=>typeof value!=='string'||!value)||right.some(value=>typeof value!=='string'||!value))return false;
 const a=[...left].sort(),b=[...right].sort();return a.every((value,index)=>value===b[index]);
}
function certifiedEmptyGoal(tx:StorageTransaction,token:ReadEligibility):{goalId:string;report:HistorySupportReport;target:HistoryTarget}|null {
 const goal=tx.get("SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND kind='history' AND creation_no IS NOT NULL ORDER BY creation_no DESC,created_at DESC,id DESC LIMIT 1",[token.owner_id,token.contact_id]);
 if(!goal||goal.state!=='complete'||goal.failure_code!==null||goal.resume_cursor!==null||String(goal.binding_id)!==token.binding_id
  ||String(goal.grant_id)!==token.grant_id||String(goal.accepted_data_generation)!==token.data_generation
  ||String(goal.accepted_barrier_generation)!==token.barrier_generation)return null;
 try{
  const storedToken=JSON.parse(String(goal.eligibility_json)) as ReadEligibility;
  if(!storedToken||Object.keys(token).some(key=>key!=='read_epoch'&&String(storedToken[key as keyof ReadEligibility])!==token[key as keyof ReadEligibility]))return null;
  const report=JSON.parse(String(goal.support_json)) as HistorySupportReport;
  const target=JSON.parse(String(goal.target_json)) as HistoryTarget;
  const completed=JSON.parse(String(goal.completed_partitions)) as unknown;
  if(!Array.isArray(completed)||!sameStringSet(completed,target.partitions)||!isCertifiedEmptyTarget(tx,storedToken,report,target))return null;
  const coverage=readCoverage(tx,token.owner_id,token.contact_id);
  if(coverage.goalId!==String(goal.id)||coverage.incremental?.emptyTargetAwaitingMessages!==true)return null;
  return {goalId:String(goal.id),report,target};
 }catch{return null;}
}
function sameEmptyTargetGeometry(left:HistoryTarget,right:HistoryTarget):boolean {
 return left.protocol==='private-history-v1'&&right.protocol==='private-history-v1'&&left.sourceGeneration===right.sourceGeneration
  &&Array.isArray(left.tables)&&left.tables.length===0&&Array.isArray(right.tables)&&right.tables.length===0
  &&sameStringSet(left.partitions,right.partitions)&&sameStringSet(left.checkedPartitions,right.checkedPartitions);
}
export const historyActions:StorageAction[]=[
 action('history.checkpointContacts','read',(tx,i)=>tx.all("SELECT id,data_generation FROM contact WHERE owner_id=? AND state='active'",[i.ownerId]).map(row=>({contactId:String(row.id),generation:String(row.data_generation)}))),
 action('history.scope','read',(tx,i)=>{assertReadEligibility(tx,i.token);const row=tx.get(`SELECT a.external_key AS account_key,c.external_key AS conversation_key FROM channel_account a JOIN channel_conversation c ON c.owner_id=a.owner_id AND c.account_id=a.id WHERE a.owner_id=? AND a.id=? AND c.id=?`,[i.token.owner_id,i.token.account_id,i.token.conversation_id])??fail('history_scope_invalid');return {token:i.token,accountKey:row.account_key,conversationKey:row.conversation_key};}),
 action('history.preflightGeneration','write',(tx,i)=>{const token=i.token as ReadEligibility;assertReadEligibility(tx,token);return preflightGeneration(tx,token);}),
 action('history.normalUseRevalidationCandidate','read',(tx,i)=>{const token=i.token as ReadEligibility;assertReadEligibility(tx,token);return normalUseRevalidationCandidate(tx,token);}),
 action('history.prepareNormalUseGuard','write',(tx,i)=>{
  const token=i.token as ReadEligibility;assertReadEligibility(tx,token);assertSupport(i.report);
  if(i.report.continuity!==normalUseContinuity||typeof i.guardId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(i.guardId))return {ok:false,revalidated:false};
  const target=targetOf(i.target,token,i.report);
  return prepareNormalUseTarget(tx,token,target,i.report as HistorySupportReport,i.guardId);
 }),
 action('history.guardAcquire','write',(tx,i)=>{
  const token=i.token as ReadEligibility;assertReadEligibility(tx,token);
  if(typeof i.guardId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(i.guardId))fail('history_guard_invalid');
  if(!preflightGeneration(tx,token))return false;
  const existing=tx.get('SELECT * FROM history_guard_lease WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  const runtime=tx.get('SELECT runtime_id FROM database_instance WHERE slot=1')!;
  if(existing){
   if(existing.state==='active'&&existing.runtime_id===runtime.runtime_id&&existing.binding_id===token.binding_id
    &&existing.conversation_id===token.conversation_id&&existing.source_generation===token.source_generation)return existing.guard_id===i.guardId;
   return fenceContinuity(tx,token);
  }
  // 旧数据没有持久守卫记录时，不把第一次启动视为连续的恢复。
  if(tx.get('SELECT 1 FROM read_goal WHERE owner_id=? AND contact_id=? LIMIT 1',[token.owner_id,token.contact_id]))return fenceContinuity(tx,token);
  tx.run("INSERT INTO history_guard_lease VALUES(?,?,?,?,?,?,?,'active')",[token.owner_id,token.contact_id,token.binding_id,token.conversation_id,token.source_generation,i.guardId,runtime.runtime_id]);
  return true;
 }),
 action('history.guardCheck','read',(tx,i)=>{
  const token=i.token as ReadEligibility;assertReadEligibility(tx,token);
  return Boolean(tx.get(`SELECT 1 FROM history_guard_lease g JOIN database_instance d ON d.slot=1 AND d.runtime_id=g.runtime_id
   WHERE g.owner_id=? AND g.contact_id=? AND g.binding_id=? AND g.conversation_id=? AND g.source_generation=? AND g.guard_id=? AND g.state='active'
   AND NOT EXISTS (SELECT 1 FROM history_continuity_fence f WHERE f.owner_id=g.owner_id AND f.contact_id=g.contact_id)`,[token.owner_id,token.contact_id,token.binding_id,token.conversation_id,token.source_generation,i.guardId]));
 }),
 action('history.guardAuthorize','read',(tx,i)=>{const token=i.token as ReadEligibility;assertReadEligibility(tx,token);assertLiveGuard(tx,token,i.guardId);return true;}),
 action('history.guardRelease','write',(tx,i)=>{
  const token=i.token as ReadEligibility;
  const guard=tx.get('SELECT * FROM history_guard_lease WHERE owner_id=? AND contact_id=? AND binding_id=? AND conversation_id=? AND source_generation=? AND guard_id=?',[token.owner_id,token.contact_id,token.binding_id,token.conversation_id,token.source_generation,i.guardId]);
  if(!guard)return false;
  tx.run("UPDATE history_guard_lease SET state='lost' WHERE owner_id=? AND contact_id=? AND guard_id=?",[token.owner_id,token.contact_id,i.guardId]);
  if(i.normalUse!==true||i.sourceLost===true)fenceContinuity(tx,token);return true;
 }),
 action('history.markContinuityLost','write',(tx,i)=>{const token=i.token as ReadEligibility;
  if(!tx.get("SELECT 1 FROM conversation_binding WHERE owner_id=? AND contact_id=? AND id=? AND state='verified'",[token.owner_id,token.contact_id,token.binding_id]))return false;
  const scope=tx.get('SELECT conversation_id,source_generation FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  if(scope?.conversation_id===token.conversation_id&&scope.source_generation===token.source_generation)return fenceContinuity(tx,token);
  return false;}),
 action('history.preflightContinuity','write',(tx,i)=>{const token=i.token as ReadEligibility;assertReadEligibility(tx,token);return preflightTarget(tx,token,targetOf(i.target,token,i.report),i.report);}),
 action('history.pending','read',(tx,i)=>{assertReadEligibility(tx,i.token);const goal=tx.get("SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND kind='history' AND creation_no IS NOT NULL AND state IN ('running','incomplete') AND eligibility_json=? ORDER BY creation_no DESC,created_at DESC,id DESC LIMIT 1",[i.token.owner_id,i.token.contact_id,JSON.stringify(i.token)]);if(goal&&goal.support_json!==serializeSupport(i.report))fail('history_support_changed');
  // 已到终页的固定快照不能反复接收新的完整扫描，否则旧出现会伪装本次仍存在。
  if(goal?.cursor===null&&goal.state==='incomplete')return null;
  return goal?{id:goal.id,target:JSON.parse(String(goal.target_json)),cursor:goal.cursor}:null;}),
 action('history.incrementalContinuityTarget','read',(tx,i)=>{const token=i.token as ReadEligibility;assertReadEligibility(tx,token);
  const goal=currentIncremental(tx,token,i.report)??tx.get("SELECT target_json FROM read_goal WHERE owner_id=? AND contact_id=? AND creation_no IS NOT NULL AND cursor_scope_digest IS NOT NULL AND ((kind='incremental' AND cursor IS NOT NULL AND (failure_code IS NULL OR failure_code<>'history_snapshot_replaced')) OR (kind='history' AND resume_cursor IS NOT NULL AND state='complete')) ORDER BY creation_no DESC,created_at DESC,id DESC LIMIT 1",[token.owner_id,token.contact_id]);
  return goal?targetOf(JSON.parse(String(goal.target_json)),token,i.report):null;}),
 action('history.resumeCheckpoint','read',(tx,i)=>{
  const token=i.token as ReadEligibility;assertReadEligibility(tx,token);assertSupport(i.report);
  if(i.report.continuity!==normalUseContinuity||i.report.capabilities?.durableIncremental!=='supported')return null;
  const goal=tx.get(`SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND binding_id=? AND grant_id=?
   AND accepted_data_generation=? AND accepted_barrier_generation=? AND creation_no IS NOT NULL AND cursor_scope_digest IS NOT NULL
   AND ((kind='incremental' AND cursor IS NOT NULL AND state IN ('running','incomplete'))
   OR (kind='history' AND state='complete' AND resume_cursor IS NOT NULL)
   OR (kind='history' AND state IN ('running','incomplete') AND cursor IS NOT NULL))
   ORDER BY creation_no DESC,created_at DESC,id DESC LIMIT 1`,[token.owner_id,token.contact_id,token.binding_id,token.grant_id,BigInt(token.data_generation),BigInt(token.barrier_generation)]);
  if(!goal)return null;
  let previousReport:HistorySupportReport;
  try{previousReport=JSON.parse(String(goal.support_json)) as HistorySupportReport;}catch{return null;}
  const supportSame=goal.support_json===serializeSupport(i.report);
  const supportGrowth=!supportSame&&isPartitionGrowthReportChange(previousReport,i.report);
  if(!supportSame&&!supportGrowth)return null;
  const target=targetOf(JSON.parse(String(goal.target_json)),token,previousReport);
  if(supportGrowth&&target.checkedPartitions===undefined)return null;
  assertHistoryReadBoundary(tx,token,{kind:'history'});assertSourceContinuity(tx,token,target,i.report.accountKey);
  if(historyCursorScopeDigest(token,previousReport,target)!==goal.cursor_scope_digest)return null;
  return {target,cursor:assertHistoryCursor(goal.kind==='history'&&goal.state==='complete'?goal.resume_cursor:goal.cursor,'history_cursor_invalid')};
 }),
 action('history.partitionGrowthCandidate','read',(tx,i)=>{
  const token=i.token as ReadEligibility;assertReadEligibility(tx,token);assertSupport(i.report);
  const previous=tx.get(`SELECT support_json FROM read_goal WHERE owner_id=? AND contact_id=? AND binding_id=? AND grant_id=?
   AND accepted_data_generation=? AND accepted_barrier_generation=? AND creation_no IS NOT NULL
   ORDER BY creation_no DESC,created_at DESC,id DESC LIMIT 1`,[token.owner_id,token.contact_id,token.binding_id,token.grant_id,BigInt(token.data_generation),BigInt(token.barrier_generation)]);
  try{return isPartitionGrowthTargetChange(JSON.parse(String(previous?.support_json)) as HistorySupportReport,i.report as HistorySupportReport);}catch{return false;}
 }),
 action('history.begin','write',(tx,i)=>{
  const token=i.token as ReadEligibility;assertReadEligibility(tx,token);assertSupport(i.report);
  const target=targetOf(i.target,token,i.report);assertHistoryReadBoundary(tx,token,{kind:'history'});if(i.recertifyId)assertRecertifyAccess(tx,token,i.recertifyId,i.guardId,target);else assertSourceContinuity(tx,token,target,i.report?.continuity===normalUseContinuity?i.report.accountKey:undefined);
  // 新固定快照会替换原生读取器中的目标；旧目标的增量游标不能再交给该读取器。
  tx.run("UPDATE read_goal SET state='invalidated',failure_code='history_snapshot_replaced' WHERE owner_id=? AND contact_id=? AND kind='incremental' AND state IN ('running','incomplete')",[token.owner_id,token.contact_id]);
  const scopeDigest=historyCursorScopeDigest(token,i.report,target);
  tx.run(`INSERT INTO read_goal(owner_id,id,contact_id,binding_id,grant_id,accepted_data_generation,accepted_barrier_generation,kind,target_protocol,target_descriptor,target_json,eligibility_json,support_json,state,coverage_state,created_at,cursor_scope_digest,cursor_scheme,creation_no) VALUES(?,?,?,?,?,?,?,'history',?,?,?,?,?,'running','partial',?,?,?,(SELECT coalesce(max(creation_no),0)+1 FROM read_goal WHERE creation_no IS NOT NULL))`,[token.owner_id,i.id,token.contact_id,token.binding_id,token.grant_id,BigInt(token.data_generation),BigInt(token.barrier_generation),target.protocol,target.descriptor,JSON.stringify(target),JSON.stringify(token),serializeSupport(i.report),i.at,scopeDigest,historyCursorScheme]);
  return {id:i.id,target,cursor:null};
 }),
 action('history.quarantinePageStates','write',(tx,i)=>{
  const token=i.token as ReadEligibility,goal=goalFor(tx,token.owner_id,i.goalId),page=i.page as HistoryPage|HistoryTailPage;
  if(goal.eligibility_json!==JSON.stringify(token)||goal.contact_id!==token.contact_id||goal.binding_id!==token.binding_id||!['history','incremental'].includes(String(goal.kind)))fail('history_goal_stale');
  const scope=tx.get('SELECT conversation_id,source_generation FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  if(scope?.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation)fail('history_source_continuity_unverified');
  const target=JSON.parse(String(goal.target_json)) as HistoryTarget;
  if(page?.target!==goal.target_descriptor||page.cursorIn!==goal.cursor||!Array.isArray(page.records)||page.records.length>1000)fail('history_page_invalid');
  const report=JSON.parse(String(goal.support_json)) as HistorySupportReport;
  const restoreOperationId=restoreOperationForGoal(tx,token.owner_id,String(goal.id))??null;
  const updatedMessageIds=quarantineUnverifiedRecords({tx,token,target,report,records:page.records,exclude:observed=>observed.localKey&&clearBoundaryExclusion(tx,{ownerId:token.owner_id,conversationId:token.conversation_id,externalKey:observed.localKey,restoreOperationId})?'clear_excluded':null});
  return {updatedMessageIds};
 }),
 action('history.acceptPage','write',(tx,i)=>{
  const token=i.token as ReadEligibility;const goal=currentGoal(tx,token,i.goalId);const page=i.page as HistoryPage;
  if(i.recertifyId)assertRecertifyAccess(tx,token,i.recertifyId,i.guardId,JSON.parse(String(goal.target_json)));else assertLiveGuard(tx,token,i.guardId);
  if(goal.kind!=='history')fail('history_goal_kind_invalid');
  const digest=createHash('sha256').update(JSON.stringify(page)).digest('hex');
  const prior=tx.get('SELECT response_digest,contact_id,goal_id,read_epoch,cursor_in,cursor_out FROM sync_capture WHERE owner_id=? AND id=?',[token.owner_id,i.captureId]);
  if(prior){assertCaptureReplay(prior,token,goal,digest,page?.cursorIn,page?.cursorOut);return readCoverage(tx,token.owner_id,token.contact_id);}
  if(goal.state!=='running'&&goal.state!=='incomplete')fail('history_goal_closed');
  assertHistoryReadBoundary(tx,token,{kind:'history'});
  const target=JSON.parse(String(goal.target_json)) as HistoryTarget;
  const report=JSON.parse(String(goal.support_json)) as HistorySupportReport;
  if(!i.recertifyId)assertSourceContinuity(tx,token,target,report.continuity===normalUseContinuity?report.accountKey:undefined);
  if(page?.target!==goal.target_descriptor||page.cursorIn!==goal.cursor||!Array.isArray(page.records)||page.records.length>1000||!Array.isArray(page.completedPartitions)||page.completedPartitions.some(p=>!target.partitions.includes(p))||typeof page.exhausted!=='boolean'||page.exhausted&&page.cursorOut!==null||!page.exhausted&&(typeof page.cursorOut!=='string'||!page.cursorOut||page.cursorOut===page.cursorIn))fail('history_page_invalid');
  const resumeCursor=page.resumeCursor===undefined||page.resumeCursor===null?null:assertHistoryCursor(page.resumeCursor,'history_page_invalid');
  if(resumeCursor!==null&&!page.exhausted)fail('history_page_invalid');
  if(verifiedAbsentTarget(report)&&(page.records.length!==0||resumeCursor!==null))fail('history_page_invalid');
  tx.run("INSERT INTO sync_capture(owner_id,id,contact_id,goal_id,read_epoch,runtime_token,captured_at,adapter_version,cursor_in,cursor_out,state,response_digest,acceptance_no) VALUES(?,?,?,?,?,?,?,?,?,?,'accepted',?,(SELECT coalesce(max(acceptance_no),0)+1 FROM sync_capture WHERE acceptance_no IS NOT NULL))",[token.owner_id,i.captureId,token.contact_id,goal.id,BigInt(token.read_epoch),i.runtimeToken,i.at,report.adapterVersion,page.cursorIn,page.cursorOut,digest]);
  const restoreOperationId=restoreOperationForGoal(tx,token.owner_id,String(goal.id))??null;
  const {quarantined,createdMessageIds,updatedMessageIds}=ingestRecords({tx,token,report,target,captureId:i.captureId,at:i.at,records:page.records,
   ...(i.recertifyId?{recertify:{operationId:i.recertifyId,guardId:i.guardId,goalId:String(goal.id)}}:{}),
   exclude:observed=>observed.localKey&&clearBoundaryExclusion(tx,{ownerId:token.owner_id,conversationId:token.conversation_id,externalKey:observed.localKey,restoreOperationId})?'clear_excluded':null});
  const partitions=new Set<string>([...JSON.parse(String(goal.completed_partitions)),...page.completedPartitions]);
  const traversalComplete=page.exhausted&&target.partitions.every(p=>partitions.has(p));
  const unresolved=quarantined||(i.recertifyId?Boolean(tx.get("SELECT 1 FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id WHERE c.owner_id=? AND c.goal_id=? AND r.state='quarantined' AND r.reason_code<>'metadata_only' LIMIT 1",[token.owner_id,goal.id])):unresolvedQuarantineCount(tx,token.owner_id,token.contact_id)>0);
  const complete=traversalComplete&&!unresolved;
  const state=complete?'complete':page.exhausted?'incomplete':'running';const code=unresolved?'history_identity_quarantined':page.exhausted&&!complete?'history_partitions_missing':null;
  if(quarantined)tx.run("UPDATE sync_capture SET state='quarantined',error_code='history_identity_quarantined' WHERE owner_id=? AND id=?",[token.owner_id,i.captureId]);
  tx.run('UPDATE read_goal SET cursor=?,completed_partitions=?,state=?,coverage_state=?,failure_code=? WHERE owner_id=? AND id=?',[page.cursorOut,JSON.stringify([...partitions]),state,complete?'complete':'partial',code,token.owner_id,goal.id]);
  // 历史终页与增量交接在同一事务：先固定保守续读游标及完整作用域证据，再原子创建增量目标，窗口内无缺口。
  if((complete||traversalComplete&&report.continuity===normalUseContinuity)&&resumeCursor!==null){
   const scopeDigest=historyCursorScopeDigest(token,report,target);
   tx.run('UPDATE read_goal SET resume_cursor=?,cursor_scope_digest=?,cursor_scheme=? WHERE owner_id=? AND id=?',[resumeCursor,scopeDigest,historyCursorScheme,token.owner_id,goal.id]);
   const existing=tx.get("SELECT id FROM read_goal WHERE owner_id=? AND contact_id=? AND kind='incremental' AND creation_no IS NOT NULL AND state IN ('running','incomplete') ORDER BY creation_no DESC,created_at DESC,id DESC LIMIT 1",[token.owner_id,token.contact_id]);
   if(!existing)tx.run(`INSERT INTO read_goal(owner_id,id,contact_id,binding_id,grant_id,accepted_data_generation,accepted_barrier_generation,kind,target_protocol,target_descriptor,target_json,eligibility_json,support_json,cursor,state,coverage_state,created_at,cursor_scope_digest,cursor_scheme,handoff_from_goal_id,pages_accepted,creation_no) VALUES(?,?,?,?,?,?,?,'incremental',?,?,?,?,?,?,'running','ready',?,?,?,?,0,(SELECT coalesce(max(creation_no),0)+1 FROM read_goal WHERE creation_no IS NOT NULL))`,
    [token.owner_id,randomUUID(),token.contact_id,token.binding_id,token.grant_id,BigInt(token.data_generation),BigInt(token.barrier_generation),target.protocol,target.descriptor,JSON.stringify(target),JSON.stringify(token),serializeSupport(report),resumeCursor,i.at,scopeDigest,historyCursorScheme,goal.id]);
  }
  if(complete)completeRestoreGoal(tx,token.owner_id,String(goal.id),i.at);
  const coverage=readCoverage(tx,token.owner_id,token.contact_id);
  return i.notifyMessageChanges===true?{...coverage,createdMessageIds,updatedMessageIds}:coverage;
 }),
 action('history.interrupt','write',(tx,i)=>{const goal=currentGoal(tx,i.token,i.goalId);if(goal.state==='running'||goal.state==='incomplete')tx.run("UPDATE read_goal SET state='incomplete',failure_code=? WHERE owner_id=? AND id=?",[i.code,i.token.owner_id,goal.id]);return readCoverage(tx,i.token.owner_id,i.token.contact_id);}),
 action('history.incrementalPending','read',(tx,i)=>{assertReadEligibility(tx,i.token);const goal=currentIncremental(tx,i.token,i.report);return goal?{id:String(goal.id),target:JSON.parse(String(goal.target_json)),cursor:String(goal.cursor)}:null;}),
 action('history.beginIncremental','write',(tx,i)=>{
  const token=i.token as ReadEligibility;const report=i.report as HistorySupportReport;assertReadEligibility(tx,token);assertSupport(report);
  assertHistoryReadBoundary(tx,token,{kind:'incremental'});
  const existing=currentIncremental(tx,token,report);
  if(existing)return {id:String(existing.id),target:JSON.parse(String(existing.target_json)),cursor:String(existing.cursor)};
  // 新历史目标尚未完成时，不能退回它已经替换的旧增量切面。
  const latestHistory=tx.get("SELECT state,resume_cursor FROM read_goal WHERE owner_id=? AND contact_id=? AND kind='history' AND creation_no IS NOT NULL ORDER BY creation_no DESC LIMIT 1",[token.owner_id,token.contact_id]);
  if(latestHistory&&(latestHistory.state!=='complete'||latestHistory.resume_cursor===null))fail('history_incremental_not_ready');
  // 只从同一完整作用域的既有检查点续读；来源/账号/分片/目标/语义变化会失配并显式停止。
  const resumable=tx.get(`SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND creation_no IS NOT NULL AND cursor_scope_digest IS NOT NULL AND ((kind='incremental' AND cursor IS NOT NULL AND (failure_code IS NULL OR failure_code<>'history_snapshot_replaced')) OR (kind='history' AND resume_cursor IS NOT NULL AND state='complete')) ORDER BY creation_no DESC,created_at DESC,id DESC LIMIT 1`,[token.owner_id,token.contact_id]);
  if(!resumable)fail('history_incremental_not_ready');
  const target=targetOf(JSON.parse(String(resumable.target_json)),token,report);
  assertSourceContinuity(tx,token,target,report.continuity===normalUseContinuity?report.accountKey:undefined);
  const scopeDigest=historyCursorScopeDigest(token,report,target);
  if(resumable.cursor_scope_digest!==scopeDigest)fail('history_cursor_scope_changed');
  if(String(resumable.accepted_barrier_generation)!==String(token.barrier_generation))fail('history_suppression_changed');
  const cursor=assertHistoryCursor(resumable.kind==='incremental'?resumable.cursor:resumable.resume_cursor,'history_cursor_invalid');
  // 旧执行不复活：旧增量目标标记失效，新资格建立新目标，检查点只作为续读位置。
  tx.run("UPDATE read_goal SET state='invalidated',failure_code='history_eligibility_changed' WHERE owner_id=? AND contact_id=? AND kind='incremental' AND creation_no IS NOT NULL AND state IN ('running','incomplete')",[token.owner_id,token.contact_id]);
  const id=i.id as string;
  tx.run(`INSERT INTO read_goal(owner_id,id,contact_id,binding_id,grant_id,accepted_data_generation,accepted_barrier_generation,kind,target_protocol,target_descriptor,target_json,eligibility_json,support_json,cursor,state,coverage_state,created_at,cursor_scope_digest,cursor_scheme,handoff_from_goal_id,pages_accepted,creation_no) VALUES(?,?,?,?,?,?,?,'incremental',?,?,?,?,?,?,'running','partial',?,?,?,?,0,(SELECT coalesce(max(creation_no),0)+1 FROM read_goal WHERE creation_no IS NOT NULL))`,
   [token.owner_id,id,token.contact_id,token.binding_id,token.grant_id,BigInt(token.data_generation),BigInt(token.barrier_generation),target.protocol,target.descriptor,JSON.stringify(target),JSON.stringify(token),serializeSupport(report),cursor,i.at,scopeDigest,historyCursorScheme,resumable.id]);
  return {id,target,cursor};
 }),
 action('history.acceptIncrementalPage','write',(tx,i)=>{
  const token=i.token as ReadEligibility;const goal=currentGoal(tx,token,i.goalId);const page=i.page as HistoryTailPage;
  assertLiveGuard(tx,token,i.guardId);
  if(goal.kind!=='incremental')fail('history_goal_kind_invalid');
  const digest=createHash('sha256').update(JSON.stringify(page)).digest('hex');
  const prior=tx.get('SELECT response_digest,contact_id,goal_id,read_epoch,cursor_in,cursor_out FROM sync_capture WHERE owner_id=? AND id=?',[token.owner_id,i.captureId]);
  if(prior){const cursorOut=assertHistoryCursor(page?.cursorOut,'history_page_invalid');assertCaptureReplay(prior,token,goal,digest,page?.cursorIn,cursorOut);return readCoverage(tx,token.owner_id,token.contact_id);}
  if(goal.state!=='running'&&goal.state!=='incomplete')fail('history_goal_closed');
  assertHistoryReadBoundary(tx,token,{kind:'incremental'});
  if(String(goal.accepted_barrier_generation)!==String(token.barrier_generation))fail('history_suppression_changed');
  const target=JSON.parse(String(goal.target_json)) as HistoryTarget;
  const report=JSON.parse(String(goal.support_json)) as HistorySupportReport;
  assertSourceContinuity(tx,token,target,report.continuity===normalUseContinuity?report.accountKey:undefined);
  if(page?.target!==goal.target_descriptor||page.cursorIn!==goal.cursor||!Array.isArray(page.records)||page.records.length>1000||typeof page.cursorOut!=='string'||(page.cursorOut===page.cursorIn&&page.caughtUp===false)||typeof page.caughtUp!=='boolean')fail('history_page_invalid');
  const cursorOut=assertHistoryCursor(page.cursorOut,'history_page_invalid');
  if(historyCursorScopeDigest(token,report,target)!==goal.cursor_scope_digest)fail('history_cursor_scope_changed');
  tx.run("INSERT INTO sync_capture(owner_id,id,contact_id,goal_id,read_epoch,runtime_token,captured_at,adapter_version,cursor_in,cursor_out,state,response_digest,acceptance_no) VALUES(?,?,?,?,?,?,?,?,?,?,'accepted',?,(SELECT coalesce(max(acceptance_no),0)+1 FROM sync_capture WHERE acceptance_no IS NOT NULL))",[token.owner_id,i.captureId,token.contact_id,goal.id,BigInt(token.read_epoch),i.runtimeToken,i.at,report.adapterVersion,page.cursorIn,cursorOut,digest]);
  const incrementalRestoreId=restoreOperationForGoal(tx,token.owner_id,String(goal.id))??null;
  const {quarantined,createdMessageIds,updatedMessageIds}=ingestRecords({tx,token,report,target,captureId:i.captureId,at:i.at,records:page.records,
   exclude:observed=>observed.localKey&&clearBoundaryExclusion(tx,{ownerId:token.owner_id,conversationId:token.conversation_id,externalKey:observed.localKey,restoreOperationId:incrementalRestoreId})?'clear_excluded':null});
  if(quarantined)tx.run("UPDATE sync_capture SET state='quarantined',error_code='history_identity_quarantined' WHERE owner_id=? AND id=?",[token.owner_id,i.captureId]);
  // 成功接受的一页同时恢复目标为运行态：此前的中断原因不再代表当前状态。
  tx.run("UPDATE read_goal SET cursor=?,pages_accepted=pages_accepted+1,last_accepted_at=?,coverage_state=?,state=?,failure_code=? WHERE owner_id=? AND id=?",[cursorOut,BigInt(i.at),quarantined?'partial':page.caughtUp?'caught_up':'partial',quarantined?'incomplete':'running',quarantined?'history_identity_quarantined':null,token.owner_id,goal.id]);
  const coverage=readCoverage(tx,token.owner_id,token.contact_id);
  return i.notifyMessageChanges===true?{...coverage,createdMessageIds,updatedMessageIds}:coverage;
 }),
 action('history.incrementalInterrupt','write',(tx,i)=>{
  const goal=tx.get('SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND id=?',[i.ownerId,i.contactId,i.goalId])??fail('history_goal_not_found');
  if(goal.kind!=='incremental')fail('history_goal_kind_invalid');
  if(goal.state==='running'||goal.state==='incomplete')tx.run('UPDATE read_goal SET state=?,failure_code=? WHERE owner_id=? AND id=?',[i.invalidated===true?'invalidated':'incomplete',i.code,i.ownerId,i.goalId]);
  return readCoverage(tx,i.ownerId,i.contactId);
 }),
 action('history.source','read',(tx,i)=>{
  readCoverage(tx,i.ownerId,i.contactId);
  const row=tx.get(`WITH ${currentSourceScopeCTE} SELECT r.*,m.text_body AS message_text,c.goal_id,c.captured_at,c.adapter_version,c.cursor_in,c.cursor_out,g.support_json
   FROM capture_record r JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id
   JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
   JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
   WHERE r.owner_id=? AND r.contact_id=? AND r.id=? AND r.state='normalized' AND r.availability='available' AND m.availability='available'
   AND NOT EXISTS (SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)
   AND NOT EXISTS (SELECT 1 FROM history_continuity_fence f WHERE f.owner_id=m.owner_id AND f.contact_id=m.contact_id)
   AND NOT EXISTS (SELECT 1 FROM history_guard_lease l JOIN database_instance d ON d.slot=1 WHERE l.owner_id=m.owner_id AND l.contact_id=m.contact_id AND (l.state<>'active' OR l.runtime_id<>d.runtime_id))
   AND ${currentSourcePredicate()}`,[i.ownerId,i.contactId,i.contactId,i.ownerId,i.contactId,i.recordId])??fail('history_source_not_found');
  const raw=JSON.parse(String(row.raw_payload));
  if(row.normalizer_version==='2'&&raw.kind==='text')raw.text=row.message_text;
  return {recordId:row.id,contactId:row.contact_id,messageId:row.message_id,captureId:row.capture_id,goalId:row.goal_id,
   itemNo:Number(row.item_no),capturedAt:String(row.captured_at),adapterVersion:row.adapter_version,normalizerVersion:row.normalizer_version,
   cursorIn:row.cursor_in,cursorOut:row.cursor_out,raw,support:JSON.parse(String(row.support_json))};
 }),
 action('history.coverage','read',(tx,i)=>readCoverage(tx,i.ownerId,i.contactId)),
 action('history.emptyTargetProbeCandidate','read',(tx,i)=>{const token=i.token as ReadEligibility;assertReadEligibility(tx,token);assertHistoryReadBoundary(tx,token,{kind:'history'});return certifiedEmptyGoal(tx,token);}),
 action('history.emptyTargetProbeVerify','write',(tx,i)=>{const token=i.token as ReadEligibility;assertReadEligibility(tx,token);
  assertHistoryReadBoundary(tx,token,{kind:'history'});
  const candidate=certifiedEmptyGoal(tx,token);if(!candidate||candidate.goalId!==i.goalId||serializeSupport(candidate.report)!==serializeSupport(i.report as HistorySupportReport))return false;
  const target=targetOf(i.target,token,i.report as HistorySupportReport);
  if(sameEmptyTargetGeometry(candidate.target,target)&&isCertifiedEmptyTarget(tx,token,i.report as HistorySupportReport,target))return true;
  preflightTarget(tx,token,target,i.report as HistorySupportReport);
  return false;
 }),
  action('history.coverages','read',(tx,i)=>{
   if(!Array.isArray(i.contactIds)||i.contactIds.length>16||i.contactIds.some((id:unknown)=>typeof id!=='string'||!id||id.length>128)||new Set(i.contactIds).size!==i.contactIds.length)fail('history_request_invalid');
   return i.contactIds.map((contactId:string)=>readCoverage(tx,i.ownerId,contactId));
  }),
 action('history.read','read',(tx,i)=>readMessages(tx,i.ownerId,i.contactId,i.limit,i.before)),
 action('history.readChat','read',(tx,i)=>readChatMessages(tx,i.ownerId,i.contactId,i.limit,i.before)),
 action('history.imageMedia','read',(tx,i)=>{
  if(typeof i.ownerId!=='string'||!i.ownerId||typeof i.contactId!=='string'||!i.contactId||!Array.isArray(i.messageIds)
   ||i.messageIds.length>100||i.messageIds.some((value:unknown)=>typeof value!=='string'||!/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value))
   ||new Set(i.messageIds).size!==i.messageIds.length)fail('history_request_invalid');
  if(!i.messageIds.length)return [];
  return tx.all(`WITH ${currentSourceScopeCTE} SELECT m.id message_id,mm.state media_state,a.state attempt_state,a.error_code,
   f.id file_id,f.mime_type,f.image_quality FROM message m
   JOIN contact active_contact ON active_contact.owner_id=m.owner_id AND active_contact.id=m.contact_id AND active_contact.state='active'
   JOIN owner active_owner ON active_owner.owner_id=m.owner_id AND active_owner.state='active'
   LEFT JOIN message_media mm ON mm.owner_id=m.owner_id AND mm.contact_id=m.contact_id AND mm.message_id=m.id
   LEFT JOIN media_extraction_attempt a ON a.owner_id=m.owner_id AND a.contact_id=m.contact_id AND a.message_id=m.id
    AND a.attempt_no=(SELECT max(last.attempt_no) FROM media_extraction_attempt last WHERE last.owner_id=m.owner_id AND last.contact_id=m.contact_id AND last.message_id=m.id)
   LEFT JOIN media_file f ON f.owner_id=m.owner_id AND f.contact_id=m.contact_id AND f.message_id=m.id AND f.role='image_display'
    AND f.publish_state='current' AND f.content_state='present' AND f.container_valid=1 AND f.viewable=1
   WHERE m.owner_id=? AND m.contact_id=? AND m.kind='image' AND m.availability='available'
    AND m.id IN (${i.messageIds.map(()=>'?').join(',')})
    AND NOT EXISTS(SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)
    AND EXISTS(SELECT 1 FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id
      JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE r.owner_id=m.owner_id AND r.contact_id=m.contact_id
      AND r.message_id=m.id AND r.state='normalized' AND r.availability='available' AND ${currentSourcePredicate()})
   ORDER BY m.display_no DESC`,[i.ownerId,i.contactId,i.contactId,i.ownerId,i.contactId,...i.messageIds]);
 }),
 action('history.readRecent','read',(tx,i)=>readRecentMessages(tx,i.ownerId,i.contactId,i.limit)),
];
