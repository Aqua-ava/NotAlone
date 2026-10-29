import { StorageFailure, type StorageTransaction, type StorageRow } from '../../storage/sqlite/contracts.ts';
import type { HistoryCoverage, HistoryIncrementalCoverage, HistoryRead, StoredMessage } from './contracts.ts';
function safeCount(value:unknown):number {if(typeof value!=='bigint'||value<0n||value>BigInt(Number.MAX_SAFE_INTEGER))throw new StorageFailure('history_count_out_of_range');return Number(value);}
function safeTime(value:unknown):number|null {if(value===null||value===undefined)return null;if(typeof value!=='bigint'||value<0n||value>BigInt(Number.MAX_SAFE_INTEGER))throw new StorageFailure('history_time_out_of_range');return Number(value);}
export function assertContact(tx:StorageTransaction,owner:string,contact:string):void {
 if(!tx.get("SELECT id FROM contact WHERE owner_id=? AND id=? AND state='active'",[owner,contact]))throw new StorageFailure('history_contact_not_found');
}
function incrementalCoverage(historyGoal:StorageRow|undefined,incrementalGoal:StorageRow|undefined):HistoryIncrementalCoverage {
 if(incrementalGoal){
  const state=String(incrementalGoal.state);
  // 增量目标不会完成：running 表示已就绪待跟进，其余非运行态按不完整/失效投影。
  return {goalId:String(incrementalGoal.id),phase:state==='running'?'ready':state==='incomplete'?'incomplete':'invalidated',
   failureCode:incrementalGoal.failure_code===null||incrementalGoal.failure_code===undefined?null:String(incrementalGoal.failure_code),
   cursorPresent:Boolean(incrementalGoal.cursor),pagesAccepted:safeCount(incrementalGoal.pages_accepted as bigint),
   lastAcceptedAt:safeTime(incrementalGoal.last_accepted_at),resumedFromGoalId:incrementalGoal.handoff_from_goal_id===null||incrementalGoal.handoff_from_goal_id===undefined?null:String(incrementalGoal.handoff_from_goal_id)};
 }
 // 历史已完成但终页没有可证明无缺口的续读游标：增量保持不可用并可见，不宣称已持续同步。
 if(historyGoal&&String(historyGoal.state)==='complete'&&!historyGoal.resume_cursor)return {goalId:null,phase:'unavailable',failureCode:'history_incremental_unavailable',cursorPresent:false,pagesAccepted:0,lastAcceptedAt:null,resumedFromGoalId:null};
 return {goalId:null,phase:'not_started',failureCode:null,cursorPresent:false,pagesAccepted:0,lastAcceptedAt:null,resumedFromGoalId:null};
}
/** 历史目标与增量目标分别取各自最新一行；增量交接不得把历史阶段覆盖成运行中。 */
export function readCoverage(tx:StorageTransaction,owner:string,contact:string):HistoryCoverage {
 assertContact(tx,owner,contact);
 const historyGoal=tx.get("SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND kind='history' ORDER BY created_at DESC,rowid DESC LIMIT 1",[owner,contact]);
 const incrementalGoal=tx.get("SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND kind='incremental' ORDER BY created_at DESC,rowid DESC LIMIT 1",[owner,contact]);
 const goal=historyGoal;
 const counts=tx.get("SELECT count(*) AS messages,count(CASE WHEN kind<>'text' THEN 1 END) AS nontext FROM message m WHERE owner_id=? AND contact_id=? AND availability='available' AND EXISTS (SELECT 1 FROM capture_record r WHERE r.owner_id=m.owner_id AND r.message_id=m.id AND r.state='normalized' AND r.availability='available')",[owner,contact])!;
 const pages=goal?tx.get('SELECT count(*) AS n FROM sync_capture WHERE owner_id=? AND goal_id=?',[owner,goal.id])!.n:0n;
 const quarantined=tx.get("SELECT count(*) AS n FROM capture_record WHERE owner_id=? AND contact_id=? AND state='quarantined' AND availability='available'",[owner,contact])!.n;
 return {goalId:goal?String(goal.id):null,contactId:contact,bindingId:goal?String(goal.binding_id):null,
  phase:!goal?'not_started':goal.state==='running'?'running':goal.state==='complete'?'complete':'incomplete',
  failureCode:goal?.failure_code?String(goal.failure_code):null,cursor:goal?.cursor?String(goal.cursor):null,
  messageCount:safeCount(counts.messages),nonTextCount:safeCount(counts.nontext),pageCount:safeCount(pages),quarantinedCount:safeCount(quarantined),
  incremental:incrementalCoverage(historyGoal,incrementalGoal)};
}
export function readMessages(tx:StorageTransaction,owner:string,contact:string,limit=101,before?:string):HistoryRead {
 const coverage=readCoverage(tx,owner,contact);
 if(!Number.isSafeInteger(limit)||limit<1||limit>101)throw new StorageFailure('history_request_invalid');
 const cursor=before?tx.get('SELECT display_no FROM message WHERE owner_id=? AND contact_id=? AND id=?',[owner,contact,before]):undefined;
 if(before&&!cursor)throw new StorageFailure('history_cursor_invalid');
 const rows=tx.all(`SELECT * FROM message m WHERE owner_id=? AND contact_id=? AND availability='available' AND EXISTS (SELECT 1 FROM capture_record r WHERE r.owner_id=m.owner_id AND r.message_id=m.id AND r.state='normalized' AND r.availability='available')${cursor?' AND display_no<?':''} ORDER BY display_no DESC LIMIT ?`,cursor?[owner,contact,cursor.display_no,limit]:[owner,contact,limit]);
 const messages=rows.map(r=>({id:String(r.id),contactId:contact,bindingId:String(r.binding_id),sender:r.sender_role,
  kind:r.kind,text:r.text_body,originalType:r.original_type,sentAt:r.sent_at===null?null:String(r.sent_at),timePrecision:r.time_precision,
  orderScheme:r.order_scheme,orderKey:r.order_key,status:r.status_code===null||r.status_code===undefined?null:String(r.status_code),
  displayPosition:String(r.display_no),ordering:'unknown',
  sourceRecordIds:tx.all("SELECT id FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id=? AND state='normalized' AND availability='available' ORDER BY id",[owner,contact,r.id]).map(v=>String(v.id))})) as StoredMessage[];
 return {messages,coverage,replyEligibility:coverage.phase==='complete'?'ready':coverage.phase==='incomplete'?'history_incomplete':'history_syncing'};
}
