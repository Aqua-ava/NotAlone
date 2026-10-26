/** 完整来源、处理、提取、核验、裁决和写入追踪；正文只从既有敏感表读取。 */
import {createHash} from 'node:crypto';
import type pg from 'pg';
import {eraseSourceTraces,eraseTraceBodies} from '../memory/management/memory-mutations-erasure.ts';

export interface TraceScope {ownerId:string;contactId:string}
export type MemoryTraceRecordKind='message'|'candidate'|'contact_memory'|'owner_memory'|'task';
export type SourceProcessingRecordKind='message'|'source_ref'|'source_document'|'local_wechat_observation';
export interface TracePage<T> {batches:T[];next_before:string|null}
export interface TraceOptions {limit?:number;before?:string|null}

export class SourceProcessingTraceError extends Error {
 readonly code:string;
 constructor(code:string){super(code);this.code=code;}
}

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const memoryKinds=new Set<MemoryTraceRecordKind>(['message','candidate','contact_memory','owner_memory','task']);
const sourceKinds=new Set<SourceProcessingRecordKind>(['message','source_ref','source_document','local_wechat_observation']);
const failedStatuses=new Set(['trace_failed','business_failed','model_failed','stopped','scope_invalidated','scope_guard_failed']);
const invalid=(code:string):never=>{throw new SourceProcessingTraceError(code);};

function scope(value:TraceScope):TraceScope {
 if(!value||typeof value!=='object'||Array.isArray(value)
  ||Object.keys(value).sort().join(',')!=='contactId,ownerId'
  ||!uuid.test(value.ownerId)||!uuid.test(value.contactId))invalid('trace_scope_invalid');
 return {ownerId:value.ownerId.toLowerCase(),contactId:value.contactId.toLowerCase()};
}
function identifier(value:string,code='trace_identifier_invalid'):string {
 if(typeof value!=='string'||!uuid.test(value))invalid(code);return value.toLowerCase();
}
function pageOptions(value:TraceOptions={}):Required<Pick<TraceOptions,'limit'>> & Pick<TraceOptions,'before'> {
 const limit=value.limit??100;
 if(!Number.isSafeInteger(limit)||limit<1||limit>500)invalid('trace_page_invalid');
 if(value.before!=null&&(typeof value.before!=='string'||!uuid.test(value.before)))invalid('trace_cursor_invalid');
 return {limit,before:value.before?.toLowerCase()??null};
}
function iso(value:unknown):string|null {
 if(value==null)return null;
 const time=value instanceof Date?value.getTime():Date.parse(String(value));
 if(!Number.isFinite(time))return null;
 return new Date(time).toISOString();
}
function payload(text:unknown):Record<string,unknown> {
 if(typeof text!=='string')return {};
 try {const value=JSON.parse(text);return value&&typeof value==='object'&&!Array.isArray(value)?value:{value};}
 catch{return {};}
}
function payloadSha(text:unknown):string|null {
 return typeof text==='string'?createHash('sha256').update(text).digest('hex'):null;
}
function eventRow(row:Record<string,any>) {
 const text=typeof row.payload_text==='string'?row.payload_text:null;
 return {
  event_id:row.event_id,trace_id:row.trace_id,owner_id:row.owner_id,contact_id:row.contact_id,
  position:row.position,stage:row.stage,candidate_trace_id:row.candidate_trace_id,call_id:row.call_id,
  recorded_at:iso(row.recorded_at),payload:payload(text),payload_text:text,payload_sha256:payloadSha(text),
 };
}
function batchRow<T extends Record<string,any>>(row:T):T {
 return {...row,recorded_at:iso(row.recorded_at),started_at:iso(row.started_at),finished_at:iso(row.finished_at),
  deleted_at:iso(row.deleted_at),created_at:iso(row.created_at),updated_at:iso(row.updated_at)};
}
function candidateSummaries(events:Record<string,any>[]):Record<string,any>[] {
 const candidates=new Map<string,Record<string,any>>();
 for(const event of events){
  const body=event.payload as Record<string,any>;
  if(event.stage==='extraction_return'&&Array.isArray(body.candidate_trace_ids)){
   for(const [index,candidate] of body.candidate_trace_ids.entries())if(typeof candidate==='string'){
    candidates.set(candidate,{candidate_trace_id:candidate,index,disposition:'not_recorded',stages:[]});
   }
  }
  const candidate=event.candidate_trace_id;
  if(typeof candidate!=='string')continue;
  const item=candidates.get(candidate)??{candidate_trace_id:candidate,index:null,disposition:'not_recorded',stages:[]};
  item.stages.push(event.stage);
  if(event.stage==='candidate_raw'){
   item.index=body.index;item.raw_fields=body.fields;
  }
  if(typeof body.disposition==='string'&&body.disposition!=='continue')item.disposition=body.disposition;
  if(event.stage==='candidate_result'&&typeof body.result?.disposition==='string')item.disposition=body.result.disposition;
  if(event.stage==='write_plan'&&item.disposition==='not_recorded')item.disposition='write_outcome_not_recorded';
  if(Array.isArray(body.not_executed))item.not_executed=body.not_executed;
  candidates.set(candidate,item);
 }
 return [...candidates.values()];
}

/**
 * 只读导航与有边界删除。模型台账只投影非正文元数据，完整事件仍留在可随来源删除的敏感表。
 * 所有正文入口先校验 contact，再按 owner+contact 过滤；越界与不存在统一抛出不可区分错误。
 */
export class SourceProcessingTraceStore {
 private readonly pool:pg.Pool;
 constructor(pool:pg.Pool){this.pool=pool;}

 async listMemoryTraces(value:TraceScope,options:TraceOptions={}):Promise<TracePage<Record<string,any>>> {
  const s=scope(value),page=pageOptions(options);
  return this.read(async c=>{
   await this.contact(c,s);
   let cursor:Record<string,any>|undefined;
   if(page.before){
    cursor=(await c.query(`SELECT started_at,trace_id FROM public.memory_extraction_trace
     WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3`,[page.before,s.ownerId,s.contactId])).rows[0];
    if(!cursor)invalid('trace_cursor_not_found');
   }
   const rows=(await c.query(`SELECT * FROM public.memory_extraction_trace
    WHERE owner_id=$1 AND contact_id=$2 ${cursor?'AND (started_at,trace_id)<($3,$4)':''}
    ORDER BY started_at DESC,trace_id DESC LIMIT $${cursor?5:3}`,
    cursor?[s.ownerId,s.contactId,cursor.started_at,cursor.trace_id,page.limit]:[s.ownerId,s.contactId,page.limit])).rows;
   return {batches:rows.map(batchRow),next_before:rows.length===page.limit?rows.at(-1)!.trace_id:null};
  });
 }

 async getMemoryTrace(value:TraceScope,traceId:string):Promise<Record<string,any>> {
  const s=scope(value),id=identifier(traceId,'trace_id_invalid');
  return this.read(async c=>{
   await this.contact(c,s);
   const row=(await c.query(`SELECT * FROM public.memory_extraction_trace
    WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3`,[id,s.ownerId,s.contactId])).rows[0];
   if(!row)invalid('trace_not_found');
   const trace=batchRow(row);
   const links=(await c.query(`SELECT candidate_trace_id,record_kind,record_id,commit_status,operation
    FROM public.memory_extraction_trace_link WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3
    ORDER BY record_kind,record_id`,[id,s.ownerId,s.contactId])).rows;
   const calls=(await c.query(`SELECT receipt.call_id,receipt.purpose,receipt.called_at,receipt.finished_at,
     receipt.response_status,receipt.provider_attempts,receipt.ledger_entry_id,receipt.ledger_commit_status,receipt.disposition,
     model.provider,model.model_name,model.dispatch,model.outcome,model.input_tokens,model.output_tokens,
     model.cache_read_tokens,model.cache_write_tokens,model.latency_ms,model.cost_status,model.cost_amount,
     model.currency,model.pricing_version,legacy.outcome AS legacy_outcome
    FROM public.memory_extraction_trace_call receipt
    LEFT JOIN public.model_call_receipt model ON model.ledger_entry_id=receipt.ledger_entry_id
     AND model.owner_id=receipt.owner_id AND model.contact_id=receipt.contact_id
    LEFT JOIN public.outbound_ledger_entry legacy ON legacy.id=receipt.ledger_entry_id
     AND legacy.owner_id=receipt.owner_id AND legacy.contact_id=receipt.contact_id
    WHERE receipt.trace_id=$1 AND receipt.owner_id=$2 AND receipt.contact_id=$3
    ORDER BY receipt.called_at,receipt.call_id`,[id,s.ownerId,s.contactId])).rows.map(call=>({...call,
     called_at:iso(call.called_at),finished_at:iso(call.finished_at),cost_amount:call.cost_amount?.toString()??null}));
   const write_receipts=await this.writeReceipts(c,s,links,trace.status);
   const versions=await this.memoryVersions(c,s,write_receipts);
   if(trace.status==='deleted'){
    return {...trace,availability:'deleted',events:[],sources:[],source_documents:[],local_wechat_observations:[],
     messages:[],source_processing_batches:[],tasks:[],links,write_receipts,versions,candidates:[],calls,
     failure:null,deletion_reason:trace.deletion_reason??null,processing_state:'deleted',completeness:'deleted',
     process_record:{contains_body:false,availability:'deleted',events:[]},
     model_ledger:{contains_body:false,availability:'recorded',calls}};
   }
   await this.requireTraceSources(c,s,id);
   const rawEvents=(await c.query(`SELECT * ,payload::text AS payload_text FROM public.memory_extraction_trace_event
    WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3 ORDER BY position`,[id,s.ownerId,s.contactId])).rows;
   const events=rawEvents.map(eventRow);
   const window=events.find(event=>event.stage==='window');
   const windowPayload=window?.payload as Record<string,any>|undefined;
   const windowMessages=Array.isArray(windowPayload?.messages)?windowPayload.messages as Record<string,any>[]:[];
   const messageIds=[...new Set(windowMessages.map(item=>item.message_id).filter(id=>typeof id==='string'&&uuid.test(id)))];
   const refIds=new Set<string>(),snapshotSourceIds=new Set<string>();
   for(const message of windowMessages)if(Array.isArray(message.source_snapshots))for(const source of message.source_snapshots){
    if(typeof source?.source_ref_id==='string'&&uuid.test(source.source_ref_id))refIds.add(source.source_ref_id);
    if(typeof source?.source_id==='string'&&uuid.test(source.source_id))snapshotSourceIds.add(source.source_id);
   }
   const dependencies=(await c.query(`SELECT source_id FROM public.memory_extraction_trace_dependency
    WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3 ORDER BY source_id`,[id,s.ownerId,s.contactId])).rows;
   const dependencyIds=dependencies.map(row=>row.source_id as string);
   const sourceIds=[...new Set([...dependencyIds,...snapshotSourceIds])];
   const navigation=await this.navigation(c,s,{messageIds,refIds:[...refIds],sourceIds,dependencyIds});
   const taskIds=[...new Set(events.flatMap(event=>{
    const runtime=(event.payload as Record<string,any>).task_runtime;
    return typeof runtime?.task_id==='string'&&uuid.test(runtime.task_id)?[runtime.task_id]:[];
   }))];
   const tasks=await this.tasks(c,s,taskIds);
   const batchEnd=events.some(event=>event.stage==='batch_end');
   const completeness=trace.status==='running'?'partial':batchEnd?'complete':'incomplete';
   const failure=trace.failure_stage||trace.error_code?{stage:trace.failure_stage??null,code:trace.error_code??null}:null;
   const missing_stages=this.missingStages(events,trace.status);
   return {...trace,availability:'recorded',events,sources:navigation.sources,source_documents:navigation.source_documents,
    local_wechat_observations:navigation.local_wechat_observations,messages:navigation.messages,
    source_processing_batches:navigation.source_processing_batches,tasks,links,write_receipts,versions,
    candidates:candidateSummaries(events),calls,failure,processing_state:trace.status==='running'?'in_progress':'terminal',
    completeness,missing_stages,dependencies:dependencyIds,
    process_record:{contains_body:events.length>0||navigation.messages.length>0,availability:'recorded',events},
    model_ledger:{contains_body:false,availability:'recorded',calls}};
  });
 }

 async findMemoryTraceRecord(value:TraceScope,kind:MemoryTraceRecordKind,recordId:string):Promise<Record<string,any>> {
  const s=scope(value);if(!memoryKinds.has(kind))invalid('trace_record_kind_invalid');
  const id=identifier(recordId,'trace_record_id_invalid');
  if(kind==='task')return this.findTaskTrace(s,id);
  return this.read(c=>this.findMemoryTraceRecordOn(c,s,kind,id));
 }

 /** L2最终事务复用原client，避免来源在读取与发布之间跨事务变化。 */
 async findMemoryTraceRecordInTransaction(
  client:pg.ClientBase,value:TraceScope,kind:MemoryTraceRecordKind,recordId:string,
 ):Promise<Record<string,any>> {
  const s=scope(value);if(!memoryKinds.has(kind)||kind==='task')invalid('trace_record_kind_invalid');
  return this.findMemoryTraceRecordOn(client,s,kind as Exclude<MemoryTraceRecordKind,'task'>,
   identifier(recordId,'trace_record_id_invalid'));
 }

 /**
  * 只返回无正文可用性、trace身份和来源依赖。自动来源必须完整成功且每个窗口
  * 来源快照仍与当前内容摘要一致；运行中/失败/不完整均拒绝。
  */
 async validateMemoryTraceRecordInTransaction(
  client:pg.ClientBase,value:TraceScope,kind:MemoryTraceRecordKind,recordId:string,
 ):Promise<{availability:string;trace_ids:string[];dependency_ids:string[];record:Record<string,any>|null}> {
  const found=await this.findMemoryTraceRecordInTransaction(client,value,kind,recordId);
  const s=scope(value),record=found.record as Record<string,any>;
  const traces=(found.batches as Record<string,any>[]).filter(trace=>trace.status!=='deleted');
  if(found.availability!=='recorded'||!traces.length)return {
   availability:String(found.availability),trace_ids:[],dependency_ids:[],record:record??null,
  };
  if(traces.some(trace=>trace.status==='running'))invalid('trace_processing_in_progress');
  if(traces.some(trace=>trace.status!=='succeeded'))invalid('trace_not_usable');
  const traceIds=traces.map(trace=>trace.trace_id as string);
  const stages=(await client.query(`SELECT trace_id,
    bool_or(stage='window') AS has_window,bool_or(stage='batch_end') AS has_batch_end
    FROM public.memory_extraction_trace_event
    WHERE owner_id=$1 AND contact_id=$2 AND trace_id=ANY($3::uuid[])
    GROUP BY trace_id`,[s.ownerId,s.contactId,traceIds])).rows;
  if(stages.length!==traceIds.length||stages.some(row=>!row.has_window||!row.has_batch_end))invalid('trace_not_usable');
  for(const traceId of traceIds)await this.requireTraceSources(client,s,traceId);
  const dependencyIds=(await client.query(`SELECT DISTINCT source_id
    FROM public.memory_extraction_trace_dependency
    WHERE owner_id=$1 AND contact_id=$2 AND trace_id=ANY($3::uuid[])
    ORDER BY source_id`,[s.ownerId,s.contactId,traceIds])).rows.map(row=>row.source_id as string);
  return {availability:'recorded',trace_ids:traceIds,dependency_ids:dependencyIds,record};
 }

 private async findMemoryTraceRecordOn(
  c:pg.ClientBase,s:TraceScope,kind:Exclude<MemoryTraceRecordKind,'task'>,id:string,
 ):Promise<Record<string,any>> {
  await this.contact(c,s);
  let origin:Record<string,any>|undefined,candidateId:string|null=null;
  if(kind==='message'){
   origin=(await c.query(`SELECT id FROM public.message WHERE owner_id=$1 AND contact_id=$2 AND id=$3`,
    [s.ownerId,s.contactId,id])).rows[0];
  }else if(kind==='contact_memory'){
   origin=(await c.query(`SELECT id,status,revision,source_candidate_id,source_ids,adoption_method
    FROM public.confirmed_memory WHERE owner_id=$1 AND contact_id=$2 AND id=$3`,
    [s.ownerId,s.contactId,id])).rows[0];
   candidateId=origin?.source_candidate_id??null;
  }else if(kind==='owner_memory'){
   origin=(await c.query(`SELECT memory.id,memory.status,memory.revision,memory.source_candidate_id,
     memory.source_ids,memory.adoption_method
    FROM public.owner_memory memory LEFT JOIN public.memory_candidate candidate
     ON candidate.id=memory.source_candidate_id AND candidate.owner_id=memory.owner_id
     WHERE memory.owner_id=$1 AND memory.id=$2 AND (candidate.contact_id=$3 OR EXISTS(
      SELECT 1 FROM public.source_document source WHERE source.owner_id=memory.owner_id
       AND source.contact_id=$3 AND source.id=ANY(memory.source_ids)) OR EXISTS(
      SELECT 1 FROM public.message message WHERE message.owner_id=memory.owner_id
       AND message.contact_id=$3 AND message.id=ANY(memory.source_ids)) OR (
      memory.source_candidate_id IS NULL AND memory.adoption_method='manual'
       AND memory.source_ids=ARRAY[memory.owner_id]))`,[s.ownerId,id,s.contactId])).rows[0];
   candidateId=origin?.source_candidate_id??null;
  }else{
   origin=(await c.query(`SELECT id,status,source_ids FROM public.memory_candidate
    WHERE owner_id=$1 AND contact_id=$2 AND id=$3`,[s.ownerId,s.contactId,id])).rows[0];
  }
  if(!origin)throw new SourceProcessingTraceError('trace_record_not_found');
  const rows=(await c.query(`SELECT DISTINCT trace.* FROM public.memory_extraction_trace trace
   LEFT JOIN public.memory_extraction_trace_link link
    ON link.trace_id=trace.trace_id AND link.owner_id=trace.owner_id AND link.contact_id=trace.contact_id
   WHERE trace.owner_id=$1 AND trace.contact_id=$2 AND ((link.record_kind=$3 AND link.record_id=$4)
    OR (link.record_kind='candidate' AND link.record_id=$5) OR ($3='message' AND EXISTS(
     SELECT 1 FROM public.memory_extraction_trace_event event WHERE event.trace_id=trace.trace_id
      AND event.owner_id=trace.owner_id AND event.contact_id=trace.contact_id AND event.stage='window'
      AND event.payload->'messages' @> $6::jsonb)))
   ORDER BY trace.started_at DESC,trace.trace_id DESC`,[s.ownerId,s.contactId,kind,id,candidateId,
    JSON.stringify([{message_id:id}])])).rows.map(batchRow);
  const manualOnly=kind==='owner_memory'&&origin.source_candidate_id==null&&origin.adoption_method==='manual'
   &&Array.isArray(origin.source_ids)&&origin.source_ids.length===1&&origin.source_ids[0]===s.ownerId;
  let recoveryManual=manualOnly;
  if(!manualOnly&&kind!=='message'&&!rows.length&&origin.source_ids?.length){
   const sources=(await c.query(`SELECT id FROM public.source_document WHERE owner_id=$1 AND contact_id=$2
    AND source_type='manual' AND status='active' AND id=ANY($3::uuid[])`,[s.ownerId,s.contactId,origin.source_ids])).rows;
   recoveryManual=sources.length===origin.source_ids.length;
  }
  return {availability:rows.some(row=>row.status!=='deleted')?'recorded':rows.length?'deleted':recoveryManual?'not_applicable':'not_recorded',
   batches:rows,record_exists:true,record:{kind,record_id:id,status:origin.status??null,adoption_method:origin.adoption_method??null,
    revision:origin.revision??null,source_candidate_id:candidateId,source_ids:origin.source_ids??[]}};
 }

 async findTaskTrace(value:TraceScope,taskId:string):Promise<Record<string,any>> {
  const s=scope(value),id=identifier(taskId,'trace_task_id_invalid');
  return this.read(async c=>{
   await this.contact(c,s);
   const task=(await c.query(`SELECT t.*,${processingSourceValidity('t')} AS source_available
    FROM public.background_task t WHERE t.id=$1 AND t.owner_id=$2 AND t.contact_id=$3`,
    [id,s.ownerId,s.contactId])).rows[0];
   if(!task)invalid('trace_task_not_found');
   const steps=(await c.query(`SELECT id,step_name,step_order,status,attempt_count,processed_count,total_count,
     last_error_code,started_at,finished_at,updated_at FROM public.background_task_step
    WHERE task_id=$1 ORDER BY step_order`,[id])).rows.map(batchRow);
   const traces=(await c.query(`SELECT DISTINCT trace.* FROM public.memory_extraction_trace trace
    JOIN public.memory_extraction_trace_event event ON event.trace_id=trace.trace_id
     AND event.owner_id=trace.owner_id AND event.contact_id=trace.contact_id
    WHERE trace.owner_id=$1 AND trace.contact_id=$2 AND event.stage='window'
     AND event.payload#>>'{task_runtime,task_id}'=$3
    ORDER BY trace.started_at DESC,trace.trace_id DESC`,[s.ownerId,s.contactId,id])).rows.map(batchRow);
   const sourceBatches=(await c.query(`SELECT DISTINCT batch.* FROM public.source_processing_batch batch
    LEFT JOIN public.source_processing_record record ON record.batch_id=batch.batch_id
     AND record.owner_id=batch.owner_id AND record.contact_id=batch.contact_id
    LEFT JOIN public.memory_processing_target target ON target.message_id=record.message_id
     AND target.owner_id=record.owner_id AND target.contact_id=record.contact_id
    WHERE batch.owner_id=$1 AND batch.contact_id=$2 AND (batch.source_id=$3 OR target.task_id=$4)
    ORDER BY batch.recorded_at DESC,batch.batch_id DESC`,[s.ownerId,s.contactId,task.source_document_id,id])).rows.map(batchRow);
   return {availability:traces.some(row=>row.status!=='deleted')?'recorded':traces.length?'deleted':'not_recorded',
    task:{...batchRow(task),steps},batches:traces,source_processing_batches:sourceBatches,
    failure:task.last_error_code?{stage:task.current_step??null,code:task.last_error_code}:null};
  });
 }

 async diagnoseMemoryTrace(value:TraceScope,traceId:string):Promise<Record<string,any>> {
  const s=scope(value),id=identifier(traceId,'trace_id_invalid');
  return this.read(async c=>{
   await this.contact(c,s);
   const row=(await c.query(`SELECT trace_id,status,started_at,finished_at,failure_stage,error_code,deletion_reason
    FROM public.memory_extraction_trace WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3`,
    [id,s.ownerId,s.contactId])).rows[0];
   if(!row)invalid('trace_not_found');
   const counts=(await c.query(`SELECT
     (SELECT count(*)::int FROM public.memory_extraction_trace_event WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3) AS event_count,
     (SELECT count(*)::int FROM public.memory_extraction_trace_link WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3) AS link_count,
     (SELECT count(*)::int FROM public.memory_extraction_trace_call WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3) AS call_count,
     (SELECT count(*)::int FROM public.memory_extraction_trace_dependency WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3) AS dependency_count,
     EXISTS(SELECT 1 FROM public.memory_extraction_trace_event WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3
      AND stage='batch_end') AS has_batch_end,
     (SELECT count(*)::int FROM public.memory_extraction_trace_dependency dependency
      WHERE dependency.trace_id=$1 AND dependency.owner_id=$2 AND dependency.contact_id=$3
      AND NOT ${dependencyAvailable('dependency.source_id')}) AS unavailable_dependency_count`,[id,s.ownerId,s.contactId])).rows[0];
   return {trace_id:row.trace_id,status:row.status,started_at:iso(row.started_at),finished_at:iso(row.finished_at),
    failure_stage:row.failure_stage,error_code:row.error_code,deletion_reason:row.deletion_reason,...counts,
    processing_state:row.status==='running'?'in_progress':row.status==='deleted'?'deleted':'terminal',
    redaction:'metadata_only',contains_body:false,automatic_upload:false};
  });
 }

 async deleteMemoryTrace(value:TraceScope,traceId:string):Promise<{availability:'deleted';batch_id:string}> {
  const s=scope(value),id=identifier(traceId,'trace_id_invalid');
  await this.write(s,async c=>{
   await this.contact(c,s);
   const row=(await c.query(`SELECT trace_id FROM public.memory_extraction_trace
    WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3 FOR UPDATE`,[id,s.ownerId,s.contactId])).rows[0];
   if(!row)invalid('trace_not_found');
   await eraseTraceBodies(c as unknown as pg.Client,s.ownerId,[id],'manual');
  });
  return {availability:'deleted',batch_id:id};
 }

 async listSourceBatches(value:TraceScope,options:TraceOptions={}):Promise<TracePage<Record<string,any>>> {
  const s=scope(value),page=pageOptions(options);
  return this.read(async c=>{
   await this.contact(c,s);
   let cursor:Record<string,any>|undefined;
   if(page.before){
    cursor=(await c.query(`SELECT recorded_at,batch_id FROM public.source_processing_batch
     WHERE batch_id=$1 AND owner_id=$2 AND contact_id=$3`,[page.before,s.ownerId,s.contactId])).rows[0];
    if(!cursor)invalid('trace_cursor_not_found');
   }
   const rows=(await c.query(`SELECT * FROM public.source_processing_batch
    WHERE owner_id=$1 AND contact_id=$2 ${cursor?'AND (recorded_at,batch_id)<($3,$4)':''}
    ORDER BY recorded_at DESC,batch_id DESC LIMIT $${cursor?5:3}`,
    cursor?[s.ownerId,s.contactId,cursor.recorded_at,cursor.batch_id,page.limit]:[s.ownerId,s.contactId,page.limit])).rows;
   return {batches:rows.map(batchRow),next_before:rows.length===page.limit?rows.at(-1)!.batch_id:null};
  });
 }

 async getSourceBatch(value:TraceScope,batchId:string):Promise<Record<string,any>> {
  const s=scope(value),id=identifier(batchId,'source_processing_batch_id_invalid');
  return this.read(async c=>{
   await this.contact(c,s);
   const row=(await c.query(`SELECT * FROM public.source_processing_batch
    WHERE batch_id=$1 AND owner_id=$2 AND contact_id=$3`,[id,s.ownerId,s.contactId])).rows[0];
   if(!row)invalid('source_processing_not_found');
   if(row.status!=='deleted'&&row.source_id)await this.requireSourceAvailable(c,s,row.source_kind,row.source_id);
   const records=(await c.query(`SELECT *,payload::text AS payload_text FROM public.source_processing_record
    WHERE batch_id=$1 AND owner_id=$2 AND contact_id=$3 ORDER BY position`,[id,s.ownerId,s.contactId])).rows.map(record=>({...record,
     payload:record.payload_text===null?null:payload(record.payload_text),payload_sha256:payloadSha(record.payload_text)}));
   return {...batchRow(row),records,processing_state:row.status};
  });
 }

 async findSourceRecord(value:TraceScope,kind:SourceProcessingRecordKind,recordId:string):Promise<Record<string,any>> {
  const s=scope(value);if(!sourceKinds.has(kind))invalid('source_processing_record_kind_invalid');
  const id=identifier(recordId,'source_processing_record_id_invalid');
  return this.read(async c=>{
   await this.contact(c,s);
   const column={message:'record.message_id',source_ref:'record.source_ref_id',source_document:'batch.source_id',
    local_wechat_observation:'batch.source_id'}[kind];
   const filter=['source_document','local_wechat_observation'].includes(kind)?`AND batch.source_kind='${kind}'`:'';
   const rows=(await c.query(`SELECT DISTINCT batch.* FROM public.source_processing_batch batch
    JOIN public.source_processing_record record USING(batch_id,owner_id,contact_id)
    WHERE batch.owner_id=$1 AND batch.contact_id=$2 AND ${column}=$3 ${filter}
    ORDER BY batch.recorded_at DESC,batch.batch_id`,[s.ownerId,s.contactId,id])).rows.map(batchRow);
   if(rows.some(row=>row.status!=='deleted')&&['source_document','local_wechat_observation'].includes(kind))
    await this.requireSourceAvailable(c,s,kind,id);
   if(!rows.length){
    const table={message:'message',source_ref:'message_source_ref',source_document:'source_document',
     local_wechat_observation:'local_wechat_observation'}[kind];
    const exists=(await c.query(`SELECT 1 FROM public.${table} WHERE owner_id=$1 AND contact_id=$2 AND id=$3`,
     [s.ownerId,s.contactId,id])).rowCount;
    if(!exists)invalid('source_processing_record_not_found');
   }
   return {availability:rows.some(row=>row.status!=='deleted')?'recorded':rows.length?'deleted':'not_recorded',
    batches:rows,record_exists:true};
  });
 }

 async deleteSourceBatch(value:TraceScope,batchId:string):Promise<{availability:'deleted';batch_id:string}> {
  const s=scope(value),id=identifier(batchId,'source_processing_batch_id_invalid');
  await this.write(s,async c=>{
   await this.contact(c,s);
   const row=(await c.query(`SELECT * FROM public.source_processing_batch
    WHERE batch_id=$1 AND owner_id=$2 AND contact_id=$3 FOR UPDATE`,[id,s.ownerId,s.contactId])).rows[0];
   if(!row)invalid('source_processing_not_found');
   const records=(await c.query(`SELECT message_id,source_ref_id,payload->>'capture_record_id' AS capture_record_id
    FROM public.source_processing_record WHERE batch_id=$1 AND owner_id=$2 AND contact_id=$3`,[id,s.ownerId,s.contactId])).rows;
   const captureIds=records.map(record=>record.capture_record_id).filter(value=>typeof value==='string'&&uuid.test(value));
   if(captureIds.length)await c.query(`INSERT INTO public.source_processing_capture_tombstone
    (owner_id,contact_id,capture_record_id) SELECT $1,$2,value::uuid FROM unnest($3::text[]) value
    ON CONFLICT DO NOTHING`,[s.ownerId,s.contactId,captureIds]);
   await c.query(`UPDATE public.source_processing_record SET payload=NULL,locator=NULL,outcome='deleted'
    WHERE batch_id=$1 AND owner_id=$2 AND contact_id=$3`,[id,s.ownerId,s.contactId]);
   await c.query(`UPDATE public.source_processing_batch SET status='deleted',deleted_at=COALESCE(deleted_at,now())
    WHERE batch_id=$1 AND owner_id=$2 AND contact_id=$3`,[id,s.ownerId,s.contactId]);
   const affected=[id,row.source_id,...records.map(record=>record.message_id),...records.map(record=>record.source_ref_id)]
    .filter(value=>typeof value==='string'&&uuid.test(value));
   await eraseSourceTraces(c as unknown as pg.Client,s.ownerId,affected,s.contactId,'source_processing_deleted');
  });
  return {availability:'deleted',batch_id:id};
 }

 private async read<T>(work:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
   const result=await work(c);await c.query('COMMIT');return result;
  }catch(error){await c.query('ROLLBACK').catch(()=>{});throw this.safeError(error);}
  finally{c.release();}
 }
 private async write<T>(scopeValue:TraceScope,work:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`contact:${scopeValue.ownerId}:${scopeValue.contactId}`]);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${scopeValue.ownerId}`]);
   const result=await work(c);await c.query('COMMIT');return result;
  }catch(error){await c.query('ROLLBACK').catch(()=>{});throw this.safeError(error);}
  finally{c.release();}
 }
 private safeError(error:unknown):SourceProcessingTraceError {
  if(error instanceof SourceProcessingTraceError)return error;
  return new SourceProcessingTraceError('source_processing_trace_unavailable');
 }
 private async contact(c:pg.ClientBase,scopeValue:TraceScope):Promise<void> {
  if(!(await c.query('SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2',
   [scopeValue.ownerId,scopeValue.contactId])).rowCount)invalid('trace_not_found');
 }
 private async requireTraceSources(c:pg.ClientBase,scopeValue:TraceScope,traceId:string):Promise<void> {
  const unavailable=(await c.query(`SELECT dependency.source_id FROM public.memory_extraction_trace_dependency dependency
   WHERE dependency.trace_id=$1 AND dependency.owner_id=$2 AND dependency.contact_id=$3
    AND NOT ${dependencyAvailable('dependency.source_id')} LIMIT 1`,[traceId,scopeValue.ownerId,scopeValue.contactId])).rowCount;
  if(unavailable)invalid('trace_sources_unavailable');
  const messageUnavailable=(await c.query(`SELECT event.trace_id FROM public.memory_extraction_trace_event event
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(event.payload->'messages')='array'
    THEN event.payload->'messages' ELSE '[]'::jsonb END) message
   WHERE event.trace_id=$1 AND event.owner_id=$2 AND event.contact_id=$3 AND event.stage='window'
    AND NOT EXISTS(SELECT 1 FROM public.message current WHERE current.id=(message->>'message_id')::uuid
     AND current.owner_id=$2 AND current.contact_id=$3 AND EXISTS(
      SELECT 1 FROM public.message_source_ref ref WHERE ref.message_id=current.id
       AND ref.owner_id=current.owner_id AND ref.contact_id=current.contact_id AND (
        EXISTS(SELECT 1 FROM public.source_document source WHERE source.id=ref.source_document_id
         AND source.owner_id=ref.owner_id AND source.contact_id=ref.contact_id AND source.status='active')
        OR EXISTS(SELECT 1 FROM public.local_wechat_observation observation WHERE observation.id=ref.observation_id
         AND observation.owner_id=ref.owner_id AND observation.contact_id=ref.contact_id))))
   LIMIT 1`,[traceId,scopeValue.ownerId,scopeValue.contactId])).rowCount;
  if(messageUnavailable)invalid('trace_sources_unavailable');
  const snapshotUnavailable=(await c.query(`SELECT event.trace_id FROM public.memory_extraction_trace_event event
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(event.payload->'messages')='array'
    THEN event.payload->'messages' ELSE '[]'::jsonb END) message
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(message->'source_snapshots')='array'
    THEN message->'source_snapshots' ELSE '[]'::jsonb END) snapshot
   WHERE event.trace_id=$1 AND event.owner_id=$2 AND event.contact_id=$3 AND event.stage='window'
    AND (((snapshot->>'source_kind')='source_document' AND NOT EXISTS(
      SELECT 1 FROM public.source_document source WHERE source.id=(snapshot->>'source_id')::uuid
       AND source.owner_id=$2 AND source.contact_id=$3 AND source.status='active'
       AND source.content_sha256=(snapshot->>'source_content_sha256')))
     OR ((snapshot->>'source_kind')='local_wechat_observation' AND NOT EXISTS(
      SELECT 1 FROM public.local_wechat_observation observation WHERE observation.id=(snapshot->>'source_id')::uuid
       AND observation.owner_id=$2 AND observation.contact_id=$3))
     OR (snapshot->>'source_kind') NOT IN ('source_document','local_wechat_observation'))
   LIMIT 1`,[traceId,scopeValue.ownerId,scopeValue.contactId])).rowCount;
  if(snapshotUnavailable)invalid('trace_sources_unavailable');
 }
 private async requireSourceAvailable(c:pg.ClientBase,scopeValue:TraceScope,kind:string,sourceId:string):Promise<void> {
  const query=kind==='source_document'
   ?`SELECT 1 FROM public.source_document WHERE id=$3 AND owner_id=$1 AND contact_id=$2 AND status='active'`
   :kind==='local_wechat_observation'
    ?`SELECT 1 FROM public.local_wechat_observation WHERE id=$3 AND owner_id=$1 AND contact_id=$2`
    :'SELECT 0';
  if(!(await c.query(query,[scopeValue.ownerId,scopeValue.contactId,sourceId])).rowCount)invalid('source_unavailable');
 }

 private async navigation(c:pg.ClientBase,s:TraceScope,input:{messageIds:string[];refIds:string[];sourceIds:string[];
  dependencyIds:string[]}):Promise<Record<string,any>> {
  const messageRows=input.messageIds.length?(await c.query(`SELECT id,owner_id,contact_id,speaker,message_type,text_content,
    media_placeholder,occurred_at,created_at FROM public.message WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[])
    ORDER BY occurred_at NULLS LAST,created_at,id`,[s.ownerId,s.contactId,input.messageIds])).rows:[];
  const refRows=input.messageIds.length?(await c.query(`SELECT ref.id,ref.message_id,ref.owner_id,ref.contact_id,
    ref.source_kind,COALESCE(ref.source_document_id,ref.observation_id) AS source_id,ref.source_locator,
    ref.raw_payload::text AS raw_payload_text,ref.created_at,
    source.content_sha256 AS source_content_sha256
    FROM public.message_source_ref ref LEFT JOIN public.source_document source
     ON source.id=ref.source_document_id AND source.owner_id=ref.owner_id AND source.contact_id=ref.contact_id
    WHERE ref.owner_id=$1 AND ref.contact_id=$2 AND ref.message_id=ANY($3::uuid[])
     AND (cardinality($4::uuid[])=0 OR ref.id=ANY($4::uuid[]))
    ORDER BY ref.message_id,ref.created_at,ref.id`,
    [s.ownerId,s.contactId,input.messageIds,input.refIds])).rows:[];
  const refsByMessage=new Map<string,Record<string,any>[]>();
  for(const row of refRows){const list=refsByMessage.get(row.message_id)??[];list.push({...row,
   raw_payload:payload(row.raw_payload_text),raw_payload_text:row.raw_payload_text,created_at:iso(row.created_at)});
   refsByMessage.set(row.message_id,list);}
  const messages=messageRows.map(row=>({...row,occurred_at:iso(row.occurred_at),created_at:iso(row.created_at),
   source_refs:refsByMessage.get(row.id)??[]}));
  const source_documents=input.sourceIds.length?(await c.query(`SELECT id,owner_id,contact_id,source_type,file_name,
    content_sha256,record_count,status,imported_at,deleted_at FROM public.source_document
    WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) ORDER BY id`,[s.ownerId,s.contactId,input.sourceIds])).rows
    .map(batchRow):[];
  const local_wechat_observations=input.sourceIds.length?(await c.query(`SELECT id,owner_id,contact_id,binding_id,
    mode,cli_version,conversation_locator,last_local_id,last_cursor,record_count,event_count,created_at
    FROM public.local_wechat_observation WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[])
    ORDER BY created_at,id`,[s.ownerId,s.contactId,input.sourceIds])).rows.map(batchRow):[];
  const sources=[
   ...source_documents.map(row=>({kind:'source_document',source_id:row.id,available:row.status==='active',
    version:row.content_sha256,status:row.status})),
   ...local_wechat_observations.map(row=>({kind:'local_wechat_observation',source_id:row.id,available:true,
    version:row.cli_version,status:'active'})),
  ];
  const source_processing_batches=await this.sourceBatchesForTrace(c,s,input);
  return {messages,sources,source_documents,local_wechat_observations,source_processing_batches};
 }
 private async sourceBatchesForTrace(c:pg.ClientBase,s:TraceScope,input:{messageIds:string[];sourceIds:string[];
  dependencyIds:string[]}):Promise<Record<string,any>[]> {
  const batches=(await c.query(`SELECT DISTINCT batch.* FROM public.source_processing_batch batch
   LEFT JOIN public.source_processing_record record ON record.batch_id=batch.batch_id
    AND record.owner_id=batch.owner_id AND record.contact_id=batch.contact_id
   WHERE batch.owner_id=$1 AND batch.contact_id=$2 AND (batch.batch_id=ANY($3::uuid[])
    OR batch.source_id=ANY($3::uuid[]) OR record.message_id=ANY($4::uuid[]))
   ORDER BY batch.recorded_at DESC,batch.batch_id DESC`,
   [s.ownerId,s.contactId,input.dependencyIds,input.messageIds])).rows;
  const result:Record<string,any>[]=[];
  for(const batch of batches){
   const records=(await c.query(`SELECT *,payload::text AS payload_text FROM public.source_processing_record
    WHERE batch_id=$1 AND owner_id=$2 AND contact_id=$3 ORDER BY position`,[batch.batch_id,s.ownerId,s.contactId])).rows;
   result.push({...batchRow(batch),records:records.map(record=>({...record,payload:payload(record.payload_text),
    payload_sha256:payloadSha(record.payload_text)}))});
  }
  return result;
  }
 private async tasks(c:pg.ClientBase,s:TraceScope,ids:string[]):Promise<Record<string,any>[]> {
  if(!ids.length)return [];
  const rows=(await c.query(`SELECT t.*,${processingSourceValidity('t')} AS source_available,
    (SELECT count(*)::int FROM public.memory_processing_target target WHERE target.task_id=t.id) AS total_count,
    (SELECT count(*)::int FROM public.memory_processing_target target WHERE target.task_id=t.id
      AND target.completed_at IS NOT NULL) AS processed_count
   FROM public.background_task t WHERE t.owner_id=$1 AND t.contact_id=$2 AND t.id=ANY($3::uuid[])
   ORDER BY t.created_at,t.id`,[s.ownerId,s.contactId,ids])).rows;
  const result:Record<string,any>[]=[];
  for(const row of rows){
   const steps=(await c.query(`SELECT id,step_name,step_order,status,attempt_count,processed_count,total_count,
     last_error_code,started_at,finished_at,updated_at FROM public.background_task_step WHERE task_id=$1 ORDER BY step_order`,
     [row.id])).rows.map(batchRow);
   result.push({...batchRow(row),steps,failure:row.last_error_code?{stage:row.current_step??null,code:row.last_error_code}:null});
  }
  return result;
 }
 private async writeReceipts(c:pg.ClientBase,s:TraceScope,links:Record<string,any>[],status:string):Promise<Record<string,any>[]> {
  const receipts:Record<string,any>[]=[];const observed=failedStatuses.has(status);
  for(const link of links){
   if(link.record_kind==='message')continue;
   const row=await this.linkedRecord(c,s,link.record_kind,link.record_id);
   const commit_status=link.commit_status==='committed'?'committed':row&&(link.operation!=='invalidate'||row.status==='invalidated')
    ?'committed':'unknown';
   receipts.push({record_kind:link.record_kind,record_id:link.record_id,operation:link.operation,commit_status,
    current_record_status:row?.status??'not_present',adoption_method:row?.adoption_method??null,revision:row?.revision??null,
    observed_after_failure:observed,capture_layer:'authoritative_current_record',historical_return_reconstructed:false});
   if(link.record_kind==='candidate')for(const [kind,table] of [['contact_memory','confirmed_memory'],
    ['owner_memory','owner_memory']] as const){
    const memories=(await c.query(`SELECT id,status,adoption_method,revision FROM public.${table}
     WHERE owner_id=$1 AND source_candidate_id=$2 ${kind==='contact_memory'?'AND contact_id=$3':''}
     ORDER BY id`,[...(kind==='contact_memory'?[s.ownerId,link.record_id,s.contactId]:[s.ownerId,link.record_id])])).rows;
    for(const memory of memories)receipts.push({record_kind:kind,record_id:memory.id,source_candidate_id:link.record_id,
     operation:'save',commit_status:'committed',current_record_status:memory.status,adoption_method:memory.adoption_method,
     revision:memory.revision,observed_after_failure:observed,capture_layer:'authoritative_current_record',
     historical_return_reconstructed:false});
   }
  }
  return receipts;
 }
 private async linkedRecord(c:pg.ClientBase,s:TraceScope,kind:string,id:string):Promise<Record<string,any>|undefined> {
  if(kind==='candidate')return (await c.query(`SELECT id,status FROM public.memory_candidate
   WHERE owner_id=$1 AND contact_id=$2 AND id=$3`,[s.ownerId,s.contactId,id])).rows[0];
  if(kind==='contact_memory')return (await c.query(`SELECT id,status,adoption_method,revision FROM public.confirmed_memory
   WHERE owner_id=$1 AND contact_id=$2 AND id=$3`,[s.ownerId,s.contactId,id])).rows[0];
  if(kind==='owner_memory')return (await c.query(`SELECT memory.id,memory.status,memory.adoption_method,memory.revision
   FROM public.owner_memory memory LEFT JOIN public.memory_candidate candidate
    ON candidate.id=memory.source_candidate_id AND candidate.owner_id=memory.owner_id
   WHERE memory.owner_id=$1 AND memory.id=$2 AND (candidate.contact_id=$3 OR EXISTS(
    SELECT 1 FROM public.source_document source WHERE source.owner_id=memory.owner_id
     AND source.contact_id=$3 AND source.id=ANY(memory.source_ids)) OR EXISTS(
    SELECT 1 FROM public.message message WHERE message.owner_id=memory.owner_id
     AND message.contact_id=$3 AND message.id=ANY(memory.source_ids)) OR (
    memory.source_candidate_id IS NULL AND memory.adoption_method='manual' AND memory.source_ids=ARRAY[memory.owner_id]))`,
    [s.ownerId,id,s.contactId])).rows[0];
  return undefined;
 }
 private async memoryVersions(c:pg.ClientBase,s:TraceScope,receipts:Record<string,any>[]):Promise<Record<string,any>[]> {
  const ids=[...new Set(receipts.filter(row=>row.record_kind!=='candidate').map(row=>row.record_id))];
  if(!ids.length)return [];
  return (await c.query(`SELECT 'contact_memory' AS record_kind,id,status,adoption_method,revision,supersedes_memory_id,
    source_candidate_id,source_dependency_mode,requires_all_sources,merge_parent_ids,valid_at,invalid_at
   FROM public.confirmed_memory WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[])
   UNION ALL SELECT 'owner_memory',id,status,adoption_method,revision,supersedes_memory_id,source_candidate_id,
    source_dependency_mode,requires_all_sources,merge_parent_ids,valid_at,invalid_at
   FROM public.owner_memory WHERE owner_id=$1 AND id=ANY($3::uuid[])
   ORDER BY record_kind,id`,[s.ownerId,s.contactId,ids])).rows.map(batchRow);
 }
 private missingStages(events:Record<string,any>[],status:string):string[] {
  const stages=new Set(events.map(event=>event.stage));const missing:string[]=[];
  if(!stages.has('window'))missing.push('window');
  if(!stages.has('extraction_return')&&status!=='running')missing.push('extraction_return');
  if((stages.has('verification_input')&&!stages.has('verification_return'))||
   (stages.has('verification_input')&&!stages.has('verification')))missing.push('verification');
  if(!stages.has('candidate_result')&&[...stages].some(stage=>stage==='verification'||stage==='verification_contract'))
   missing.push('adjudication_or_write');
  if(status!=='running'&&!stages.has('batch_end'))missing.push('batch_end');
  return missing;
 }
}

function dependencyAvailable(column:string):string {
 return `(EXISTS(SELECT 1 FROM public.source_document source WHERE source.id=${column}
   AND source.owner_id=$2 AND source.contact_id=$3 AND source.status='active')
  OR EXISTS(SELECT 1 FROM public.local_wechat_observation observation WHERE observation.id=${column}
   AND observation.owner_id=$2 AND observation.contact_id=$3)
  OR EXISTS(SELECT 1 FROM public.source_processing_batch batch WHERE batch.batch_id=${column}
   AND batch.owner_id=$2 AND batch.contact_id=$3 AND batch.status<>'deleted')
  OR EXISTS(SELECT 1 FROM public.message message WHERE message.id=${column} AND message.owner_id=$2
   AND EXISTS(SELECT 1 FROM public.message_source_ref ref WHERE ref.message_id=message.id
    AND ref.owner_id=message.owner_id AND ref.contact_id=message.contact_id AND (
     EXISTS(SELECT 1 FROM public.source_document source WHERE source.id=ref.source_document_id
      AND source.owner_id=ref.owner_id AND source.contact_id=ref.contact_id AND source.status='active')
     OR EXISTS(SELECT 1 FROM public.local_wechat_observation observation WHERE observation.id=ref.observation_id
      AND observation.owner_id=ref.owner_id AND observation.contact_id=ref.contact_id))))
  OR EXISTS(SELECT 1 FROM public.memory_candidate candidate WHERE candidate.id=${column}
   AND candidate.owner_id=$2 AND candidate.contact_id=$3 AND candidate.status<>'deleted')
  OR EXISTS(SELECT 1 FROM public.confirmed_memory memory WHERE memory.id=${column}
   AND memory.owner_id=$2 AND memory.contact_id=$3 AND memory.status<>'deleted')
  OR EXISTS(SELECT 1 FROM public.owner_memory memory WHERE memory.id=${column}
   AND memory.owner_id=$2 AND memory.status<>'deleted' AND (
    EXISTS(SELECT 1 FROM public.memory_candidate candidate
     WHERE candidate.id=memory.source_candidate_id AND candidate.owner_id=memory.owner_id
      AND candidate.contact_id=$3 AND candidate.status<>'deleted')
    OR EXISTS(SELECT 1 FROM public.source_document source
     WHERE source.id=ANY(memory.source_ids) AND source.owner_id=memory.owner_id
      AND source.contact_id=$3 AND source.status='active')
    OR EXISTS(SELECT 1 FROM public.message message
     WHERE message.id=ANY(memory.source_ids) AND message.owner_id=memory.owner_id
      AND message.contact_id=$3)
    OR (memory.source_candidate_id IS NULL AND memory.adoption_method='manual'
     AND memory.source_ids=ARRAY[memory.owner_id]))))`;
}
function processingSourceValidity(alias:string):string {
 return `(((${alias}.task_type='import' AND EXISTS(SELECT 1 FROM public.source_document source
    WHERE source.id=${alias}.source_document_id AND source.owner_id=${alias}.owner_id
     AND source.contact_id=${alias}.contact_id AND source.status='active'))
   OR (${alias}.task_type='observation' AND EXISTS(SELECT 1 FROM public.conversation_binding binding
    WHERE binding.owner_id=${alias}.owner_id AND binding.contact_id=${alias}.contact_id AND binding.status='active')))
  OR ${alias}.task_type NOT IN ('import','observation'))`;
}
