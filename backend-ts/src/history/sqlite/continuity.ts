import { StorageFailure, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistorySupportReport, HistoryTarget } from './contracts.ts';
import { historyTargetTransition, isPartitionGrowthTargetChange, type HistoryTargetTransition } from '../partition-growth.ts';
import { reusableEmptyGoals,serializeSupport } from './goal-reuse.ts';
import {historyCursorScopeDigest} from './cursor.ts';
import {getProof,incompleteLegacySource,isSourceBlocked,fenceSource,putScope,deleteProof} from './source-proof.ts';
import {getSourceGuard,putSourceGuard} from './source-guard.ts';

const reason = 'history_source_continuity_unverified';
export const normalUseContinuity = 'same-source-instances-normal-use-v1';
const lostCodes=new Set(['history_account_changed','history_source_changed','history_external_scope_changed','history_scope_changed','history_schema_changed','history_shards_changed','history_cursor_scope_changed','history_support_changed','history_target_unverified','history_quote_source_changed']);
export const isSourceContinuityLost=(error:unknown):boolean=>error instanceof StorageFailure&&lostCodes.has(error.code);
function tables(target: HistoryTarget): string {
 const value:{partitions:string[];tables:[string,string][];checkedPartitions?:string[]}={
  partitions:[...target.partitions].sort(),tables:target.tables.map(t=>[t.partition,t.instance] as [string,string]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
 };
 if(target.checkedPartitions!==undefined)value.checkedPartitions=[...target.checkedPartitions].sort();
 return JSON.stringify(value);
}
function identity(target:HistoryTarget,accountKey?:string):string {
 const value=JSON.parse(tables(target)) as {partitions:string[];tables:[string,string][]};
 return accountKey===undefined?JSON.stringify(value):JSON.stringify({accountKey,...value});
}
function matchesStored(stored:string,target:HistoryTarget,accountKey?:string,requireAccountKey=false):boolean {
 try{
  const value=JSON.parse(stored) as {accountKey?:unknown;partitions?:unknown;tables?:unknown;checkedPartitions?:unknown};
  if(!Array.isArray(value.partitions)||!Array.isArray(value.tables)
    ||value.partitions.some(partition=>typeof partition!=='string'||!partition)
    ||value.tables.some(row=>!Array.isArray(row)||row.length!==2||row.some(item=>typeof item!=='string'||!item)))return false;
  if(requireAccountKey&&value.accountKey!==accountKey||accountKey!==undefined&&value.accountKey!==undefined&&value.accountKey!==accountKey)return false;
  const previous:HistoryTarget={protocol:'private-history-v1',descriptor:'stored',sourceGeneration:target.sourceGeneration,
   partitions:value.partitions as string[],tables:(value.tables as [string,string][]).map(([partition,instance])=>({partition,instance})),
   ...(value.checkedPartitions===undefined?{}:{checkedPartitions:Array.isArray(value.checkedPartitions)?value.checkedPartitions as string[]:[]})};
  const transition=historyTargetTransition(previous,target,false);
  return transition==='same'||transition==='legacy-exact-upgrade';
 }catch{return false;}
}
function storedTarget(stored:string,sourceGeneration:string):{target:HistoryTarget;accountKey?:unknown}|null {
 try{
  const value=JSON.parse(stored) as {accountKey?:unknown;partitions?:unknown;tables?:unknown;checkedPartitions?:unknown};
  if(!Array.isArray(value.partitions)||!Array.isArray(value.tables)||value.partitions.some(item=>typeof item!=='string'||!item)
    ||value.tables.some(row=>!Array.isArray(row)||row.length!==2||row.some(item=>typeof item!=='string'||!item))
    ||value.checkedPartitions!==undefined&&(!Array.isArray(value.checkedPartitions)||value.checkedPartitions.some(item=>typeof item!=='string'||!item)))return null;
  return {accountKey:value.accountKey,target:{protocol:'private-history-v1',descriptor:'stored',sourceGeneration,
   partitions:value.partitions as string[],tables:(value.tables as [string,string][]).map(([partition,instance])=>({partition,instance})),
   ...(value.checkedPartitions===undefined?{}:{checkedPartitions:value.checkedPartitions as string[]})}};
 }catch{return null;}
}
export const fenceContinuity=fenceSource;
const continuityArtifacts: readonly [string, string][] = [
  ['read_goal', 'contact_id'], ['sync_capture', 'contact_id'], ['capture_record', 'contact_id'],
  ['message', 'contact_id'], ['message_alias', 'contact_id'], ['history_message_quarantine', 'contact_id'],
  ['history_deletion_fence', 'contact_id'], ['history_source_exclusion', 'conversation_id'],
  ['history_cutoff', 'conversation_id'], ['history_cutoff_member', 'conversation_id'], ['history_restore', 'conversation_id'],
];
function existingTables(tx: StorageTransaction): Set<string> {
  return new Set(tx.all("SELECT name FROM sqlite_schema WHERE type='table'").map(row=>String(row.name)));
}
function hasHistoryOrSuppression(tx: StorageTransaction, token: ReadEligibility, tables: ReadonlySet<string>): boolean {
  return continuityArtifacts.some(([table, column]) => tables.has(table)&&tx.get(`SELECT 1 FROM ${table} WHERE owner_id=? AND ${column}=? LIMIT 1`,
    [token.owner_id, column === 'contact_id' ? token.contact_id : token.conversation_id]));
}
/** 空范围没有正文或删除保护时才可重置；守卫失去本身不改变已存来源事实。 */
function rearmEmptyContinuity(tx:StorageTransaction,token:ReadEligibility,tables:ReadonlySet<string>):boolean {
 if(!tables.has('source_proof'))return false;
 const scope=getProof(tx,token.owner_id,token.contact_id),guard=getSourceGuard(tx,token.owner_id,token.contact_id);
 const identityChanged=Boolean(scope&&(scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation));
 if(scope?.reason===incompleteLegacySource||!(scope?.state==='needs_confirmation'||guard?.state==='lost'||identityChanged)||guard?.state==='active'||scope&&scope.tables_json!=='')return false;
 if(hasHistoryOrSuppression(tx,token,tables))return false;
 deleteProof(tx,token.owner_id,token.contact_id);return true;
}
/** 持久事实只因身份或来源基线失配而围栏；运行守卫缺失由读取入口重验。 */
export function preflightGeneration(tx:StorageTransaction,token:ReadEligibility):boolean {
 const tables=existingTables(tx);if(!tables.has('source_proof'))return false;
 if(rearmEmptyContinuity(tx,token,tables))return true;
 const scope=getProof(tx,token.owner_id,token.contact_id);if(scope?.state==='needs_confirmation')return false;
 if(scope){
  if(scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation)return fenceContinuity(tx,token,'G02');
  if(!scope.tables_json&&hasHistoryOrSuppression(tx,token,tables))return fenceContinuity(tx,token,'G03');
  return true;
 }
 return hasHistoryOrSuppression(tx,token,tables)?fenceContinuity(tx,token,'G04'):true;
}
export function preflightTarget(tx:StorageTransaction,token:ReadEligibility,target:HistoryTarget,report?:{continuity?:string;accountKey?:string}):boolean {
 if(!preflightGeneration(tx,token))return false;
 const existing=getProof(tx,token.owner_id,token.contact_id),named=report?.continuity===normalUseContinuity;
 const accountKey=named?report.accountKey:undefined,value=identity(target,accountKey);
 if(!existing||!existing.tables_json){
  if(hasHistoryOrSuppression(tx,token,existingTables(tx)))return fenceContinuity(tx,token,'T01');
  putScope(tx,token,value,{...(accountKey?{accountKey}:{}),...(named?{checkedAt:Date.now()}:{} )});return true;
 }
 const previous=storedTarget(existing.tables_json,token.source_generation);
 const transition=previous&&(accountKey===undefined||previous.accountKey===accountKey)?historyTargetTransition(previous.target,target,false):null;
 if(transition==='same'||transition==='legacy-exact-upgrade'){
  putScope(tx,token,value,{...(accountKey?{accountKey}:{}),...(named?{checkedAt:Date.now()}:{} )});return true;
 }
 return fenceContinuity(tx,token,'T02');
}
/** 有明确顺序时使用最新支持档；旧目标无顺序时只使用已核验的账号和来源基线。 */
function priorNormalUse(tx:StorageTransaction,token:ReadEligibility,stored:string):boolean {
 const previous=tx.get("SELECT creation_no,support_json FROM read_goal WHERE owner_id=? AND contact_id=? ORDER BY creation_no DESC,created_at DESC,id DESC LIMIT 1",[token.owner_id,token.contact_id]);
 if(previous?.creation_no!==null&&previous?.creation_no!==undefined){
  try{return JSON.parse(String(previous.support_json)).continuity===normalUseContinuity;}catch{return false;}
 }
 const account=tx.get("SELECT external_key FROM channel_account WHERE owner_id=? AND id=? AND identity_state='verified'",[token.owner_id,token.account_id]);
 try{
  const value=JSON.parse(stored) as {accountKey?:unknown;partitions?:unknown;tables?:unknown};
  if(typeof account?.external_key!=='string'||!account.external_key||value.accountKey!==account.external_key||!Array.isArray(value.partitions)||!Array.isArray(value.tables)
   ||!value.partitions.length||value.partitions.some((p:unknown)=>typeof p!=='string'||!p)
   ||value.tables.some((row:unknown)=>!Array.isArray(row)||row.length!==2||row.some((v:unknown)=>typeof v!=='string'||!v)))return false;
 const target={protocol:'private-history-v1' as const,descriptor:'',sourceGeneration:token.source_generation,partitions:value.partitions as string[],tables:value.tables.map(([partition,instance]:string[])=>({partition,instance})),
  ...(Array.isArray((value as {checkedPartitions?:unknown}).checkedPartitions)?{checkedPartitions:(value as {checkedPartitions:string[]}).checkedPartitions}:{})};
  return matchesStored(stored,target,account.external_key,true);
 }catch{return false;}
}
/** 已知来源的待确认或未持守卫状态都先核元数据，不把重启当作来源变化。 */
export function normalUseRevalidationCandidate(tx:StorageTransaction,token:ReadEligibility):boolean {
 const scope=getProof(tx,token.owner_id,token.contact_id),guard=getSourceGuard(tx,token.owner_id,token.contact_id);
 const runtime=tx.get('SELECT runtime_id FROM database_instance WHERE slot=1');
 if(!scope||scope.reason===incompleteLegacySource||scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation||!scope.tables_json)return false;
 if(scope.state==='ok'&&guard?.state==='active'&&guard.runtime_id===runtime?.runtime_id&&guard.binding_id===token.binding_id
  &&guard.conversation_id===token.conversation_id&&guard.source_generation===token.source_generation)return false;
 return priorNormalUse(tx,token,scope.tables_json);
}
export interface ResumedCheckpoint {goalId:string;cursor:string;target:HistoryTarget}
/** 仅保留读取器已实际恢复、且事务内仍是同一最新身份与游标的持久增量目标。 */
function resumedIncrementalGoal(tx:StorageTransaction,token:ReadEligibility,target:HistoryTarget,report:HistorySupportReport,resume:ResumedCheckpoint|undefined):{id:string}|undefined {
 if(!resume||report.capabilities?.durableIncremental!=='supported'||typeof resume.goalId!=='string'||typeof resume.cursor!=='string'||!resume.target)return;
 // 原生恢复会为本轮差异快照分配新 descriptor；保留的是原恢复点事实，不能把旧游标当成本轮 tail。
 if(!historyTargetTransition(resume.target,target,false))return;
 const goal=tx.get(`SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND creation_no IS NOT NULL ORDER BY creation_no DESC,created_at DESC,id DESC LIMIT 1`,[token.owner_id,token.contact_id]);
 if(!goal||goal.id!==resume.goalId||goal.kind!=='incremental'||goal.cursor!==resume.cursor
  ||!(['running','incomplete'].includes(String(goal.state))||goal.state==='invalidated'&&goal.failure_code==='history_runtime_revalidated')
  ||goal.binding_id!==token.binding_id||goal.grant_id!==token.grant_id
  ||goal.accepted_data_generation!==BigInt(token.data_generation)||goal.accepted_barrier_generation!==BigInt(token.barrier_generation)
  ||goal.eligibility_json!==JSON.stringify(token)||goal.support_json!==serializeSupport(report)||goal.target_json!==JSON.stringify(resume.target)
  ||goal.cursor_scope_digest!==historyCursorScopeDigest(token,report,resume.target))return;
 return {id:String(goal.id)};
}
/** 当前元数据通过后更新唯一事实，并在同一事务发布本次读取的易失守卫。 */
export function prepareNormalUseTarget(tx:StorageTransaction,token:ReadEligibility,target:HistoryTarget,report:HistorySupportReport,guardId:string,verifiedRecovery=false,resume?:ResumedCheckpoint):{ok:boolean;revalidated:boolean;resumedGoalId?:string} {
 const runtime=tx.get('SELECT runtime_id FROM database_instance WHERE slot=1'),accountKey=report.accountKey;
 if(!runtime?.runtime_id||!accountKey||!guardId)return {ok:false,revalidated:false};
 const scope=getProof(tx,token.owner_id,token.contact_id),guard=getSourceGuard(tx,token.owner_id,token.contact_id);
 if(scope?.state==='needs_confirmation')return {ok:false,revalidated:false};
 const expected=tx.get(`SELECT a.external_key account_key,c.external_key conversation_key FROM channel_account a
  JOIN channel_conversation c ON c.owner_id=a.owner_id AND c.account_id=a.id WHERE a.owner_id=? AND a.id=? AND c.id=?`,[token.owner_id,token.account_id,token.conversation_id]);
 if(!expected||expected.account_key!==accountKey)return {ok:fenceContinuity(tx,token,'N03'),revalidated:false};
 if(expected.conversation_key!==report.conversationKey||report.sourceGeneration!==token.source_generation
  ||scope&&(scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation))return {ok:fenceContinuity(tx,token,'N02'),revalidated:false};
 let transition:HistoryTargetTransition|null=null;
 if(scope?.tables_json){
  const previous=storedTarget(scope.tables_json,token.source_generation);
  if(!previous||previous.accountKey!==accountKey)return {ok:fenceContinuity(tx,token,'N03'),revalidated:false};
  transition=historyTargetTransition(previous.target,target,verifiedRecovery&&report.capabilities?.partitionGrowth==='supported'||priorPartitionGrowth(tx,token,report));
  if(transition===null)return {ok:fenceContinuity(tx,token,'N04'),revalidated:false};
 }else if(hasHistoryOrSuppression(tx,token,existingTables(tx)))return {ok:fenceContinuity(tx,token,'N05'),revalidated:false};
 const active=guard?.state==='active'&&guard.runtime_id===runtime.runtime_id;
 if(active&&(guard.guard_id!==guardId||guard.binding_id!==token.binding_id||guard.conversation_id!==token.conversation_id||guard.source_generation!==token.source_generation))return {ok:false,revalidated:false};
 const revalidated=Boolean(scope?.tables_json)&&!active;
 if(revalidated&&!verifiedRecovery&&!priorNormalUse(tx,token,scope!.tables_json))return {ok:fenceContinuity(tx,token,'N06'),revalidated:false};
 const resumed=resumedIncrementalGoal(tx,token,target,report,resume),resumedGoalId=resumed?.id;
 putScope(tx,token,identity(target,accountKey),{accountKey,conversationKey:report.conversationKey,state:'ok',checkedAt:Date.now()});
 if(revalidated){
  const keepIds=[...new Set([...reusableEmptyGoals(tx,token,report,target).map(goal=>goal.id),...(resumedGoalId?[resumedGoalId]:[])])];
  // 已接受终页但仍含未知行的是持久遍历事实，不属于需要作废的活快照；在原 UPDATE 内判定，避免加载历史池重算摘要。
  const terminalHistory=`kind='history' AND state='incomplete' AND cursor IS NULL AND resume_cursor IS NOT NULL
   AND eligibility_json=? AND support_json=? AND json_remove(target_json,'$.descriptor')=json_remove(?,'$.descriptor')
   AND EXISTS (SELECT 1 FROM sync_capture c WHERE c.owner_id=read_goal.owner_id AND c.goal_id=read_goal.id)
   AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(target_json,'$.partitions')) p
    WHERE NOT EXISTS (SELECT 1 FROM json_each(completed_partitions) done WHERE done.value=p.value))`;
  tx.run(`UPDATE read_goal SET state='invalidated',failure_code='history_runtime_revalidated'
   WHERE owner_id=? AND contact_id=? AND kind IN ('history','incremental') AND state IN ('running','incomplete')
   ${keepIds.length?`AND id NOT IN (${keepIds.map(()=>'?').join(',')})`:''} AND NOT (${terminalHistory})`,
   [token.owner_id,token.contact_id,...keepIds,JSON.stringify(token),serializeSupport(report),JSON.stringify(target)]);
 }
 putSourceGuard(tx,{owner_id:token.owner_id,contact_id:token.contact_id,binding_id:token.binding_id,conversation_id:token.conversation_id,
  source_generation:token.source_generation,guard_id:guardId,runtime_id:String(runtime.runtime_id),state:'active'});
 if(resumedGoalId)tx.run("UPDATE read_goal SET state='running',failure_code=NULL WHERE owner_id=? AND id=? AND state='invalidated' AND failure_code='history_runtime_revalidated'",[token.owner_id,resumedGoalId]);
 return {ok:true,revalidated,...(resumedGoalId?{resumedGoalId}:{})};
}
function priorPartitionGrowth(tx:StorageTransaction,token:ReadEligibility,current:HistorySupportReport):boolean {
 const previous=tx.get(`SELECT support_json FROM read_goal WHERE owner_id=? AND contact_id=? AND binding_id=? AND grant_id=?
  AND accepted_data_generation=? AND accepted_barrier_generation=? AND creation_no IS NOT NULL
  ORDER BY creation_no DESC,created_at DESC,id DESC LIMIT 1`,[token.owner_id,token.contact_id,token.binding_id,token.grant_id,BigInt(token.data_generation),BigInt(token.barrier_generation)]);
 try{return isPartitionGrowthTargetChange(JSON.parse(String(previous?.support_json)) as HistorySupportReport,current);}catch{return false;}
}
/** 接受页的事务复验不改变围栏；失证应由预检先行持久化。 */
export function assertSourceContinuity(tx: StorageTransaction, token: ReadEligibility, target: HistoryTarget,accountKey?:string): void {
  if(isSourceBlocked(tx,token.owner_id,token.contact_id))throw new StorageFailure(reason);
  const scope=getProof(tx,token.owner_id,token.contact_id);
  if(!scope||scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation||!matchesStored(String(scope.tables_json),target,accountKey,accountKey!==undefined))throw new StorageFailure(reason);
}
/** 仅用于寻找旧恢复点：已核验范围可包含旧目标之后新增的表；后续原生目标与页提交仍走严格连续性核验。 */
export function assertCheckpointSourceContinuity(tx:StorageTransaction,token:ReadEligibility,target:HistoryTarget,accountKey:string,acceptedGrowth:boolean):void {
 if(!acceptedGrowth){assertSourceContinuity(tx,token,target,accountKey);return;}
 if(isSourceBlocked(tx,token.owner_id,token.contact_id))throw new StorageFailure(reason);
 const scope=getProof(tx,token.owner_id,token.contact_id);
 if(!scope||scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation)throw new StorageFailure(reason);
 if(matchesStored(String(scope.tables_json),target,accountKey,true))return;
 const current=storedTarget(String(scope.tables_json),token.source_generation);
 if(!current||current.accountKey!==accountKey||historyTargetTransition(target,current.target,true)!=='growth')throw new StorageFailure(reason);
}
/** 普通来源页必须持有当前进程守卫；旧无守卫渠道只保留其原有合同。 */
export function assertLiveGuard(tx:StorageTransaction,token:ReadEligibility,guardId:unknown):void {
 const guard=getSourceGuard(tx,token.owner_id,token.contact_id);
 if(!guard){
  const proof=getProof(tx,token.owner_id,token.contact_id);
  let normal=false;try{normal=typeof JSON.parse(proof?.tables_json??'{}').accountKey==='string';}catch{/* 损坏事实由连续性预检拒绝。 */}
  if(guardId!==undefined&&guardId!==null||normal)throw new StorageFailure(reason);
  return;
 }
 const runtime=tx.get('SELECT runtime_id FROM database_instance WHERE slot=1');
 if(guard.state!=='active'||guard.runtime_id!==runtime?.runtime_id||guard.binding_id!==token.binding_id||guard.conversation_id!==token.conversation_id
  ||guard.source_generation!==token.source_generation||guard.guard_id!==guardId)throw new StorageFailure(reason);
}
