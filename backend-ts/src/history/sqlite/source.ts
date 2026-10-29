import { StorageFailure, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { MessageSourceReference } from './contracts.ts';

/** 派生写者必须在自身接受结果的同一短事务复验实际来源，不能只核历史查询结果。 */
export function assertSourceEligibility(tx:StorageTransaction,ref:MessageSourceReference):void {
 const valid=tx.get(`SELECT r.id FROM capture_record r
 JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id
 JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
 JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
 JOIN contact p ON p.owner_id=r.owner_id AND p.id=r.contact_id
 JOIN owner o ON o.owner_id=p.owner_id
 WHERE r.owner_id=? AND r.contact_id=? AND r.id=? AND r.message_id=?
 AND r.state='normalized' AND r.availability='available' AND m.availability='available'
 AND m.binding_id=g.binding_id AND p.state='active' AND o.state='active'`,[ref.owner_id,ref.contact_id,ref.record_id,ref.message_id]);
 if(!valid)throw new StorageFailure('history_source_not_available');
}
