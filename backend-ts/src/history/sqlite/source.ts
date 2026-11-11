import { StorageFailure, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { MessageSourceReference } from './contracts.ts';
import {currentSourceScopeCTE,currentSourcePredicate} from './current-scope.ts';

/** 派生写者必须在自身接受结果的同一短事务复验实际来源，不能只核历史查询结果。 */
export function assertSourceEligibility(tx:StorageTransaction,ref:MessageSourceReference):void {
 assertSourcesEligibility(tx,[ref]);
}

function groupedReferences(refs:readonly MessageSourceReference[]){
 const groups=new Map<string,{ownerId:string;contactId:string;refs:Map<string,[string,string]>}>();
 for(const ref of refs){
  const key=JSON.stringify([ref.owner_id,ref.contact_id]);
  let group=groups.get(key);
  if(!group){group={ownerId:ref.owner_id,contactId:ref.contact_id,refs:new Map()};groups.set(key,group);}
  group.refs.set(JSON.stringify([ref.record_id,ref.message_id]),[ref.record_id,ref.message_id]);
 }
 return groups.values();
}
export type SourceEligibility=(tx:StorageTransaction,ref:MessageSourceReference)=>void;
const eligibleQuery=(projection:string,scopeCTE=currentSourceScopeCTE)=>`WITH ${scopeCTE},wanted AS (
 SELECT json_extract(value,'$[0]') record_id,json_extract(value,'$[1]') message_id FROM json_each(?)
 ) SELECT ${projection} FROM wanted w WHERE EXISTS (SELECT r.id FROM capture_record r
 JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id
 JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
 JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
 JOIN contact p ON p.owner_id=r.owner_id AND p.id=r.contact_id
 JOIN owner o ON o.owner_id=p.owner_id
 WHERE r.owner_id=? AND r.contact_id=? AND r.id=w.record_id AND r.message_id=w.message_id
 AND r.state='normalized' AND r.availability='available' AND m.availability='available'
 AND NOT EXISTS (SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)
 AND EXISTS (SELECT 1 FROM source_proof f WHERE f.owner_id=m.owner_id AND f.contact_id=m.contact_id AND f.state='ok')
 AND m.binding_id=g.binding_id AND p.state='active' AND o.state='active' AND ${currentSourcePredicate()})`;

/** 同一事务内按实际来源联系人批量核验，避免每条消息重新解析同一来源范围。 */
/** 仅可信装配使用；请求入口不接收来源资格策略。 */
export function sourceEligibility(scopeCTE:string):(tx:StorageTransaction,refs:readonly MessageSourceReference[])=>void {return (tx,refs)=>{
 for(const group of groupedReferences(refs)){
  const wanted=[...group.refs.values()];
  const valid=tx.get(eligibleQuery('count(*) AS valid_count',scopeCTE),[group.ownerId,group.contactId,group.contactId,JSON.stringify(wanted),group.ownerId,group.contactId]);
  if(valid?.valid_count!==BigInt(wanted.length))throw new StorageFailure('history_source_not_available');
 }
};}
export const assertSourcesEligibility=sourceEligibility(currentSourceScopeCTE);

/** 统计可用内容时保留批次中合法的实际来源；部分失效不掩盖其他消息。 */
/** 仅可信装配选择范围；请求入口不接收来源资格策略。 */
export function eligibleReferences(scopeCTE:string):(tx:StorageTransaction,refs:readonly MessageSourceReference[])=>MessageSourceReference[]{return (tx,refs)=>{
 const eligible=new Set<string>();
 for(const group of groupedReferences(refs)){
  const wanted=[...group.refs.values()];
  for(const row of tx.all(eligibleQuery('w.record_id,w.message_id',scopeCTE),[group.ownerId,group.contactId,group.contactId,JSON.stringify(wanted),group.ownerId,group.contactId])){
   eligible.add(JSON.stringify([group.ownerId,group.contactId,row.record_id,row.message_id]));
  }
 }
 return refs.filter(ref=>eligible.has(JSON.stringify([ref.owner_id,ref.contact_id,ref.record_id,ref.message_id])));
};}
export const eligibleSourceReferences=eligibleReferences(currentSourceScopeCTE);
