import {StorageFailure,type StorageDiagnostic,type StorageRow,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {ReadEligibility} from '../../contacts/sqlite/contracts.ts';
import {removeSourceGuard} from './source-guard.ts';

export type SourceProofState='ok'|'needs_confirmation';
export interface SourceProof extends StorageRow {
 owner_id:string;contact_id:string;account_key:string|null;conversation_id:string|null;conversation_key:string|null;
 source_generation:string|null;tables_json:string;state:SourceProofState;checked_at:bigint|null;reason:string|null;
}
export const getProof=(tx:StorageTransaction,ownerId:string,contactId:string):SourceProof|undefined=>
 tx.get('SELECT * FROM source_proof WHERE owner_id=? AND contact_id=?',[ownerId,contactId]) as SourceProof|undefined;
export const isSourceBlocked=(tx:StorageTransaction,ownerId:string,contactId:string):boolean=>
 Boolean(tx.get("SELECT 1 FROM source_proof WHERE owner_id=? AND contact_id=? AND state='needs_confirmation'",[ownerId,contactId]));
export function fenceSource(tx:StorageTransaction,token:ReadEligibility,branch:StorageDiagnostic['branch'],errorCode?:string):false {
 if(isSourceBlocked(tx,token.owner_id,token.contact_id))return false;
 // 已知物理事实保留作下一次核对；没有旧基线时仅登记待确认，不能从当前身份补签旧来源。
 tx.run(`INSERT INTO source_proof(owner_id,contact_id,tables_json,state,reason) VALUES(?,?,?,'needs_confirmation',?)
  ON CONFLICT(owner_id,contact_id) DO UPDATE SET state='needs_confirmation',reason=excluded.reason`,
  [token.owner_id,token.contact_id,'','history_source_continuity_unverified']);
 tx.run('UPDATE contact SET source_revision=source_revision+1 WHERE owner_id=? AND id=? AND source_revision<9223372036854775807',[token.owner_id,token.contact_id]);
 tx.recordDiagnostic?.({kind:'history_continuity_fence',contactPrefix:token.contact_id.slice(0,8),branch,...(errorCode?{errorCode}:{})});
 return false;
}
export interface SourceScopeMetadata {
 accountKey?:string;conversationKey?:string;state?:SourceProofState;checkedAt?:number|bigint|null;reason?:string|null;
}
/** 调用方先核对当前元数据；默认保留待确认状态，解除必须显式指定ok。 */
export function putScope(tx:StorageTransaction,token:ReadEligibility,tablesJson:string,metadata:SourceScopeMetadata={}):void {
 const identity=tx.get(`SELECT a.external_key AS account_key,c.external_key AS conversation_key
  FROM channel_account a JOIN channel_conversation c ON c.owner_id=a.owner_id AND c.account_id=a.id
  WHERE a.owner_id=? AND a.id=? AND c.id=?`,[token.owner_id,token.account_id,token.conversation_id]);
 if(!identity||metadata.accountKey!==undefined&&metadata.accountKey!==identity.account_key
  ||metadata.conversationKey!==undefined&&metadata.conversationKey!==identity.conversation_key)throw new StorageFailure('history_scope_invalid');
 const previous=getProof(tx,token.owner_id,token.contact_id),state=metadata.state??previous?.state??'ok';
 const reason=state==='ok'?null:metadata.reason??previous?.reason??'history_source_continuity_unverified';
 tx.run(`INSERT INTO source_proof(owner_id,contact_id,account_key,conversation_id,conversation_key,source_generation,tables_json,state,checked_at,reason)
  VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,contact_id) DO UPDATE SET
  account_key=excluded.account_key,conversation_id=excluded.conversation_id,conversation_key=excluded.conversation_key,
  source_generation=excluded.source_generation,tables_json=excluded.tables_json,state=excluded.state,checked_at=excluded.checked_at,reason=excluded.reason`,
  [token.owner_id,token.contact_id,String(identity.account_key),token.conversation_id,String(identity.conversation_key),token.source_generation,
   tablesJson,state,metadata.checkedAt===undefined?previous?.checked_at??null:metadata.checkedAt,reason]);
}
export function deleteProof(tx:StorageTransaction,ownerId:string,contactId:string):void {
 tx.run('DELETE FROM source_proof WHERE owner_id=? AND contact_id=?',[ownerId,contactId]);
 removeSourceGuard(tx,ownerId,contactId);
}
