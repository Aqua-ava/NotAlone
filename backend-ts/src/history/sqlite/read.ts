import { StorageFailure, type StorageTransaction, type StorageRow } from '../../storage/sqlite/contracts.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistoryCoverage, HistoryIncrementalCoverage, HistoryRead, HistoryQuoteErrorCode, HistorySupportReport, HistoryTarget, StoredHistoryQuote, StoredMessage } from './contracts.ts';
import {quarantineSummary} from './quarantine.ts';
import {currentSourceScopeCTE,currentSourcePredicate,currentGoalPredicate} from './current-scope.ts';
import { displayMessageType, messageTypeLabels, type HistoryMessageType, type NonTextTypeCount } from './message-types.ts';
const currentMessageSource=`EXISTS (SELECT 1 FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id
 JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id
 AND r.state='normalized' AND r.availability='available' AND ${currentSourcePredicate()})`;
function safeCount(value:unknown):number {if(typeof value!=='bigint'||value<0n||value>BigInt(Number.MAX_SAFE_INTEGER))throw new StorageFailure('history_count_out_of_range');return Number(value);}
function safeTime(value:unknown):number|null {if(value===null||value===undefined)return null;if(typeof value!=='bigint'||value<0n||value>BigInt(Number.MAX_SAFE_INTEGER))throw new StorageFailure('history_time_out_of_range');return Number(value);}
const absentPrivateTargetProfile='wechat-4.0.6-29387-absent-private-target-v1';
const normalUseContinuity='same-source-instances-normal-use-v1';
const absentCapabilities=['normalHistory','snapshotBarrier','partitionCoverage','sourceLifecycle','restartContinuity','recoveryMapping'] as const;
function sameStrings(left:unknown,right:unknown):boolean {
 if(!Array.isArray(left)||!Array.isArray(right)||left.length!==right.length||left.some(value=>typeof value!=='string'||!value)
  ||right.some(value=>typeof value!=='string'||!value))return false;
 const a=[...left].sort(),b=[...right].sort();return a.every((value,index)=>value===b[index]);
}
/** 空范围只在命名的已支持profile、完整文件清单、当前授权来源及无围栏都成立时可低频重探。 */
export function isCertifiedEmptyTarget(tx:StorageTransaction,token:ReadEligibility,report:HistorySupportReport,target:HistoryTarget):boolean {
 if(report?.profileId!==absentPrivateTargetProfile||report.status!=='supported'||report.protocol!=='private-history-v1'
  ||report.continuity!==normalUseContinuity||report.statusSemantics!=='no-message-table-v1'||report.declaredPrimaryKey.length!==0
  ||report.capabilities?.partitionGrowth!=='supported'||report.capabilities.incrementalTail!=='unsupported'
  ||absentCapabilities.some(key=>report.capabilities?.[key]!=='supported')
  ||target?.protocol!=='private-history-v1'||target.sourceGeneration!==token.source_generation
  ||!Array.isArray(target.tables)||target.tables.length!==0||!Array.isArray(target.partitions)||target.partitions.length===0
  ||!Array.isArray(target.checkedPartitions)||target.checkedPartitions.length===0
  ||new Set(target.partitions).size!==target.partitions.length||new Set(target.checkedPartitions).size!==target.checkedPartitions.length
  ||!sameStrings(target.partitions,target.checkedPartitions))return false;
 if(tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]))return false;
 const current=tx.get(`SELECT o.owner_id,p.id AS contact_id,a.id AS account_id,c.id AS conversation_id,b.id AS binding_id,
  g.id AS grant_id,v.id AS verification_id,o.read_epoch,p.selection_generation,p.data_generation,b.identity_generation,
  a.scope_revision,c.barrier_generation,a.source_generation,a.external_key AS account_key,c.external_key AS conversation_key
  FROM owner o JOIN contact p ON p.owner_id=o.owner_id JOIN conversation_binding b ON b.owner_id=p.owner_id AND b.contact_id=p.id
  JOIN channel_conversation c ON c.owner_id=b.owner_id AND c.id=b.conversation_id
  JOIN channel_account a ON a.owner_id=c.owner_id AND a.id=c.account_id
  JOIN read_grant g ON g.owner_id=b.owner_id AND g.contact_id=p.id AND g.binding_id=b.id
  JOIN binding_verification v ON v.owner_id=g.owner_id AND v.id=g.verification_id AND v.binding_id=b.id
  WHERE o.owner_id=? AND p.id=? AND o.state='active' AND p.state='active' AND b.state='verified'
   AND a.identity_state='verified' AND a.scope_mode='selected' AND g.revoked_at IS NULL
   AND g.selection_generation=p.selection_generation AND v.identity_generation=b.identity_generation`,[token.owner_id,token.contact_id]);
 if(!current)return false;
 for(const key of ['owner_id','contact_id','account_id','conversation_id','binding_id','grant_id','verification_id','selection_generation','data_generation',
  'identity_generation','scope_revision','barrier_generation','source_generation'] as const){
  if(String(current[key])!==token[key])return false;
 }
 if(report.accountKey!==current.account_key||report.conversationKey!==current.conversation_key||report.sourceGeneration!==current.source_generation)return false;
 const scope=tx.get('SELECT conversation_id,source_generation,tables_json FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
 if(!scope||scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation||typeof scope.tables_json!=='string')return false;
 try{
  const stored=JSON.parse(scope.tables_json) as {accountKey?:unknown;partitions?:unknown;tables?:unknown;checkedPartitions?:unknown};
  return stored.accountKey===report.accountKey&&Array.isArray(stored.tables)&&stored.tables.length===0
   &&sameStrings(stored.partitions,target.partitions)&&sameStrings(stored.checkedPartitions,target.checkedPartitions);
 }catch{return false;}
}
export function assertContact(tx:StorageTransaction,owner:string,contact:string):void {
 if(!tx.get("SELECT id FROM contact WHERE owner_id=? AND id=? AND state='active'",[owner,contact]))throw new StorageFailure('history_contact_not_found');
}
function incrementalCoverage(historyGoal:StorageRow|undefined,incrementalGoal:StorageRow|undefined,emptyTargetAwaitingMessages=false):HistoryIncrementalCoverage {
 if(incrementalGoal){
  const state=String(incrementalGoal.state);
  // 增量目标不会完成：running 表示已就绪待跟进，其余非运行态按不完整/失效投影。
  return {goalId:String(incrementalGoal.id),phase:state==='running'?'ready':state==='incomplete'?'incomplete':'invalidated',
   failureCode:incrementalGoal.failure_code===null||incrementalGoal.failure_code===undefined?null:String(incrementalGoal.failure_code),
   cursorPresent:Boolean(incrementalGoal.cursor),pagesAccepted:safeCount(incrementalGoal.pages_accepted as bigint),
   lastAcceptedAt:safeTime(incrementalGoal.last_accepted_at),resumedFromGoalId:incrementalGoal.handoff_from_goal_id===null||incrementalGoal.handoff_from_goal_id===undefined?null:String(incrementalGoal.handoff_from_goal_id)};
 }
 // 历史已完成但终页没有可证明无缺口的续读游标：增量保持不可用并可见，不宣称已持续同步。
 if(historyGoal&&String(historyGoal.state)==='complete'&&!historyGoal.resume_cursor)return {goalId:null,phase:'unavailable',failureCode:'history_incremental_unavailable',cursorPresent:false,pagesAccepted:0,lastAcceptedAt:null,resumedFromGoalId:null,
  ...(emptyTargetAwaitingMessages?{emptyTargetAwaitingMessages:true}:{})};
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
 const typeRows=tx.all(`WITH ${currentSourceScopeCTE} SELECT m.kind,m.original_type,count(*) AS n FROM message m WHERE owner_id=? AND contact_id=? AND availability='available' AND NOT EXISTS (SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id) AND ${currentMessageSource} GROUP BY m.kind,m.original_type`,[owner,contact,contact,owner,contact]);
 const counts={messages:0n,nontext:0n},typeCounts=new Map<HistoryMessageType,bigint>();
 for(const row of typeRows){
  const n=row.n as bigint;counts.messages+=n;
  if(row.kind==='text')continue;
  counts.nontext+=n;
  const type=displayMessageType({kind:row.kind as StoredMessage['kind'],originalType:String(row.original_type)});
  typeCounts.set(type,(typeCounts.get(type)??0n)+n);
 }
 const nonTextTypes:NonTextTypeCount[]=[];
 for(const type of Object.keys(messageTypeLabels) as HistoryMessageType[]){
  if(type==='text'||!typeCounts.has(type))continue;
  nonTextTypes.push({messageType:type,label:messageTypeLabels[type],count:safeCount(typeCounts.get(type))});
 }
 const pages=goal?tx.get('SELECT count(*) AS n FROM sync_capture WHERE owner_id=? AND contact_id=? AND goal_id=?',[owner,contact,goal.id])!.n:0n;
 const summary=quarantineSummary(tx,owner,contact),quarantined=summary.unresolved;
 const stateQuarantined=quarantined>0||Boolean(tx.get(`WITH ${currentSourceScopeCTE} SELECT 1 FROM history_message_quarantine q JOIN message m
  ON m.owner_id=q.owner_id AND m.contact_id=q.contact_id AND m.id=q.message_id WHERE q.owner_id=? AND q.contact_id=?
  AND q.reason NOT IN ('source_recalled','source_absent','source_system_replaced') AND ${currentMessageSource} LIMIT 1`,[owner,contact,contact,owner,contact]));
 let emptyTargetAwaitingMessages=false;
 if(!legacyAmbiguous&&goal?.state==='complete'&&goal.failure_code===null&&goal.resume_cursor===null&&!stateQuarantined
  &&counts.messages===0n&&counts.nontext===0n&&summary.metadataOnly===0){
  try{
   const token=JSON.parse(String(goal.eligibility_json)) as ReadEligibility;
   const report=JSON.parse(String(goal.support_json)) as HistorySupportReport;
   const target=JSON.parse(String(goal.target_json)) as HistoryTarget;
   const completed=JSON.parse(String(goal.completed_partitions)) as unknown;
   emptyTargetAwaitingMessages=Array.isArray(completed)&&sameStrings(completed,target.partitions)
    &&isCertifiedEmptyTarget(tx,token,report,target);
  }catch{/* 没有完整且当前可验证的空目标证明时仍保留普通不可用状态。 */}
 }
 let traversalComplete=false;
 if((!continuityBlocked||emptyTargetAwaitingMessages)&&!legacyAmbiguous&&goal?.cursor===null&&['complete','incomplete'].includes(String(goal.state))){
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
 const effectiveContinuityBlocked=continuityBlocked&&!emptyTargetAwaitingMessages;
 return {goalId:goal?String(goal.id):null,contactId:contact,bindingId:goal?String(goal.binding_id):blockedBinding?String(blockedBinding.id):null,traversalComplete,
  phase:effectiveContinuityBlocked||stateQuarantined?'incomplete':!resolvedGoal?'not_started':resolvedGoal.state==='running'?'running':resolvedGoal.state==='complete'?'complete':'incomplete',
  failureCode:effectiveContinuityBlocked?'history_source_continuity_unverified':stateQuarantined?'history_identity_quarantined':resolvedGoal?.failure_code?String(resolvedGoal.failure_code):null,cursor:goal?.cursor?String(goal.cursor):null,
  messageCount:safeCount(counts.messages),nonTextCount:safeCount(counts.nontext),nonTextTypes,pageCount:safeCount(pages),quarantinedCount:quarantined,metadataOnlyCount:summary.metadataOnly,
  incremental:effectiveContinuityBlocked?{...incrementalCoverage(resolvedGoal,safeIncremental),phase:'invalidated',failureCode:'history_source_continuity_unverified'}:stateQuarantined&&!normalUseTraversal?{...incrementalCoverage(resolvedGoal,safeIncremental),phase:'incomplete',failureCode:'history_identity_quarantined'}:incrementalCoverage(resolvedGoal,safeIncremental,emptyTargetAwaitingMessages)};
}
function readRows(tx:StorageTransaction,owner:string,contact:string,coverage:HistoryCoverage,rows:StorageRow[],includeQuotes=true):HistoryRead {
 const sources=new Map<string,string[]>();
 if(rows.length)for(const source of tx.all(`WITH ${currentSourceScopeCTE} SELECT r.id,r.message_id FROM capture_record r
  JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
  WHERE r.owner_id=? AND r.contact_id=? AND r.message_id IN (${rows.map(()=>'?').join(',')}) AND r.state='normalized' AND r.availability='available'
  AND ${currentSourcePredicate()} ORDER BY r.id`,[owner,contact,contact,owner,contact,...rows.map(row=>row.id)])){
   const key=String(source.message_id),existing=sources.get(key);if(existing)existing.push(String(source.id));else sources.set(key,[String(source.id)]);
  }
 const quotes=new Map<string,StoredHistoryQuote>();
 const quoteErrors=new Map<string,HistoryQuoteErrorCode>();
 if(includeQuotes&&rows.some(row=>row.original_type==='244813135921')){
  const selected=rows.filter(row=>row.original_type==='244813135921').map(row=>String(row.id));
  const safeQuoteErrors:readonly HistoryQuoteErrorCode[]=['history_quote_unavailable','history_quote_metadata_invalid','history_quote_too_large',
   'history_quote_state_unverified','history_quote_association_unverified','history_quote_read_failed'];
  for(const quote of tx.all(`WITH ${currentSourceScopeCTE}
   SELECT q.message_id,q.reply_text,q.referenced_text,q.referenced_sender,q.referenced_sender_role,q.referenced_type,q.referenced_server_id,
    EXISTS(SELECT 1 FROM history_source_exclusion excluded WHERE excluded.owner_id=q.owner_id AND excluded.conversation_id=qb.conversation_id
     AND excluded.scheme='server' AND excluded.external_key=q.referenced_server_id) target_excluded,
    CASE WHEN q.referenced_server_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM history_source_exclusion excluded
     WHERE excluded.owner_id=q.owner_id AND excluded.conversation_id=qb.conversation_id AND excluded.scheme='server'
      AND excluded.external_key=q.referenced_server_id) THEN (
     SELECT CASE WHEN count(DISTINCT target.id)=1 THEN min(target.id) END FROM message_alias alias
      JOIN message target ON target.owner_id=alias.owner_id AND target.contact_id=alias.contact_id AND target.id=alias.message_id
      JOIN capture_record tr ON tr.owner_id=target.owner_id AND tr.contact_id=target.contact_id AND tr.message_id=target.id
      JOIN sync_capture tc ON tc.owner_id=tr.owner_id AND tc.contact_id=tr.contact_id AND tc.id=tr.capture_id
      JOIN read_goal tg ON tg.owner_id=tc.owner_id AND tg.contact_id=tc.contact_id AND tg.id=tc.goal_id
      WHERE alias.owner_id=q.owner_id AND alias.contact_id=q.contact_id AND alias.binding_id=q.binding_id AND alias.scheme='server'
       AND alias.external_key=q.referenced_server_id AND target.binding_id=q.binding_id AND target.availability='available'
       AND tr.state='normalized' AND tr.availability='available' AND json_extract(tg.support_json,'$.serverAliasSemantics')='verified_within_scope'
       AND NOT EXISTS(SELECT 1 FROM history_message_quarantine tq WHERE tq.owner_id=target.owner_id AND tq.contact_id=target.contact_id AND tq.message_id=target.id)
       AND ${currentSourcePredicate('tr','tg')}
    ) ELSE NULL END resolved_target
   FROM history_quote q JOIN conversation_binding qb ON qb.owner_id=q.owner_id AND qb.contact_id=q.contact_id AND qb.id=q.binding_id AND qb.state='verified'
   JOIN message carrier ON carrier.owner_id=q.owner_id AND carrier.contact_id=q.contact_id AND carrier.id=q.message_id
   JOIN capture_record r ON r.owner_id=q.owner_id AND r.contact_id=q.contact_id AND r.id=q.source_record_id AND r.message_id=q.message_id
   JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
   JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
   JOIN contact p ON p.owner_id=q.owner_id AND p.id=q.contact_id AND p.state='active'
   JOIN owner o ON o.owner_id=q.owner_id AND o.state='active'
   WHERE q.owner_id=? AND q.contact_id=? AND q.message_id IN (${selected.map(()=>'?').join(',')})
    AND carrier.binding_id=q.binding_id AND carrier.kind='other' AND carrier.text_body IS NULL AND carrier.original_type='244813135921'
    AND carrier.availability='available' AND carrier.interpretation_revision=q.carrier_interpretation_revision
    AND r.state='normalized' AND r.availability='available' AND json_extract(g.target_json,'$.sourceGeneration')=q.source_generation
    AND NOT EXISTS(SELECT 1 FROM history_message_quarantine cq WHERE cq.owner_id=carrier.owner_id AND cq.contact_id=carrier.contact_id AND cq.message_id=carrier.id)
    AND ${currentSourcePredicate('r','g')}`,
   [owner,contact,contact,owner,contact,...selected])){
    const excluded=String(quote.target_excluded)==='1';
    const targetMessageId=excluded||quote.resolved_target===null||quote.resolved_target===undefined?null:String(quote.resolved_target);
    const referencedText=excluded||quote.referenced_text===null?null:String(quote.referenced_text);
    const referencedServerId=excluded||quote.referenced_server_id===null?null:String(quote.referenced_server_id);
    const referencedSender=excluded||quote.referenced_sender===null?null:String(quote.referenced_sender);
    const referencedType=excluded||quote.referenced_type===null?null:String(quote.referenced_type);
    const state:StoredHistoryQuote['state']=excluded?'unavailable':targetMessageId?'resolved':referencedText!==null||referencedServerId!==null?'unresolved':'unavailable';
    quotes.set(String(quote.message_id),{replyText:String(quote.reply_text),referencedText,
     referencedSender,referencedSenderRole:excluded?'unknown':String(quote.referenced_sender_role) as StoredHistoryQuote['referencedSenderRole'],
     referencedType,referencedServerId,targetMessageId,state});
  }
  const placeholders=selected.map(()=>'?').join(',');
  const quoteAttemptHasStableSourceKey=Boolean(tx.get("SELECT 1 FROM pragma_table_info('history_quote_attempt') WHERE name='source_key'"));
  if(quoteAttemptHasStableSourceKey)for(const failure of tx.all(`WITH ${currentSourceScopeCTE}
   SELECT m.id message_id,a.error_code FROM message m
   JOIN capture_record r ON r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id
   JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
   JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
   JOIN history_quote_attempt a ON a.owner_id=r.owner_id AND a.contact_id=r.contact_id AND a.message_id=m.id AND a.record_id=r.id
   WHERE m.owner_id=? AND m.contact_id=? AND m.id IN (${placeholders}) AND m.original_type='244813135921'
    AND m.kind='other' AND m.text_body IS NULL AND m.availability='available' AND r.state='normalized' AND r.availability='available'
    AND a.outcome='failed' AND a.error_code IN (${safeQuoteErrors.map(()=>'?').join(',')}) AND a.source_key=r.observed_key
    AND a.source_generation=json_extract(g.target_json,'$.sourceGeneration') AND a.carrier_interpretation_revision=m.interpretation_revision
    AND a.carrier_status=coalesce(m.status_code,'') AND g.binding_id=m.binding_id
    AND NOT EXISTS(SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)
    AND NOT EXISTS(SELECT 1 FROM history_quote stored WHERE stored.owner_id=m.owner_id AND stored.contact_id=m.contact_id AND stored.message_id=m.id
     AND stored.source_key=r.observed_key AND stored.source_generation=a.source_generation AND stored.carrier_interpretation_revision=m.interpretation_revision)
    AND ${currentSourcePredicate('r','g')}
   ORDER BY a.version DESC,a.error_code ASC`,
  [owner,contact,contact,owner,contact,...selected,...safeQuoteErrors])){
   const code=String(failure.error_code) as HistoryQuoteErrorCode,messageId=String(failure.message_id);
   if(!quoteErrors.has(messageId)&&safeQuoteErrors.includes(code))quoteErrors.set(messageId,code);
  }
 }
 const messages=rows.map(r=>({id:String(r.id),contactId:contact,bindingId:String(r.binding_id),sender:r.sender_role,
  kind:r.kind,text:r.text_body,originalType:r.original_type,sentAt:r.sent_at===null?null:String(r.sent_at),timePrecision:r.time_precision,
  orderScheme:r.order_scheme,orderKey:r.order_key,status:r.status_code===null||r.status_code===undefined?null:String(r.status_code),
  displayPosition:String(r.display_no),ordering:'unknown',
  sourceRecordIds:sources.get(String(r.id))??[],...(quotes.has(String(r.id))?{quote:quotes.get(String(r.id))}:{}),
  ...(quoteErrors.has(String(r.id))?{quoteErrorCode:quoteErrors.get(String(r.id))}:{})})) as StoredMessage[];
 return {messages,coverage,replyEligibility:coverage.phase==='complete'?'ready':coverage.phase==='incomplete'?'history_incomplete':'history_syncing'};
}
function readMessagePage(tx:StorageTransaction,owner:string,contact:string,limit:number,before:string|undefined,order:'stored'|'message-time'):HistoryRead {
 const coverage=readCoverage(tx,owner,contact);
 if(!Number.isSafeInteger(limit)||limit<1||limit>101)throw new StorageFailure('history_request_invalid');
 const cursor=before?tx.get('SELECT display_no,sent_at FROM message WHERE owner_id=? AND contact_id=? AND id=?',[owner,contact,before]):undefined;
 if(before&&!cursor)throw new StorageFailure('history_cursor_invalid');
 const timeOrder=order==='message-time';
 const after=cursor?timeOrder
  ?cursor.sent_at===null?' AND m.sent_at IS NULL AND m.display_no<?'
   :' AND (m.sent_at IS NULL OR m.sent_at<? OR (m.sent_at=? AND m.display_no<?))'
  :' AND m.display_no<?':'';
 const cursorValues=cursor?timeOrder&&cursor.sent_at!==null?[cursor.sent_at,cursor.sent_at,cursor.display_no]:[cursor.display_no]:[];
 const sorting=timeOrder?'m.sent_at IS NULL ASC,m.sent_at DESC,m.display_no DESC':'m.display_no DESC';
 const rows=tx.all(`WITH ${currentSourceScopeCTE} SELECT * FROM message m WHERE owner_id=? AND contact_id=? AND availability='available' AND NOT EXISTS (SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id) AND ${currentMessageSource}${after} ORDER BY ${sorting} LIMIT ?`,[owner,contact,contact,owner,contact,...cursorValues,limit]);
 return readRows(tx,owner,contact,coverage,rows);
}
export function readMessages(tx:StorageTransaction,owner:string,contact:string,limit=101,before?:string):HistoryRead {
 return readMessagePage(tx,owner,contact,limit,before,'stored');
}
/** 聊天按已知发送时间取最近消息；同时间及未知时间只用保存位置稳定分页，不认证因果。 */
export function readChatMessages(tx:StorageTransaction,owner:string,contact:string,limit=101,before?:string):HistoryRead {
 return readMessagePage(tx,owner,contact,limit,before,'message-time');
}
/** 候选工作区按有时间的文字消息选最新材料；不改变历史页的 display_no 游标语义。 */
export function readRecentMessages(tx:StorageTransaction,owner:string,contact:string,limit=50):HistoryRead {
 const coverage=readCoverage(tx,owner,contact);
 if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new StorageFailure('history_request_invalid');
 const rows=tx.all(`WITH ${currentSourceScopeCTE} SELECT * FROM message m WHERE owner_id=? AND contact_id=? AND availability='available'
  AND kind='text' AND text_body IS NOT NULL AND length(text_body)>0 AND sent_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)
  AND ${currentMessageSource} ORDER BY sent_at DESC,display_no DESC LIMIT ?`,[owner,contact,contact,owner,contact,limit]);
 return readRows(tx,owner,contact,coverage,rows,false);
}
