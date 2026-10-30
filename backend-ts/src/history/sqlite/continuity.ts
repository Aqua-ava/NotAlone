import { StorageFailure, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistoryTarget } from './contracts.ts';

const reason = 'history_source_continuity_unverified';
const lostCodes=new Set(['history_source_changed','history_source_unverified','history_external_scope_changed','history_scope_changed','history_schema_changed','history_shards_changed','history_cursor_scope_changed','history_support_changed','history_target_unverified']);
export const isSourceContinuityLost=(error:unknown):boolean=>error instanceof StorageFailure&&lostCodes.has(error.code);
function tables(target: HistoryTarget): string {
  return JSON.stringify({partitions:[...target.partitions].sort(),tables:target.tables.map(t=>[t.partition,t.instance]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))});
}
export function fenceContinuity(tx: StorageTransaction, token: ReadEligibility): false {
  if(!tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id])){
    tx.run('INSERT INTO history_continuity_fence VALUES(?,?,?)',[token.owner_id,token.contact_id,reason]);
    tx.run('UPDATE contact SET source_revision=source_revision+1 WHERE owner_id=? AND id=? AND source_revision<9223372036854775807',[token.owner_id,token.contact_id]);
  }
  return false;
}
/** 在可能读取正文前独立提交失证状态；旧数据无可证明基线时也停读。 */
export function preflightGeneration(tx: StorageTransaction, token: ReadEligibility): boolean {
  if(tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]))return false;
  if(tx.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='history_guard_lease'")){
    const guard=tx.get('SELECT * FROM history_guard_lease WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
    const runtime=tx.get('SELECT runtime_id FROM database_instance WHERE slot=1');
    if(guard&&(guard.state!=='active'||guard.runtime_id!==runtime?.runtime_id||guard.binding_id!==token.binding_id||guard.conversation_id!==token.conversation_id||guard.source_generation!==token.source_generation))return fenceContinuity(tx,token);
  }
  const scope=tx.get('SELECT * FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  if(scope)return scope.conversation_id===token.conversation_id&&scope.source_generation===token.source_generation?true:fenceContinuity(tx,token);
  if(tx.get('SELECT 1 FROM read_goal WHERE owner_id=? AND contact_id=? LIMIT 1',[token.owner_id,token.contact_id])
    ||tx.get('SELECT 1 FROM history_source_exclusion WHERE owner_id=? AND conversation_id=? LIMIT 1',[token.owner_id,token.conversation_id])
    ||tx.get('SELECT 1 FROM history_cutoff WHERE owner_id=? AND conversation_id=? LIMIT 1',[token.owner_id,token.conversation_id]))return fenceContinuity(tx,token);
  tx.run('INSERT INTO history_continuity_scope VALUES(?,?,?,?,?)',[token.owner_id,token.contact_id,token.conversation_id,token.source_generation,'']);
  return true;
}
export function preflightTarget(tx: StorageTransaction, token: ReadEligibility, target: HistoryTarget): boolean {
  if(!preflightGeneration(tx,token))return false;
  const existing=tx.get('SELECT tables_json FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  const value=tables(target);
  if(existing?.tables_json===''){
    tx.run('UPDATE history_continuity_scope SET tables_json=? WHERE owner_id=? AND contact_id=?',[value,token.owner_id,token.contact_id]);
    return true;
  }
  if(existing)return existing.tables_json===value?true:fenceContinuity(tx,token);
  return fenceContinuity(tx,token);
}
/** 接受页的事务复验不改变围栏；失证应由预检先行持久化。 */
export function assertSourceContinuity(tx: StorageTransaction, token: ReadEligibility, target: HistoryTarget): void {
  if(tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]))throw new StorageFailure(reason);
  const scope=tx.get('SELECT * FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  if(!scope||scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation||scope.tables_json!==tables(target))throw new StorageFailure(reason);
}
/** 如已登记活守卫，页提交必须持有当前运行代次和同一守卫。 */
export function assertLiveGuard(tx:StorageTransaction,token:ReadEligibility,guardId:unknown):void{
  const guard=tx.get('SELECT * FROM history_guard_lease WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  if(!guard)return;
  const runtime=tx.get('SELECT runtime_id FROM database_instance WHERE slot=1');
  if(guard.state!=='active'||guard.runtime_id!==runtime?.runtime_id||guard.binding_id!==token.binding_id||guard.conversation_id!==token.conversation_id||guard.source_generation!==token.source_generation||guard.guard_id!==guardId)throw new StorageFailure(reason);
}
