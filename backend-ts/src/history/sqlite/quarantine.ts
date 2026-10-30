import {StorageFailure,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {currentSourceScopeCTE,currentCapturePredicate} from './current-scope.ts';

const count=(value:unknown):number=>{if(typeof value!=='bigint'||value<0n||value>BigInt(Number.MAX_SAFE_INTEGER))throw new StorageFailure('history_count_out_of_range');return Number(value);};
/** 按候选出现键索引聚合；未知旧顺序不参与恢复，接受顺序不取决于时间或隐式行号。 */
export function quarantineSummary(tx:StorageTransaction,owner:string,contact:string):{unresolved:number;metadataOnly:number}{
 const result=tx.get(`WITH ${currentSourceScopeCTE},candidates AS MATERIALIZED (
 SELECT g.binding_id,r.observed_key,
 max(CASE WHEN r.reason_code NOT IN ('message_state_unverified','metadata_only') OR r.observed_key IS NULL THEN 1 ELSE 0 END) conflicted,
 max(CASE WHEN c.acceptance_no IS NULL AND r.reason_code='message_state_unverified' THEN 1 ELSE 0 END) legacy_unknown,
 max(CASE WHEN c.acceptance_no IS NULL AND r.reason_code='metadata_only' THEN 1 ELSE 0 END) legacy_metadata
 FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id
 JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
 WHERE r.owner_id=? AND r.contact_id=? AND (r.state='quarantined' OR (r.state='excluded' AND r.reason_code='metadata_only')) AND r.availability='available' AND ${currentCapturePredicate()}
 GROUP BY g.binding_id,r.observed_key,CASE WHEN r.observed_key IS NULL THEN r.id END
), current AS MATERIALIZED (
 SELECT k.*,CASE WHEN k.observed_key IS NULL THEN 0 ELSE coalesce((
  SELECT CASE WHEN r.state IN ('quarantined','excluded') AND r.reason_code='metadata_only' THEN 2
   WHEN r.state='quarantined' AND r.reason_code='message_state_unverified' THEN 1 ELSE 0 END
  FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id
  JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
  WHERE r.owner_id=? AND r.contact_id=? AND r.observed_key=k.observed_key AND r.availability='available' AND g.binding_id=k.binding_id AND c.acceptance_no IS NOT NULL
  ORDER BY c.acceptance_no DESC,r.item_no DESC LIMIT 1),CASE WHEN k.legacy_unknown=1 THEN 1 WHEN k.legacy_metadata=1 THEN 2 ELSE 0 END) END latest_state
 FROM candidates k
)
SELECT coalesce(sum(CASE WHEN EXISTS(SELECT 1 FROM history_source_terminal t WHERE t.owner_id=? AND t.contact_id=? AND t.binding_id=current.binding_id AND t.external_key=current.observed_key) THEN 0 WHEN conflicted=1 THEN 1 WHEN latest_state=1 AND NOT EXISTS (
 SELECT 1 FROM message_alias a JOIN history_message_quarantine q ON q.owner_id=a.owner_id AND q.contact_id=a.contact_id AND q.message_id=a.message_id
 WHERE a.owner_id=? AND a.contact_id=? AND a.binding_id=current.binding_id AND a.scheme='local' AND a.external_key=current.observed_key
 AND q.reason IN ('source_recalled','source_absent','source_system_replaced')) THEN 1 ELSE 0 END),0) unresolved,
 coalesce(sum(CASE WHEN latest_state=2 AND NOT EXISTS(SELECT 1 FROM history_source_terminal t WHERE t.owner_id=? AND t.contact_id=? AND t.binding_id=current.binding_id AND t.external_key=current.observed_key AND t.reason='source_absent') THEN 1 ELSE 0 END),0) metadataOnly FROM current`,[owner,contact,contact,owner,contact,owner,contact,owner,contact,owner,contact,owner,contact])!;
 return {unresolved:count(result.unresolved),metadataOnly:count(result.metadataOnly)};
}
export const unresolvedQuarantineCount=(tx:StorageTransaction,owner:string,contact:string):number=>quarantineSummary(tx,owner,contact).unresolved;
