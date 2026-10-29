import { StorageFailure, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { HistoryCoverage, HistoryRead, StoredMessage } from './contracts.ts';
export function assertContact(tx:StorageTransaction,owner:string,contact:string):void {
 if(!tx.get("SELECT id FROM contact WHERE owner_id=? AND id=? AND state='active'",[owner,contact]))throw new StorageFailure('history_contact_not_found');
}
export function readCoverage(tx:StorageTransaction,owner:string,contact:string):HistoryCoverage {
 assertContact(tx,owner,contact);
 const goal=tx.get('SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',[owner,contact]);
 const counts=tx.get("SELECT count(*) AS messages,count(CASE WHEN kind<>'text' THEN 1 END) AS nontext FROM message WHERE owner_id=? AND contact_id=? AND availability='available'",[owner,contact])!;
 const pages=goal?tx.get('SELECT count(*) AS n FROM sync_capture WHERE owner_id=? AND goal_id=?',[owner,goal.id])!.n:0n;
 const quarantined=tx.get("SELECT count(*) AS n FROM capture_record WHERE owner_id=? AND contact_id=? AND state='quarantined'",[owner,contact])!.n;
 return {goalId:goal?String(goal.id):null,contactId:contact,bindingId:goal?String(goal.binding_id):null,
  phase:!goal?'not_started':goal.state==='running'?'running':goal.state==='complete'?'complete':'incomplete',
  failureCode:goal?.failure_code?String(goal.failure_code):null,cursor:goal?.cursor?String(goal.cursor):null,
  messageCount:Number(counts.messages),nonTextCount:Number(counts.nontext),pageCount:Number(pages),quarantinedCount:Number(quarantined)};
}
export function readMessages(tx:StorageTransaction,owner:string,contact:string,limit=101,before?:string):HistoryRead {
 const coverage=readCoverage(tx,owner,contact);
 if(!Number.isSafeInteger(limit)||limit<1||limit>101)throw new StorageFailure('history_request_invalid');
 const cursor=before?tx.get('SELECT display_no FROM message WHERE owner_id=? AND contact_id=? AND id=?',[owner,contact,before]):undefined;
 if(before&&!cursor)throw new StorageFailure('history_cursor_invalid');
 const rows=tx.all(`SELECT * FROM message WHERE owner_id=? AND contact_id=? AND availability='available'${cursor?' AND display_no<?':''} ORDER BY display_no DESC LIMIT ?`,cursor?[owner,contact,cursor.display_no,limit]:[owner,contact,limit]);
 const messages=rows.map(r=>({id:String(r.id),contactId:contact,bindingId:String(r.binding_id),sender:r.sender_role,
  kind:r.kind,text:r.text_body,originalType:r.original_type,sentAt:r.sent_at===null?null:String(r.sent_at),timePrecision:r.time_precision,
  orderScheme:r.order_scheme,orderKey:r.order_key,displayPosition:String(r.display_no),ordering:r.order_scheme?'verified':'unknown',
  sourceRecordIds:tx.all("SELECT id FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id=? AND state='normalized' ORDER BY id",[owner,contact,r.id]).map(v=>String(v.id))})) as StoredMessage[];
 return {messages,coverage,replyEligibility:coverage.phase==='complete'?'ready':coverage.phase==='incomplete'?'history_incomplete':'history_syncing'};
}
