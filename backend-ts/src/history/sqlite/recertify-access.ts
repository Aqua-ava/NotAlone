import {isSourceBlocked} from './source-proof.ts';
import {StorageFailure,type StorageTransaction,type StorageRow} from '../../storage/sqlite/contracts.ts';
import {assertReadEligibility} from '../../contacts/sqlite/actions.ts';
import type {ReadEligibility} from '../../contacts/sqlite/contracts.ts';
import type {HistoryTarget} from './contracts.ts';

export interface RecertifySourceWrite {operationId:string;guardId:string;goalId:string}

/** 仅具名认证接受动作使用；普通同步不接受围栏豁免。 */
export function assertRecertifyAccess(tx:StorageTransaction,token:ReadEligibility,id:unknown,guardId:unknown,target?:HistoryTarget):StorageRow {
 assertReadEligibility(tx,token);
 if(tx.get(`SELECT 1 FROM history_source_recertification_cancel c JOIN history_source_recertification o ON o.owner_id=c.owner_id AND o.request_key=c.request_key WHERE o.owner_id=? AND o.id=?`,[token.owner_id,String(id)]))throw new StorageFailure('history_recertify_cancelled');
 const op=tx.get('SELECT * FROM history_source_recertification WHERE owner_id=? AND id=? AND contact_id=?',[token.owner_id,String(id),token.contact_id]);
 const runtime=tx.get('SELECT runtime_id FROM database_instance WHERE slot=1');
 if(!op||op.state!=='running'||op.stage!=='history'||op.runtime_id!==runtime?.runtime_id||op.guard_state!=='active'||op.guard_id!==guardId
  ||op.token_json!==JSON.stringify(token)||op.new_binding_id!==token.binding_id||op.new_grant_id!==token.grant_id
  ||target&&op.target_json!==JSON.stringify(target)
  ||!isSourceBlocked(tx,token.owner_id,token.contact_id))throw new StorageFailure('history_recertify_not_authorized');
 return op;
}

/** 引用只是同一认证页的写投影，不因此取得普通读取或派生资格。 */
export function assertRecertifySourceWrite(tx:StorageTransaction,token:ReadEligibility,cap:RecertifySourceWrite,recordId:string,messageId:string):void {
 const op=assertRecertifyAccess(tx,token,cap.operationId,cap.guardId);
 const row=tx.get(`SELECT r.observed_key,r.observed_scheme,g.id goal_id,g.kind goal_kind,g.target_json,g.eligibility_json FROM capture_record r
  JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id
  JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
  JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
  WHERE r.owner_id=? AND r.contact_id=? AND r.id=? AND r.message_id=? AND g.binding_id=? AND g.grant_id=?
  AND r.state='normalized' AND r.availability='available' AND m.availability='available' AND m.binding_id=?
  AND NOT EXISTS(SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)`,
  [token.owner_id,token.contact_id,recordId,messageId,token.binding_id,token.grant_id,token.binding_id]);
 if(!row||row.goal_id!==op.goal_id||cap.goalId!==op.goal_id||row.goal_kind!=='history'||row.eligibility_json!==op.token_json||row.target_json!==op.target_json||row.observed_scheme!=='source-table-local-v1')throw new StorageFailure('history_recertify_source_not_available');
 try {
  const key=JSON.parse(String(row.observed_key)),target=JSON.parse(String(op.target_json)) as HistoryTarget;
  if(!Array.isArray(key)||key.length!==4||JSON.stringify(key)!==row.observed_key||key[0]!==token.source_generation||typeof key[3]!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(key[3])||BigInt(key[3])>18446744073709551615n||!target.tables.some(t=>t.partition===key[1]&&t.instance===key[2]))throw new Error('source');
 }catch{throw new StorageFailure('history_recertify_source_not_available');}
}
