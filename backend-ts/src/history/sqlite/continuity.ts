import { StorageFailure, type StorageTransaction, type StorageDiagnostic } from '../../storage/sqlite/contracts.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistorySupportReport, HistoryTarget } from './contracts.ts';
import { historyTargetTransition, isPartitionGrowthTargetChange, type HistoryTargetTransition } from '../partition-growth.ts';
import { reusableEmptyGoals } from './goal-reuse.ts';

const reason = 'history_source_continuity_unverified';
export const normalUseContinuity = 'same-source-instances-normal-use-v1';
const lostCodes=new Set(['history_source_changed','history_external_scope_changed','history_scope_changed','history_schema_changed','history_shards_changed','history_cursor_scope_changed','history_support_changed','history_target_unverified','history_quote_source_changed']);
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
export function fenceContinuity(tx: StorageTransaction, token: ReadEligibility, branch: StorageDiagnostic['branch'], errorCode?: string): false {
  if(!tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id])){
    tx.run('INSERT INTO history_continuity_fence VALUES(?,?,?)',[token.owner_id,token.contact_id,reason]);
    tx.run('UPDATE contact SET source_revision=source_revision+1 WHERE owner_id=? AND id=? AND source_revision<9223372036854775807',[token.owner_id,token.contact_id]);
    tx.recordDiagnostic?.({kind:'history_continuity_fence',contactPrefix:token.contact_id.slice(0,8),branch,...(errorCode?{errorCode}:{})});
  }
  return false;
}
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
/** 仅恢复从未进入正文/目标读取的空范围；任何来源、目标、删除或排除记录都永久保留原围栏。 */
function rearmEmptyContinuity(tx: StorageTransaction, token: ReadEligibility, tables: ReadonlySet<string>): boolean {
  if(!tables.has('history_continuity_fence')||!tables.has('history_continuity_scope'))return false;
  const fence=tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  const scope=tx.get('SELECT conversation_id,source_generation,tables_json FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  const guard=tables.has('history_guard_lease')?tx.get('SELECT state FROM history_guard_lease WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]):undefined;
  const identityChanged=Boolean(scope&&(scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation));
  const needsReset=Boolean(fence)||guard?.state==='lost'||identityChanged;
  if(!needsReset||guard?.state==='active'||scope&&scope.tables_json!=='')return false;
  if(hasHistoryOrSuppression(tx,token,tables))return false;
  if(tables.has('history_guard_lease'))tx.run('DELETE FROM history_guard_lease WHERE owner_id=? AND contact_id=? AND state=\'lost\'',[token.owner_id,token.contact_id]);
  tx.run('DELETE FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  tx.run('DELETE FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  return true;
}
/** 在可能读取正文前独立提交失证状态；旧数据无可证明基线时也停读。 */
export function preflightGeneration(tx: StorageTransaction, token: ReadEligibility): boolean {
  const tables=existingTables(tx);
  if(!tables.has('history_continuity_fence')||!tables.has('history_continuity_scope'))return false;
  if(rearmEmptyContinuity(tx,token,tables))return true;
  if(tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]))return false;
  if(tables.has('history_guard_lease')){
    const guard=tx.get('SELECT * FROM history_guard_lease WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
    const runtime=tx.get('SELECT runtime_id FROM database_instance WHERE slot=1');
    if(guard&&(guard.state!=='active'||guard.runtime_id!==runtime?.runtime_id||guard.binding_id!==token.binding_id||guard.conversation_id!==token.conversation_id||guard.source_generation!==token.source_generation))return fenceContinuity(tx,token,'G01');
  }
  const scope=tx.get('SELECT * FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  if(scope){
    if(scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation)return fenceContinuity(tx,token,'G02');
    if(scope.tables_json===''&&hasHistoryOrSuppression(tx,token,tables))return fenceContinuity(tx,token,'G03');
    return true;
  }
  if(hasHistoryOrSuppression(tx,token,tables))return fenceContinuity(tx,token,'G04');
  // 先检验身份和既有资料，不登记 provisional scope；目标读取完成后才固定分片基线。
  return true;
}
export function preflightTarget(tx: StorageTransaction, token: ReadEligibility, target: HistoryTarget, report?:{continuity?:string;accountKey?:string}): boolean {
  if(!preflightGeneration(tx,token))return false;
  const existing=tx.get('SELECT tables_json FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  const named=report?.continuity===normalUseContinuity;
  const value=identity(target,named?report?.accountKey:undefined);
  if(!existing){
    if(hasHistoryOrSuppression(tx,token,existingTables(tx)))return fenceContinuity(tx,token,'T01');
    tx.run('INSERT INTO history_continuity_scope VALUES(?,?,?,?,?)',[token.owner_id,token.contact_id,token.conversation_id,token.source_generation,value]);
    return true;
  }
  if(existing?.tables_json===''){
    tx.run('UPDATE history_continuity_scope SET tables_json=? WHERE owner_id=? AND contact_id=?',[value,token.owner_id,token.contact_id]);
    return true;
  }
  if(existing){
   const previous=storedTarget(String(existing.tables_json),token.source_generation);
   const accountKey=named?report?.accountKey:undefined;
   const transition=previous&&(accountKey===undefined||previous.accountKey===accountKey)
    ?historyTargetTransition(previous.target,target,false):null;
   if(transition==='same')return true;
   if(transition==='legacy-exact-upgrade'&&target.checkedPartitions!==undefined){
    tx.run('UPDATE history_continuity_scope SET tables_json=? WHERE owner_id=? AND contact_id=?',[identity(target,accountKey),token.owner_id,token.contact_id]);
    return true;
   }
   return fenceContinuity(tx,token,'T02');
  }
  return fenceContinuity(tx,token,'T03');
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
/** 仅允许已知 normal-use 支持档对旧 runtime/clean loss 走 metadata-only 重验。 */
export function normalUseRevalidationCandidate(tx:StorageTransaction,token:ReadEligibility):boolean {
 const fenced=Boolean(tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]));
 const lease=tx.get('SELECT * FROM history_guard_lease WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
 const runtime=tx.get('SELECT runtime_id FROM database_instance WHERE slot=1');
 if(!lease||(!fenced&&lease.state==='active'&&lease.runtime_id===runtime?.runtime_id))return false;
 if(lease.binding_id!==token.binding_id||lease.conversation_id!==token.conversation_id||lease.source_generation!==token.source_generation)return false;
 const scope=tx.get('SELECT conversation_id,source_generation,tables_json FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
 if(!scope||scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation||!scope.tables_json)return false;
 return priorNormalUse(tx,token,String(scope.tables_json));
}
/** 用当前报告与新目标完成跨运行代次的来源握手；成功后才租约续期并废弃旧游标。 */
export function prepareNormalUseTarget(tx:StorageTransaction,token:ReadEligibility,target:HistoryTarget,report:HistorySupportReport,guardId:string,verifiedRecovery=false):{ok:boolean;revalidated:boolean} {
 const accountKey=report.accountKey;
 const runtime=tx.get('SELECT runtime_id FROM database_instance WHERE slot=1');
 if(!runtime?.runtime_id||typeof accountKey!=='string'||!accountKey||!guardId)return {ok:false,revalidated:false};
 if(tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]))return {ok:false,revalidated:false};
 const scope=tx.get('SELECT * FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
 const lease=tx.get('SELECT * FROM history_guard_lease WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
 let revalidated=false;
 let storedTransition:HistoryTargetTransition|null=null;
 let nextScopeValue:string|undefined;
 if(lease&&(lease.binding_id!==token.binding_id||lease.conversation_id!==token.conversation_id||lease.source_generation!==token.source_generation))return {ok:fenceContinuity(tx,token,'N01'),revalidated:false};
 if(scope&&(scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation))return {ok:fenceContinuity(tx,token,'N02'),revalidated:false};
 if(scope?.tables_json){
  const previous=storedTarget(String(scope.tables_json),token.source_generation);
  if(!previous||previous.accountKey!==accountKey)return {ok:fenceContinuity(tx,token,'N03'),revalidated:false};
  storedTransition=historyTargetTransition(previous.target,target,verifiedRecovery&&report.capabilities?.partitionGrowth==='supported'||priorPartitionGrowth(tx,token,report));
  if(storedTransition===null)return {ok:fenceContinuity(tx,token,'N04'),revalidated:false};
  if(storedTransition==='growth'||storedTransition==='legacy-exact-upgrade')nextScopeValue=identity(target,accountKey);
 }else{
  if(hasHistoryOrSuppression(tx,token,existingTables(tx)))return {ok:fenceContinuity(tx,token,'N05'),revalidated:false};
  nextScopeValue=identity(target,accountKey);
 }
 const previousWasNormal=priorNormalUse(tx,token,String(scope?.tables_json??''));
 if(lease){
  if(lease.state==='active'&&lease.runtime_id===runtime.runtime_id){
   if(lease.guard_id!==guardId)return {ok:false,revalidated:false};
  }else{
   if(!previousWasNormal||storedTransition===null)return {ok:fenceContinuity(tx,token,'N06'),revalidated:false};
   revalidated=true;
  }
 }else if(tx.get('SELECT 1 FROM read_goal WHERE owner_id=? AND contact_id=? LIMIT 1',[token.owner_id,token.contact_id])){
  return {ok:fenceContinuity(tx,token,'N07'),revalidated:false};
 }
 if(nextScopeValue!==undefined){
  if(scope)tx.run('UPDATE history_continuity_scope SET tables_json=? WHERE owner_id=? AND contact_id=?',[nextScopeValue,token.owner_id,token.contact_id]);
  else tx.run('INSERT INTO history_continuity_scope VALUES(?,?,?,?,?)',[token.owner_id,token.contact_id,token.conversation_id,token.source_generation,nextScopeValue]);
 }
 if(revalidated){
  // 阶段 B（任务 01）：与本次重验完全同范围、0 页且无记录进展的空目标保持 running，
  // 由随后的 history.begin／history.incrementalPending 续用，不再先作废再重建；
  // 其余行仍按原样作废（作废行是审计记录，此改动不会把已作废行改回 running）。
  const keepIds=reusableEmptyGoals(tx,token,report,target).map(goal=>goal.id);
  if(keepIds.length){
   tx.run(`UPDATE read_goal SET state='invalidated',failure_code='history_runtime_revalidated' WHERE owner_id=? AND contact_id=? AND kind IN ('history','incremental') AND state IN ('running','incomplete') AND id NOT IN (${keepIds.map(()=>'?').join(',')})`,[token.owner_id,token.contact_id,...keepIds]);
  }else{
   tx.run("UPDATE read_goal SET state='invalidated',failure_code='history_runtime_revalidated' WHERE owner_id=? AND contact_id=? AND kind IN ('history','incremental') AND state IN ('running','incomplete')",[token.owner_id,token.contact_id]);
  }
  tx.run("UPDATE history_guard_lease SET binding_id=?,conversation_id=?,source_generation=?,guard_id=?,runtime_id=?,state='active' WHERE owner_id=? AND contact_id=?",[token.binding_id,token.conversation_id,token.source_generation,guardId,runtime.runtime_id,token.owner_id,token.contact_id]);
 }else if(!lease){
  tx.run("INSERT INTO history_guard_lease VALUES(?,?,?,?,?,?,?,'active')",[token.owner_id,token.contact_id,token.binding_id,token.conversation_id,token.source_generation,guardId,runtime.runtime_id]);
 }
 return {ok:true,revalidated};
}
function priorPartitionGrowth(tx:StorageTransaction,token:ReadEligibility,current:HistorySupportReport):boolean {
 const previous=tx.get(`SELECT support_json FROM read_goal WHERE owner_id=? AND contact_id=? AND binding_id=? AND grant_id=?
  AND accepted_data_generation=? AND accepted_barrier_generation=? AND creation_no IS NOT NULL
  ORDER BY creation_no DESC,created_at DESC,id DESC LIMIT 1`,[token.owner_id,token.contact_id,token.binding_id,token.grant_id,BigInt(token.data_generation),BigInt(token.barrier_generation)]);
 try{return isPartitionGrowthTargetChange(JSON.parse(String(previous?.support_json)) as HistorySupportReport,current);}catch{return false;}
}
/** 接受页的事务复验不改变围栏；失证应由预检先行持久化。 */
export function assertSourceContinuity(tx: StorageTransaction, token: ReadEligibility, target: HistoryTarget,accountKey?:string): void {
  if(tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]))throw new StorageFailure(reason);
  const scope=tx.get('SELECT * FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  if(!scope||scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation||!matchesStored(String(scope.tables_json),target,accountKey,accountKey!==undefined))throw new StorageFailure(reason);
}
/** 仅用于寻找旧恢复点：已核验范围可包含旧目标之后新增的表；后续原生目标与页提交仍走严格连续性核验。 */
export function assertCheckpointSourceContinuity(tx:StorageTransaction,token:ReadEligibility,target:HistoryTarget,accountKey:string,acceptedGrowth:boolean):void {
 if(!acceptedGrowth){assertSourceContinuity(tx,token,target,accountKey);return;}
 if(tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]))throw new StorageFailure(reason);
 const scope=tx.get('SELECT * FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
 if(!scope||scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation)throw new StorageFailure(reason);
 if(matchesStored(String(scope.tables_json),target,accountKey,true))return;
 const current=storedTarget(String(scope.tables_json),token.source_generation);
 if(!current||current.accountKey!==accountKey||historyTargetTransition(target,current.target,true)!=='growth')throw new StorageFailure(reason);
}
/** 如已登记活守卫，页提交必须持有当前运行代次和同一守卫。 */
export function assertLiveGuard(tx:StorageTransaction,token:ReadEligibility,guardId:unknown):void{
  const guard=tx.get('SELECT * FROM history_guard_lease WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  if(!guard)return;
  const runtime=tx.get('SELECT runtime_id FROM database_instance WHERE slot=1');
  if(guard.state!=='active'||guard.runtime_id!==runtime?.runtime_id||guard.binding_id!==token.binding_id||guard.conversation_id!==token.conversation_id||guard.source_generation!==token.source_generation||guard.guard_id!==guardId)throw new StorageFailure(reason);
}
