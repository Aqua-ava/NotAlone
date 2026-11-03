import { StorageFailure, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { MessageSourceReference } from './contracts.ts';
import {currentSourceScopeCTE,currentSourcePredicate} from './current-scope.ts';

/** 派生写者必须在自身接受结果的同一短事务复验实际来源，不能只核历史查询结果。 */
export function assertSourceEligibility(tx:StorageTransaction,ref:MessageSourceReference):void {
 assertSourcesEligibility(tx,[ref]);
}

/** 同一事务内按实际来源联系人批量核验，避免每条消息重新解析同一来源范围。 */
export function assertSourcesEligibility(tx:StorageTransaction,refs:readonly MessageSourceReference[]):void {
 const groups=new Map<string,{ownerId:string;contactId:string;refs:Map<string,[string,string]>}>();
 for(const ref of refs){
  const key=JSON.stringify([ref.owner_id,ref.contact_id]);
  let group=groups.get(key);
  if(!group){group={ownerId:ref.owner_id,contactId:ref.contact_id,refs:new Map()};groups.set(key,group);}
  group.refs.set(JSON.stringify([ref.record_id,ref.message_id]),[ref.record_id,ref.message_id]);
 }
 for(const group of groups.values()){
  const wanted=[...group.refs.values()];
  const valid=tx.get(`WITH ${currentSourceScopeCTE},wanted AS (
 SELECT json_extract(value,'$[0]') record_id,json_extract(value,'$[1]') message_id FROM json_each(?)
 ) SELECT count(*) valid_count FROM wanted w WHERE EXISTS (SELECT r.id FROM capture_record r
 JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id
 JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
 JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
 JOIN contact p ON p.owner_id=r.owner_id AND p.id=r.contact_id
 JOIN owner o ON o.owner_id=p.owner_id
 WHERE r.owner_id=? AND r.contact_id=? AND r.id=w.record_id AND r.message_id=w.message_id
 AND r.state='normalized' AND r.availability='available' AND m.availability='available'
 AND NOT EXISTS (SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)
 AND NOT EXISTS (SELECT 1 FROM history_continuity_fence f WHERE f.owner_id=m.owner_id AND f.contact_id=m.contact_id)
 AND NOT EXISTS (SELECT 1 FROM history_guard_lease g JOIN database_instance d ON d.slot=1 WHERE g.owner_id=m.owner_id AND g.contact_id=m.contact_id AND (g.state<>'active' OR g.runtime_id<>d.runtime_id))
 AND m.binding_id=g.binding_id AND p.state='active' AND o.state='active' AND ${currentSourcePredicate()})`,[group.ownerId,group.contactId,group.contactId,JSON.stringify(wanted),group.ownerId,group.contactId]);
  if(valid?.valid_count!==BigInt(wanted.length))throw new StorageFailure('history_source_not_available');
 }
}
