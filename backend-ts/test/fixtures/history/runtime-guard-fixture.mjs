import {putSourceGuard} from '../../../src/history/sqlite/source-guard.ts';

/** 仅模拟Worker易失状态，不创建持久租约、不授予来源或读取资格。 */
export function simulateSourceGuard(tx,{ownerId,contactId,state='lost',runtimeId,guardId='synthetic-guard'}){
 const row=tx.get(`SELECT b.id,b.conversation_id,a.source_generation,d.runtime_id FROM conversation_binding b
  JOIN channel_conversation c ON c.owner_id=b.owner_id AND c.id=b.conversation_id
  JOIN channel_account a ON a.owner_id=c.owner_id AND a.id=c.account_id JOIN database_instance d ON d.slot=1
  WHERE b.owner_id=? AND b.contact_id=? AND b.state='verified'`,[ownerId,contactId]);
 if(!row)throw Error('synthetic_binding_missing');
 const guard={owner_id:ownerId,contact_id:contactId,binding_id:String(row.id),conversation_id:String(row.conversation_id),source_generation:String(row.source_generation),guard_id:guardId,runtime_id:runtimeId??String(row.runtime_id),state};
 putSourceGuard(tx,guard);return guard;
}
