import {StorageFailure,type StorageAction,type StorageRow,type StorageTransaction} from '../../storage/sqlite/contracts.ts';

/**
 * 开发者批量来源重新认证的只读候选聚合（ADR-173、规格 6.2）。
 * 只读取当前激活、有有效读取授权且仍被围栏的联系人；只返回联系人 ID、围栏/资格标记与计数，
 * 不含名称、正文、来源证明或任何可写能力。计数由单条按联系人分组查询得出，
 * 已存在于 message/media_file 索引上完成，不在每位联系人上重算大范围相关子查询。
 * SQL 常量导出仅用于回归测试核对实际 EXPLAIN QUERY PLAN，不参与产品装配。
 */
export const recertifyCandidateIdsSql = `SELECT c.id AS contact_id,
 count(m.id) AS stored_message_count,
 count(CASE WHEN m.kind='image' THEN 1 END) AS image_message_count,
 count(CASE WHEN m.kind='image' AND NOT EXISTS (
  SELECT 1 FROM media_file f WHERE f.owner_id=m.owner_id AND f.contact_id=m.contact_id AND f.message_id=m.id
  AND f.role='image_display' AND f.publish_state='current' AND f.content_state='present'
  AND f.container_valid=1 AND f.viewable=1) THEN 1 END) AS image_unsaved_count
FROM contact c
JOIN owner o ON o.owner_id=c.owner_id AND o.state='active' AND o.read_enabled=1
JOIN read_grant g ON g.owner_id=c.owner_id AND g.contact_id=c.id AND g.revoked_at IS NULL
JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id AND b.state='verified'
JOIN channel_conversation v ON v.owner_id=b.owner_id AND v.id=b.conversation_id
JOIN binding_verification bv ON bv.owner_id=g.owner_id AND bv.id=g.verification_id AND bv.binding_id=b.id
JOIN channel_account a ON a.owner_id=v.owner_id AND a.id=v.account_id
JOIN history_continuity_fence f ON f.owner_id=c.owner_id AND f.contact_id=c.id
LEFT JOIN message m ON m.owner_id=c.owner_id AND m.contact_id=c.id
WHERE c.owner_id=? AND c.state='active'
 AND g.selection_generation=c.selection_generation AND bv.identity_generation=b.identity_generation
 AND a.identity_state='verified' AND a.scope_mode='selected'
GROUP BY c.id
ORDER BY image_unsaved_count DESC, stored_message_count ASC, c.id ASC`;

/** 单联系人复核：联系人可能已不再围栏或授权已变化，因此同时返回围栏与资格标记供批量重跑判定。 */
export const recertifyCandidateStateSql = `SELECT c.id AS contact_id,
 EXISTS(SELECT 1 FROM history_continuity_fence f WHERE f.owner_id=c.owner_id AND f.contact_id=c.id) AS fenced,
 EXISTS(SELECT 1 FROM owner o
  JOIN read_grant g ON g.owner_id=o.owner_id AND g.contact_id=c.id AND g.revoked_at IS NULL
  JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id AND b.state='verified'
  JOIN channel_conversation v ON v.owner_id=b.owner_id AND v.id=b.conversation_id
  JOIN binding_verification bv ON bv.owner_id=g.owner_id AND bv.id=g.verification_id AND bv.binding_id=b.id
  JOIN channel_account a ON a.owner_id=v.owner_id AND a.id=v.account_id
  WHERE o.owner_id=c.owner_id AND o.state='active' AND o.read_enabled=1
   AND g.selection_generation=c.selection_generation AND bv.identity_generation=b.identity_generation
   AND a.identity_state='verified' AND a.scope_mode='selected') AS eligible
FROM contact c WHERE c.owner_id=? AND c.id=? AND c.state='active'`;

/** 单联系人计数；参数顺序 ownerId、contactId。 */
export const recertifyCandidateCountsSql = `SELECT count(m.id) AS stored_message_count,
 count(CASE WHEN m.kind='image' THEN 1 END) AS image_message_count,
 count(CASE WHEN m.kind='image' AND NOT EXISTS (
  SELECT 1 FROM media_file f WHERE f.owner_id=m.owner_id AND f.contact_id=m.contact_id AND f.message_id=m.id
  AND f.role='image_display' AND f.publish_state='current' AND f.content_state='present'
  AND f.container_valid=1 AND f.viewable=1) THEN 1 END) AS image_unsaved_count
FROM message m WHERE m.owner_id=? AND m.contact_id=?`;

export interface HistoryRecertifyCandidateRow {
  contact_id: string;
  fenced: boolean;
  eligible: boolean;
  stored_message_count: number;
  image_message_count: number;
  image_unsaved_count: number;
}
export interface HistoryRecertifyCandidates {
  read_enabled: boolean;
  fenced_total: number;
  contacts: HistoryRecertifyCandidateRow[];
  total: number;
  with_unsaved_images: number;
  message_total: number;
  image_unsaved_total: number;
}
const fail=(code:string):never=>{throw new StorageFailure(code);};
/** 只接受本地存储使用的稳定 ID 形状；不把调用方输入直接拼进 SQL。 */
const identifier=(value:unknown):string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)?value:fail('history_recertify_candidate_invalid');
const count=(value:unknown):number=>{
 if(typeof value!=='bigint'||value<0n||value>BigInt(Number.MAX_SAFE_INTEGER))return fail('history_recertify_candidate_invalid');
 return Number(value);
};
const flag=(value:unknown):boolean=>typeof value==='bigint'?value!==0n:value===1||value===true;
const readEnabled=(tx:StorageTransaction,ownerId:string):boolean=>Boolean(tx.get("SELECT 1 FROM owner WHERE owner_id=? AND state='active' AND read_enabled=1",[ownerId]));
const counts=(row:StorageRow):Pick<HistoryRecertifyCandidateRow,'stored_message_count'|'image_message_count'|'image_unsaved_count'>=>({
 stored_message_count:count(row.stored_message_count),image_message_count:count(row.image_message_count),image_unsaved_count:count(row.image_unsaved_count)});
const totals=(row:HistoryRecertifyCandidateRow)=>({contacts:[row],total:row.fenced&&row.eligible?1:0,
 with_unsaved_images:row.image_unsaved_count>0?1:0,message_total:row.stored_message_count,image_unsaved_total:row.image_unsaved_count});
export const historyRecertifyCandidatesActions:StorageAction[]=[
 {name:'history.recertifyCandidates',mode:'read',retryBusy:false,execute:(tx,input:any)=>{
  const ownerId=identifier(input?.ownerId);
  const rows=tx.all(recertifyCandidateIdsSql,[ownerId]).map((row:StorageRow):HistoryRecertifyCandidateRow=>({
   contact_id:String(row.contact_id),fenced:true,eligible:true,...counts(row)}));
  const fencedTotal=count(tx.get("SELECT count(*) AS n FROM history_continuity_fence f JOIN contact c ON c.owner_id=f.owner_id AND c.id=f.contact_id WHERE f.owner_id=? AND c.state='active'",[ownerId])!.n);
  return {read_enabled:readEnabled(tx,ownerId),fenced_total:fencedTotal,contacts:rows,total:rows.length,
   with_unsaved_images:rows.filter(row=>row.image_unsaved_count>0).length,
   message_total:rows.reduce((sum,row)=>sum+row.stored_message_count,0),
   image_unsaved_total:rows.reduce((sum,row)=>sum+row.image_unsaved_count,0)};
 }},
 {name:'history.recertifyCandidateState',mode:'read',retryBusy:false,execute:(tx,input:any)=>{
  const ownerId=identifier(input?.ownerId),contactId=identifier(input?.contactId);
  const state=tx.get(recertifyCandidateStateSql,[ownerId,contactId]);
  // 联系人已删除或不再激活时没有行；批量以“已不再围栏”结束该位。
  if(!state)return {read_enabled:readEnabled(tx,ownerId),fenced_total:0,contacts:[],total:0,with_unsaved_images:0,message_total:0,image_unsaved_total:0};
  const row:HistoryRecertifyCandidateRow={contact_id:String(state.contact_id),fenced:flag(state.fenced),eligible:flag(state.eligible),...counts(tx.get(recertifyCandidateCountsSql,[ownerId,contactId])!)};
  return {read_enabled:readEnabled(tx,ownerId),fenced_total:row.fenced?1:0,...totals(row)};
 }},
];
