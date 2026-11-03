import type {StorageRow,StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {currentSourcePredicate} from '../../history/sqlite/current-scope.ts';
import {memoryIncrementalBaseline} from '../../storage/sqlite/message-order.ts';
import {currentContentAvailability,hasMemoryContent,installedMemoryContentKinds} from './content.ts';
import {fail} from './qualification.ts';

interface InputScope {ownerId:string;contactId:string;scopeCte:string;sourceOrder:string}
interface InputRows extends InputScope {pendingOnly?:boolean}
interface Stats {count:number;oldestAt:number|null;latestAt:number|null}
interface Inputs {all?:StorageRow[];pending?:StorageRow[];availableAll?:ReadonlySet<string>;availablePending?:ReadonlySet<string>;baseline?:bigint;history?:Stats;incremental?:Stats}
const scopes=new WeakMap<StorageTransaction,Map<string,Inputs>>();
const key=(options:InputScope)=>JSON.stringify([options.ownerId,options.contactId,options.scopeCte,options.sourceOrder]);
const pending=(row:StorageRow)=>(row.item_id===null||row.extraction_state==='pending')&&row.target_assigned!==1n&&row.target_assigned!==1;

/** 仅在一个同步具名只读动作内复用候选；退出即丢弃，不跨写入或事务保留资格。 */
export function withScheduleInputStats<T>(tx:StorageTransaction,work:()=>T):T{
 if(scopes.has(tx))return work();
 scopes.set(tx,new Map());try{return work();}finally{scopes.delete(tx);}
}
function inputs(tx:StorageTransaction,options:InputScope):Inputs{
 const scope=scopes.get(tx);if(!scope)return {};
 const address=key(options);let value=scope.get(address);if(!value){value={};scope.set(address,value);}return value;
}

/** 来源与首次接受顺序保持分离；统计投影不读取正文，也不生成内容摘要。 */
export function readScheduleInputRows(tx:StorageTransaction,options:InputRows):StorageRow[]{
 const {ownerId,contactId,scopeCte,sourceOrder}=options,pendingOnly=options.pendingOnly!==false,cache=inputs(tx,options);
 if(pendingOnly&&cache.pending)return cache.pending;
 if(!pendingOnly&&cache.all)return cache.all;
 if(pendingOnly&&cache.all)return cache.pending=cache.all.filter(pending);
 const content=hasMemoryContent(tx),kinds=installedMemoryContentKinds().filter(kind=>content||kind==='text');
 if(!kinds.length)return [];
 const quarantine=tx.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='history_message_quarantine'")
  ?'AND NOT EXISTS(SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)':'';
 // run_input 的复合 FK 保证 item 与 source_contact_id 同联系人；分配集合只扫描一次。
 const rows=tx.all(`WITH ${scopeCte},schedule_assigned_items AS MATERIALIZED (
  SELECT DISTINCT item_id FROM run_input WHERE owner_id=? AND source_contact_id=? AND role='target' AND item_id IS NOT NULL
 ),schedule_candidate_messages AS MATERIALIZED (
  SELECT m.owner_id,m.contact_id,m.id,m.kind,m.display_no,p.id AS item_id,p.extraction_state,p.pipeline_state,
   ${pendingOnly?'0':'CASE WHEN p.id IN (SELECT item_id FROM schedule_assigned_items) THEN 1 ELSE 0 END'} AS target_assigned
  FROM message m LEFT JOIN processing_item p ON p.owner_id=m.owner_id AND p.contact_id=m.contact_id AND p.message_id=m.id AND p.purpose='memory_extraction'
  WHERE m.owner_id=? AND m.contact_id=? AND m.availability='available' AND m.kind IN (SELECT value FROM json_each(?)) ${quarantine}
   ${pendingOnly?"AND (p.id IS NULL OR p.extraction_state='pending') AND (p.id IS NULL OR p.id NOT IN (SELECT item_id FROM schedule_assigned_items))":''}
 ),schedule_current_records AS MATERIALIZED (
  SELECT source.message_id,min(source.id) AS record_id FROM schedule_candidate_messages m CROSS JOIN capture_record source
   ON source.owner_id=m.owner_id AND source.contact_id=m.contact_id AND source.message_id=m.id
  JOIN sync_capture capture ON capture.owner_id=source.owner_id AND capture.id=source.capture_id
  JOIN read_goal g ON g.owner_id=capture.owner_id AND g.id=capture.goal_id
  WHERE source.state='normalized' AND source.availability='available' AND ${currentSourcePredicate('source','g')}
  GROUP BY source.message_id
 ),schedule_ranked_first_source AS MATERIALIZED (
  SELECT source.message_id,g.kind AS first_goal_kind,capture.captured_at AS first_captured_at,
   row_number() OVER(PARTITION BY source.message_id ORDER BY ${sourceOrder}) position
  FROM schedule_candidate_messages m CROSS JOIN capture_record source
   ON source.owner_id=m.owner_id AND source.contact_id=m.contact_id AND source.message_id=m.id
  JOIN sync_capture capture ON capture.owner_id=source.owner_id AND capture.id=source.capture_id
  JOIN read_goal g ON g.owner_id=capture.owner_id AND g.id=capture.goal_id
  WHERE source.state='normalized' AND source.availability='available'
 ) SELECT m.owner_id,m.contact_id,m.id,m.kind,m.display_no,m.item_id,m.extraction_state,m.pipeline_state,m.target_assigned,
  current.record_id,f.first_goal_kind,f.first_captured_at FROM schedule_candidate_messages m
  JOIN schedule_current_records current ON current.message_id=m.id
  JOIN schedule_ranked_first_source f ON f.message_id=m.id AND f.position=1 ORDER BY m.display_no`,[ownerId,contactId,contactId,ownerId,contactId,ownerId,contactId,JSON.stringify(kinds)]);
 if(pendingOnly)cache.pending=rows;else cache.all=rows;
 return rows;
}

/** 完整集合可供目标截集复用；截集资格不能冒充完整内容摘要。 */
export function scheduleInputAvailability(tx:StorageTransaction,options:InputRows):ReadonlySet<string>{
 const cache=inputs(tx,options),pendingOnly=options.pendingOnly!==false;
 if(cache.availableAll)return cache.availableAll;
 if(pendingOnly&&cache.availablePending)return cache.availablePending;
 const available=currentContentAvailability(tx,options.ownerId,options.contactId,readScheduleInputRows(tx,options));
 if(pendingOnly)cache.availablePending=available;else cache.availableAll=available;return available;
}

export function pendingMemoryInputStats(tx:StorageTransaction,options:InputScope&{history:boolean}):Stats{
 const cache=inputs(tx,options),cached=options.history?cache.history:cache.incremental;if(cached)return cached;
 const rows=readScheduleInputRows(tx,options),available=scopes.has(tx)?scheduleInputAvailability(tx,options):currentContentAvailability(tx,options.ownerId,options.contactId,rows);
 const baseline=cache.baseline??=memoryIncrementalBaseline(tx);
 const history:Stats={count:0,oldestAt:null,latestAt:null},incremental:Stats={count:0,oldestAt:null,latestAt:null};
 for(const row of rows){
  if(!available.has(String(row.id)))continue;
  const target=row.first_goal_kind==='history'||(row.display_no as bigint)<=baseline?history:row.first_goal_kind==='incremental'?incremental:null;
  if(!target)continue;
  if(typeof row.first_captured_at!=='bigint'||row.first_captured_at<0n||row.first_captured_at>BigInt(Number.MAX_SAFE_INTEGER))fail('memory_extraction_time_invalid');
  const at=Number(row.first_captured_at);target.count++;target.oldestAt=target.oldestAt===null?at:Math.min(target.oldestAt,at);target.latestAt=target.latestAt===null?at:Math.max(target.latestAt,at);
 }
 cache.history=history;cache.incremental=incremental;return options.history?history:incremental;
}
