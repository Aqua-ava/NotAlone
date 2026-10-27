import type pg from 'pg';

export type ProcessingUnit='messages'|'memories'|'steps';
export interface ProcessingHistoryEntry {
 task_id:string;round_id:string|null;contact_id:string|null;task_type:string;status:string;phase:string;
 processed_count:number|null;total_count:number|null;unit:ProcessingUnit|null;updated_at:string;reason_code:string|null;attribution:'verified'|'legacy';
}
export interface ProcessingHistory {entries:ProcessingHistoryEntry[];next_cursor:string|null}
interface Cursor {owner:string;contact:string|null;at:string;id:string}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function historyCursor(raw:string|null,owner:string,contact:string|null):Cursor|null {
 if(raw===null)return null;
 if(!/^[A-Za-z0-9_-]{1,2048}$/.test(raw))throw Error('memory_processing_cursor_invalid');
 const value=JSON.parse(Buffer.from(raw,'base64url').toString('utf8')) as Cursor;
 if(!value||Object.keys(value).sort().join(',')!=='at,contact,id,owner'||value.owner!==owner||value.contact!==contact
  ||typeof value.id!=='string'||!uuid.test(value.id)||typeof value.at!=='string'
  ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.at)||!Number.isFinite(Date.parse(value.at)))throw Error('memory_processing_cursor_invalid');
 return value;
}
/** 历史独立按范围分页；微秒时间边界避免同一毫秒的记录漏页。 */
export async function readProcessingHistory(c:pg.PoolClient,owner:string,contact:string|null,cursor:Cursor|null):Promise<ProcessingHistory>{
 const rows=(await c.query(`SELECT t.id,t.contact_id,t.task_type,t.status,t.current_step,t.last_error_code,
  to_char(t.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
  membership.round_id,plan.task_id IS NOT NULL AS planned,
  (SELECT count(*)::int FROM memory_processing_target target WHERE target.task_id=t.id) AS total,
  (SELECT count(*)::int FROM memory_processing_target target WHERE target.task_id=t.id AND target.completed_at IS NOT NULL) AS processed
  FROM background_task t LEFT JOIN memory_processing_plan plan ON plan.task_id=t.id
  LEFT JOIN LATERAL(SELECT link.round_id FROM memory_processing_round_task link JOIN memory_processing_round round ON round.id=link.round_id
   WHERE link.task_id=t.id AND link.owner_id=t.owner_id AND link.contact_id IS NOT DISTINCT FROM t.contact_id ORDER BY round.round_number DESC LIMIT 1) membership ON true
  WHERE t.owner_id=$1 AND t.contact_id IS NOT DISTINCT FROM $2::uuid AND t.task_type IN ('import','observation','layered_memory')
  AND ($3::timestamptz IS NULL OR (t.updated_at,t.id)<($3::timestamptz,$4::uuid))
  ORDER BY t.updated_at DESC,t.id DESC LIMIT 21`,[owner,contact,cursor?.at??null,cursor?.id??null])).rows;
 const selected=rows.slice(0,20),last=selected.at(-1);
 return {entries:selected.map(row=>({task_id:row.id,round_id:row.round_id??null,contact_id:row.contact_id,task_type:row.task_type,status:row.status,phase:row.current_step,
  processed_count:row.planned?row.processed:null,total_count:row.planned?row.total:null,unit:row.planned?'messages':null,
  updated_at:row.cursor_at,reason_code:row.last_error_code,attribution:row.round_id?'verified':'legacy'})),
  next_cursor:rows.length>20&&last?Buffer.from(JSON.stringify({owner,contact,at:last.cursor_at,id:last.id})).toString('base64url'):null};
}
