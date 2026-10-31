import { StorageFailure, type StorageTransaction, type StorageRow } from '../../storage/sqlite/contracts.ts';
import type { HistoryCoverage, HistoryIncrementalCoverage, HistoryRead, StoredMessage } from './contracts.ts';
import {quarantineSummary} from './quarantine.ts';
import {currentSourceScopeCTE,currentSourcePredicate,currentGoalPredicate} from './current-scope.ts';
const currentMessageSource=`EXISTS (SELECT 1 FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id
 JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id
 AND r.state='normalized' AND r.availability='available' AND ${currentSourcePredicate()})`;
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
 const historyGoal=tx.get(`WITH ${currentSourceScopeCTE} SELECT g.*,count(*) OVER() goal_count FROM read_goal g WHERE g.owner_id=? AND g.contact_id=? AND g.kind='history' AND ${currentGoalPredicate('g')} ORDER BY g.creation_no DESC,g.created_at DESC,g.id DESC LIMIT 1`,[owner,contact,contact,owner,contact]);
 const incrementalGoal=tx.get(`WITH ${currentSourceScopeCTE} SELECT g.*,count(*) OVER() goal_count FROM read_goal g WHERE g.owner_id=? AND g.contact_id=? AND g.kind='incremental' AND ${currentGoalPredicate('g')} ORDER BY g.creation_no DESC,g.created_at DESC,g.id DESC LIMIT 1`,[owner,contact,contact,owner,contact]);
 const legacyAmbiguous=historyGoal?.creation_no===null&&(historyGoal.goal_count as bigint)>1n;
 const goal=legacyAmbiguous?{...historyGoal,state:'incomplete',failure_code:'history_goal_order_unverified',cursor:null}:historyGoal;
 const safeIncremental=incrementalGoal?.creation_no===null?{...incrementalGoal,state:'incomplete',failure_code:'history_goal_order_unverified',cursor:null}:incrementalGoal;
 const continuityBlocked=Boolean(tx.get(`SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=? UNION ALL
  SELECT 1 FROM history_guard_lease g JOIN database_instance d ON d.slot=1 WHERE g.owner_id=? AND g.contact_id=? AND (g.state<>'active' OR g.runtime_id<>d.runtime_id) LIMIT 1`,[owner,contact,owner,contact]));
 const blockedBinding=continuityBlocked&&!goal?tx.get("SELECT id FROM conversation_binding WHERE owner_id=? AND contact_id=? AND state='verified'",[owner,contact]):undefined;
 const counts=tx.get(`WITH ${currentSourceScopeCTE} SELECT count(*) AS messages,count(CASE WHEN kind<>'text' THEN 1 END) AS nontext FROM message m WHERE owner_id=? AND contact_id=? AND availability='available' AND NOT EXISTS (SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id) AND ${currentMessageSource}`,[owner,contact,contact,owner,contact])!;
 const pages=goal?tx.get('SELECT count(*) AS n FROM sync_capture WHERE owner_id=? AND contact_id=? AND goal_id=?',[owner,contact,goal.id])!.n:0n;
 const summary=quarantineSummary(tx,owner,contact),quarantined=summary.unresolved;
 const stateQuarantined=quarantined>0||Boolean(tx.get(`WITH ${currentSourceScopeCTE} SELECT 1 FROM history_message_quarantine q JOIN message m
  ON m.owner_id=q.owner_id AND m.contact_id=q.contact_id AND m.id=q.message_id WHERE q.owner_id=? AND q.contact_id=?
  AND q.reason NOT IN ('source_recalled','source_absent','source_system_replaced') AND ${currentMessageSource} LIMIT 1`,[owner,contact,contact,owner,contact]));
 let traversalComplete=false;
 if(!continuityBlocked&&!legacyAmbiguous&&goal?.cursor===null&&['complete','incomplete'].includes(String(goal.state))){
  try{
   const target=JSON.parse(String(goal.target_json)),completed=JSON.parse(String(goal.completed_partitions));
   traversalComplete=Array.isArray(target.partitions)&&target.partitions.length>0&&Array.isArray(completed)
    &&target.partitions.every((partition:unknown)=>completed.includes(partition));
  }catch{/* 缺少可核验的目标或覆盖记录时不推断遍历已完成。 */}
 }
 let normalUseTraversal=false;
 if(traversalComplete)try{normalUseTraversal=JSON.parse(String(goal?.support_json)).continuity==='same-source-instances-normal-use-v1';}catch{/* 未知支持档沿用保守状态。 */}
 // 后续认证可补齐已经遍历完毕的历史，但不能掩盖分片缺失或读取中断。
 const resolvedGoal=traversalComplete&&!stateQuarantined&&goal?.state==='incomplete'&&goal.failure_code==='history_identity_quarantined'
  ?{...goal,state:'complete',failure_code:null}:goal;
 return {goalId:goal?String(goal.id):null,contactId:contact,bindingId:goal?String(goal.binding_id):blockedBinding?String(blockedBinding.id):null,traversalComplete,
  phase:continuityBlocked||stateQuarantined?'incomplete':!resolvedGoal?'not_started':resolvedGoal.state==='running'?'running':resolvedGoal.state==='complete'?'complete':'incomplete',
  failureCode:continuityBlocked?'history_source_continuity_unverified':stateQuarantined?'history_identity_quarantined':resolvedGoal?.failure_code?String(resolvedGoal.failure_code):null,cursor:goal?.cursor?String(goal.cursor):null,
  messageCount:safeCount(counts.messages),nonTextCount:safeCount(counts.nontext),pageCount:safeCount(pages),quarantinedCount:quarantined,metadataOnlyCount:summary.metadataOnly,
  incremental:continuityBlocked?{...incrementalCoverage(resolvedGoal,safeIncremental),phase:'invalidated',failureCode:'history_source_continuity_unverified'}:stateQuarantined&&!normalUseTraversal?{...incrementalCoverage(resolvedGoal,safeIncremental),phase:'incomplete',failureCode:'history_identity_quarantined'}:incrementalCoverage(resolvedGoal,safeIncremental)};
}
function readRows(tx:StorageTransaction,owner:string,contact:string,coverage:HistoryCoverage,rows:StorageRow[]):HistoryRead {
 const sources=new Map<string,string[]>();
 if(rows.length)for(const source of tx.all(`WITH ${currentSourceScopeCTE} SELECT r.id,r.message_id FROM capture_record r
  JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
  WHERE r.owner_id=? AND r.contact_id=? AND r.message_id IN (${rows.map(()=>'?').join(',')}) AND r.state='normalized' AND r.availability='available'
  AND ${currentSourcePredicate()} ORDER BY r.id`,[owner,contact,contact,owner,contact,...rows.map(row=>row.id)])){
   const key=String(source.message_id),existing=sources.get(key);if(existing)existing.push(String(source.id));else sources.set(key,[String(source.id)]);
  }
 const messages=rows.map(r=>({id:String(r.id),contactId:contact,bindingId:String(r.binding_id),sender:r.sender_role,
  kind:r.kind,text:r.text_body,originalType:r.original_type,sentAt:r.sent_at===null?null:String(r.sent_at),timePrecision:r.time_precision,
  orderScheme:r.order_scheme,orderKey:r.order_key,status:r.status_code===null||r.status_code===undefined?null:String(r.status_code),
  displayPosition:String(r.display_no),ordering:'unknown',
  sourceRecordIds:sources.get(String(r.id))??[]})) as StoredMessage[];
 return {messages,coverage,replyEligibility:coverage.phase==='complete'?'ready':coverage.phase==='incomplete'?'history_incomplete':'history_syncing'};
}
export function readMessages(tx:StorageTransaction,owner:string,contact:string,limit=101,before?:string):HistoryRead {
 const coverage=readCoverage(tx,owner,contact);
 if(!Number.isSafeInteger(limit)||limit<1||limit>101)throw new StorageFailure('history_request_invalid');
 const cursor=before?tx.get('SELECT display_no FROM message WHERE owner_id=? AND contact_id=? AND id=?',[owner,contact,before]):undefined;
 if(before&&!cursor)throw new StorageFailure('history_cursor_invalid');
 const rows=tx.all(`WITH ${currentSourceScopeCTE} SELECT * FROM message m WHERE owner_id=? AND contact_id=? AND availability='available' AND NOT EXISTS (SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id) AND ${currentMessageSource}${cursor?' AND display_no<?':''} ORDER BY display_no DESC LIMIT ?`,cursor?[owner,contact,contact,owner,contact,cursor.display_no,limit]:[owner,contact,contact,owner,contact,limit]);
 return readRows(tx,owner,contact,coverage,rows);
}
/** 候选工作区按有时间的文字消息选最新材料；不改变历史页的 display_no 游标语义。 */
export function readRecentMessages(tx:StorageTransaction,owner:string,contact:string,limit=50):HistoryRead {
 const coverage=readCoverage(tx,owner,contact);
 if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new StorageFailure('history_request_invalid');
 const rows=tx.all(`WITH ${currentSourceScopeCTE} SELECT * FROM message m WHERE owner_id=? AND contact_id=? AND availability='available'
  AND kind='text' AND text_body IS NOT NULL AND length(text_body)>0 AND sent_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)
  AND ${currentMessageSource} ORDER BY sent_at DESC,display_no DESC LIMIT ?`,[owner,contact,contact,owner,contact,limit]);
 return readRows(tx,owner,contact,coverage,rows);
}
