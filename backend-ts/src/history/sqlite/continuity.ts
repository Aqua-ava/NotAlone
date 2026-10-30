import { StorageFailure, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistoryTarget } from './contracts.ts';

const reason = 'history_source_continuity_unverified';
export const normalUseContinuity = 'same-source-instances-normal-use-v1';
const lostCodes=new Set(['history_source_changed','history_source_unverified','history_external_scope_changed','history_scope_changed','history_schema_changed','history_shards_changed','history_cursor_scope_changed','history_support_changed','history_target_unverified']);
export const isSourceContinuityLost=(error:unknown):boolean=>error instanceof StorageFailure&&lostCodes.has(error.code);
function tables(target: HistoryTarget): string {
  return JSON.stringify({partitions:[...target.partitions].sort(),tables:target.tables.map(t=>[t.partition,t.instance]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))});
}
function identity(target:HistoryTarget,accountKey?:string):string {
 const value=JSON.parse(tables(target)) as {partitions:string[];tables:[string,string][]};
 return accountKey===undefined?JSON.stringify(value):JSON.stringify({accountKey,...value});
}
function matchesStored(stored:string,target:HistoryTarget,accountKey?:string,requireAccountKey=false):boolean {
 try{
  const value=JSON.parse(stored) as {accountKey?:unknown;partitions?:unknown;tables?:unknown};
  if(!Array.isArray(value.partitions)||!Array.isArray(value.tables))return false;
  if(JSON.stringify({partitions:value.partitions,tables:value.tables})!==tables(target))return false;
  return accountKey===undefined?!requireAccountKey:value.accountKey===accountKey;
 }catch{return false;}
}
export function fenceContinuity(tx: StorageTransaction, token: ReadEligibility): false {
  if(!tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id])){
    tx.run('INSERT INTO history_continuity_fence VALUES(?,?,?)',[token.owner_id,token.contact_id,reason]);
    tx.run('UPDATE contact SET source_revision=source_revision+1 WHERE owner_id=? AND id=? AND source_revision<9223372036854775807',[token.owner_id,token.contact_id]);
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
    if(guard&&(guard.state!=='active'||guard.runtime_id!==runtime?.runtime_id||guard.binding_id!==token.binding_id||guard.conversation_id!==token.conversation_id||guard.source_generation!==token.source_generation))return fenceContinuity(tx,token);
  }
  const scope=tx.get('SELECT * FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  if(scope){
    if(scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation)return fenceContinuity(tx,token);
    if(scope.tables_json===''&&hasHistoryOrSuppression(tx,token,tables))return fenceContinuity(tx,token);
    return true;
  }
  if(hasHistoryOrSuppression(tx,token,tables))return fenceContinuity(tx,token);
  // 先检验身份和既有资料，不登记 provisional scope；目标读取完成后才固定分片基线。
  return true;
}
export function preflightTarget(tx: StorageTransaction, token: ReadEligibility, target: HistoryTarget, report?:{continuity?:string;accountKey?:string}): boolean {
  if(!preflightGeneration(tx,token))return false;
  const existing=tx.get('SELECT tables_json FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  const named=report?.continuity===normalUseContinuity;
  const value=identity(target,named?report?.accountKey:undefined);
  if(!existing){
    if(hasHistoryOrSuppression(tx,token,existingTables(tx)))return fenceContinuity(tx,token);
    tx.run('INSERT INTO history_continuity_scope VALUES(?,?,?,?,?)',[token.owner_id,token.contact_id,token.conversation_id,token.source_generation,value]);
    return true;
  }
  if(existing?.tables_json===''){
    tx.run('UPDATE history_continuity_scope SET tables_json=? WHERE owner_id=? AND contact_id=?',[value,token.owner_id,token.contact_id]);
    return true;
  }
  if(existing)return matchesStored(String(existing.tables_json),target,named?report?.accountKey:undefined,named)?true:fenceContinuity(tx,token);
  return fenceContinuity(tx,token);
}
/** 仅允许已知 normal-use 支持档对旧 runtime/clean loss 走 metadata-only 重验。 */
export function normalUseRevalidationCandidate(tx:StorageTransaction,token:ReadEligibility):boolean {
 if(tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]))return false;
 const lease=tx.get('SELECT * FROM history_guard_lease WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
 const runtime=tx.get('SELECT runtime_id FROM database_instance WHERE slot=1');
 if(!lease||(lease.state==='active'&&lease.runtime_id===runtime?.runtime_id))return false;
 if(lease.binding_id!==token.binding_id||lease.conversation_id!==token.conversation_id||lease.source_generation!==token.source_generation)return false;
 const scope=tx.get('SELECT conversation_id,source_generation,tables_json FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
 if(!scope||scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation||!scope.tables_json)return false;
 const previous=tx.get("SELECT support_json FROM read_goal WHERE owner_id=? AND contact_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",[token.owner_id,token.contact_id]);
 try{return JSON.parse(String(previous?.support_json)).continuity===normalUseContinuity;}catch{return false;}
}
/** 用当前报告与新目标完成跨运行代次的来源握手；成功后才租约续期并废弃旧游标。 */
export function prepareNormalUseTarget(tx:StorageTransaction,token:ReadEligibility,target:HistoryTarget,accountKey:string,guardId:string):{ok:boolean;revalidated:boolean} {
 const runtime=tx.get('SELECT runtime_id FROM database_instance WHERE slot=1');
 if(!runtime?.runtime_id||typeof accountKey!=='string'||!accountKey||!guardId)return {ok:false,revalidated:false};
 if(tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]))return {ok:false,revalidated:false};
 const scope=tx.get('SELECT * FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
 const lease=tx.get('SELECT * FROM history_guard_lease WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
 let revalidated=false;
 if(lease&&(lease.binding_id!==token.binding_id||lease.conversation_id!==token.conversation_id||lease.source_generation!==token.source_generation))return {ok:fenceContinuity(tx,token),revalidated:false};
 if(scope&&(scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation))return {ok:fenceContinuity(tx,token),revalidated:false};
 if(scope?.tables_json){
  if(!matchesStored(String(scope.tables_json),target,accountKey,true))return {ok:fenceContinuity(tx,token),revalidated:false};
 }else{
  if(hasHistoryOrSuppression(tx,token,existingTables(tx)))return {ok:fenceContinuity(tx,token),revalidated:false};
  const value=identity(target,accountKey);
  if(scope)tx.run('UPDATE history_continuity_scope SET tables_json=? WHERE owner_id=? AND contact_id=?',[value,token.owner_id,token.contact_id]);
  else tx.run('INSERT INTO history_continuity_scope VALUES(?,?,?,?,?)',[token.owner_id,token.contact_id,token.conversation_id,token.source_generation,value]);
 }
 const previous=tx.get("SELECT support_json FROM read_goal WHERE owner_id=? AND contact_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",[token.owner_id,token.contact_id]);
 const previousWasNormal=(()=>{try{return JSON.parse(String(previous?.support_json)).continuity===normalUseContinuity;}catch{return false;}})();
 if(lease){
  if(lease.state==='active'&&lease.runtime_id===runtime.runtime_id){
   if(lease.guard_id!==guardId)return {ok:false,revalidated:false};
  }else{
   if(!previousWasNormal||!matchesStored(String(scope?.tables_json??''),target,accountKey,true))return {ok:fenceContinuity(tx,token),revalidated:false};
   revalidated=true;
  }
 }else if(tx.get('SELECT 1 FROM read_goal WHERE owner_id=? AND contact_id=? LIMIT 1',[token.owner_id,token.contact_id])){
  return {ok:fenceContinuity(tx,token),revalidated:false};
 }
 if(revalidated){
  tx.run("UPDATE read_goal SET state='invalidated',failure_code='history_runtime_revalidated' WHERE owner_id=? AND contact_id=? AND kind IN ('history','incremental') AND state IN ('running','incomplete')",[token.owner_id,token.contact_id]);
  tx.run("UPDATE history_guard_lease SET binding_id=?,conversation_id=?,source_generation=?,guard_id=?,runtime_id=?,state='active' WHERE owner_id=? AND contact_id=?",[token.binding_id,token.conversation_id,token.source_generation,guardId,runtime.runtime_id,token.owner_id,token.contact_id]);
 }else if(!lease){
  tx.run("INSERT INTO history_guard_lease VALUES(?,?,?,?,?,?,?,'active')",[token.owner_id,token.contact_id,token.binding_id,token.conversation_id,token.source_generation,guardId,runtime.runtime_id]);
 }
 return {ok:true,revalidated};
}
/** 接受页的事务复验不改变围栏；失证应由预检先行持久化。 */
export function assertSourceContinuity(tx: StorageTransaction, token: ReadEligibility, target: HistoryTarget,accountKey?:string): void {
  if(tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]))throw new StorageFailure(reason);
  const scope=tx.get('SELECT * FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  if(!scope||scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation||!matchesStored(String(scope.tables_json),target,accountKey,accountKey!==undefined))throw new StorageFailure(reason);
}
/** 如已登记活守卫，页提交必须持有当前运行代次和同一守卫。 */
export function assertLiveGuard(tx:StorageTransaction,token:ReadEligibility,guardId:unknown):void{
  const guard=tx.get('SELECT * FROM history_guard_lease WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  if(!guard)return;
  const runtime=tx.get('SELECT runtime_id FROM database_instance WHERE slot=1');
  if(guard.state!=='active'||guard.runtime_id!==runtime?.runtime_id||guard.binding_id!==token.binding_id||guard.conversation_id!==token.conversation_id||guard.source_generation!==token.source_generation||guard.guard_id!==guardId)throw new StorageFailure(reason);
}
