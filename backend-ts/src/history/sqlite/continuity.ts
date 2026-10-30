import { StorageFailure, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistoryTarget } from './contracts.ts';

const reason = 'history_source_continuity_unverified';
const lostCodes=new Set(['history_source_changed','history_source_unverified','history_external_scope_changed','history_scope_changed','history_schema_changed','history_shards_changed','history_cursor_scope_changed']);
export const isSourceContinuityLost=(error:unknown):boolean=>error instanceof StorageFailure&&lostCodes.has(error.code);
function tables(target: HistoryTarget): string {
  return JSON.stringify({partitions:[...target.partitions].sort(),tables:target.tables.map(t=>[t.partition,t.instance]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))});
}
export function fenceContinuity(tx: StorageTransaction, token: ReadEligibility): false {
  tx.run('INSERT OR IGNORE INTO history_continuity_fence VALUES(?,?,?)',[token.owner_id,token.contact_id,reason]);
  return false;
}
/** 在可能读取正文前独立提交失证状态；旧数据无可证明基线时也停读。 */
export function preflightGeneration(tx: StorageTransaction, token: ReadEligibility): boolean {
  if(tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]))return false;
  const scope=tx.get('SELECT * FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  if(scope)return scope.conversation_id===token.conversation_id&&scope.source_generation===token.source_generation?true:fenceContinuity(tx,token);
  if(tx.get('SELECT 1 FROM read_goal WHERE owner_id=? AND contact_id=? LIMIT 1',[token.owner_id,token.contact_id])
    ||tx.get('SELECT 1 FROM history_source_exclusion WHERE owner_id=? AND conversation_id=? LIMIT 1',[token.owner_id,token.conversation_id])
    ||tx.get('SELECT 1 FROM history_cutoff WHERE owner_id=? AND conversation_id=? LIMIT 1',[token.owner_id,token.conversation_id]))return fenceContinuity(tx,token);
  return true;
}
export function preflightTarget(tx: StorageTransaction, token: ReadEligibility, target: HistoryTarget): boolean {
  if(!preflightGeneration(tx,token))return false;
  const existing=tx.get('SELECT tables_json FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  const value=tables(target);
  if(existing)return existing.tables_json===value?true:fenceContinuity(tx,token);
  tx.run('INSERT INTO history_continuity_scope VALUES(?,?,?,?,?)',[token.owner_id,token.contact_id,token.conversation_id,token.source_generation,value]);
  return true;
}
/** 接受页的事务复验不改变围栏；失证应由预检先行持久化。 */
export function assertSourceContinuity(tx: StorageTransaction, token: ReadEligibility, target: HistoryTarget): void {
  if(tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]))throw new StorageFailure(reason);
  const scope=tx.get('SELECT * FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
  if(!scope||scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation||scope.tables_json!==tables(target))throw new StorageFailure(reason);
}
