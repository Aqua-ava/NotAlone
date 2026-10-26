/** 原提取消息读取/来源冻结接缝；提交者须在原scope锁事务中复验后写入。 */
import type pg from 'pg';
import {activeRef,captureSnapshot,validateFrozen,canonicalJSON,parseStoredJSON,digest,type Evidence} from '../overview/contact-overview-evidence.ts';
import type {ExtractionMessage} from './extraction-protocol.ts';
export interface ExtractionSourceScope {ownerId:string;contactId:string}
export type ScopedExtractionMessage=ExtractionMessage&{owner_id:string;contact_id:string};
export interface FrozenExtractionSources {
 version:1;scope:ExtractionSourceScope;target_message_ids:string[];context_message_ids:string[];
 messages:ScopedExtractionMessage[];evidence:Evidence;fingerprint:string;
}
export class ExtractionSourcesError extends Error {
 readonly code:string;constructor(code:string){super(code);this.code=code;}
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function checkScope(scope:ExtractionSourceScope){if(!scope||!uuid.test(scope.ownerId)||!uuid.test(scope.contactId))throw new ExtractionSourcesError('extraction_sources_scope');}
function checkSelection(selection:{target_message_ids:string[];context_message_ids:string[]}):string[]{
 const target=selection.target_message_ids,context=selection.context_message_ids;
 if(!Array.isArray(target)||!Array.isArray(context)||!target.length||target.length>600||context.length>40)throw new ExtractionSourcesError('extraction_sources_bounds');
 const ids=[...target,...context];
 if(ids.length>640||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!uuid.test(id)))throw new ExtractionSourcesError('extraction_sources_bounds');
 return ids;
}
function freeze<T>(value:T):T {if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
const timestamp=(column:string)=>`CASE WHEN ${column} IS NULL THEN NULL ELSE to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS') || CASE WHEN extract(microseconds FROM ${column})::bigint % 1000000 = 0 THEN '' ELSE to_char(${column} AT TIME ZONE 'UTC','.US') END || '+00:00' END`;
async function readMessages(client:pg.ClientBase,scope:ExtractionSourceScope,ids:string[],refIds:string[]|null):Promise<ScopedExtractionMessage[]> {
 const rows=(await client.query(`SELECT message.id,message.speaker,message.message_type,message.text_content,message.media_placeholder,
  ${timestamp('message.occurred_at')} AS occurred_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'source_ref_id',ref.id,'source_id',COALESCE(ref.source_document_id,ref.observation_id),'source_kind',ref.source_kind,
   'locator',ref.source_locator,'capture_layer',COALESCE(processing.payload->>'capture_layer','legacy_projection'),
   'raw_payload',ref.raw_payload,'source_content_sha256',(SELECT s.content_sha256 FROM source_document s WHERE s.id=ref.source_document_id AND s.owner_id=ref.owner_id AND s.contact_id=ref.contact_id AND s.status='active'),
   'processing_status',CASE WHEN processing.status='recorded' AND processing.payload->>'capture_layer'='parsed_only' THEN 'partial' ELSE COALESCE(processing.status,'missing') END,
   'processing_record',CASE WHEN processing.record_id IS NULL THEN NULL ELSE to_jsonb(processing) END,
   'source_recorded_at',ref.created_at) ORDER BY ref.created_at,ref.id)
   FROM message_source_ref ref LEFT JOIN LATERAL (
    SELECT record.*,batch.status FROM source_processing_record record JOIN source_processing_batch batch USING(batch_id,owner_id,contact_id)
    WHERE record.source_ref_id=ref.id AND record.owner_id=ref.owner_id AND record.contact_id=ref.contact_id
    ORDER BY batch.recorded_at DESC,batch.batch_id DESC LIMIT 1
   ) processing ON true WHERE ref.message_id=message.id AND ref.owner_id=message.owner_id AND ref.contact_id=message.contact_id
   AND ${activeRef} AND ($4::uuid[] IS NULL OR ref.id=ANY($4::uuid[]))),'[]'::jsonb)::text AS sources_text
  FROM message WHERE message.owner_id=$1 AND message.contact_id=$2 AND message.id=ANY($3::uuid[])
  ORDER BY message.occurred_at NULLS LAST,message.created_at,message.id`,[scope.ownerId,scope.contactId,ids,refIds])).rows;
 const messages:ScopedExtractionMessage[]=[];
 for(const row of rows){
  const text=row.text_content||row.media_placeholder||'',sources=parseStoredJSON(row.sources_text) as unknown as Record<string,unknown>[];
  // 显式冻结ID不静默掉项，避免目标或辅助上下文缺失后仍推进水位。
  if(!['contact','user'].includes(row.speaker)||!text.trim()||!sources.length)throw new ExtractionSourcesError('extraction_sources_unavailable');
  messages.push({message_id:row.id,owner_id:scope.ownerId,contact_id:scope.contactId,text,sender:row.speaker==='user'?'self':'contact',occurred_at:row.occurred_at,
   text_representation:!row.text_content?'placeholder':row.message_type==='text'?'text':'unknown',source_snapshots:sources,
   message_snapshot:{capture_layer:'normalized_message_row',speaker:row.speaker,message_type:row.message_type,text_content:row.text_content,media_placeholder:row.media_placeholder,occurred_at:row.occurred_at}});
 }
 if(messages.length!==ids.length)throw new ExtractionSourcesError('extraction_sources_unavailable');
 return messages;
}
/** 任务规划只读取显式同scope身份；每批最终提交仍走freezeExtractionSources重新冻结。 */
export async function loadExtractionSourceMessages(
 client:pg.ClientBase,
 scope:ExtractionSourceScope,
 ids:readonly string[],
):Promise<ScopedExtractionMessage[]>{
 checkScope(scope);
 if(ids.length>640||new Set(ids).size!==ids.length
  ||ids.some(id=>typeof id!=='string'||!uuid.test(id)))throw new ExtractionSourcesError('extraction_sources_bounds');
 return freeze(await readMessages(client,scope,[...ids],null));
}
/** 只读取明确的同scope ID，最多完整run600目标+40辅助上下文。持久化须用canonicalJSON保留raw大整数。 */
export async function freezeExtractionSources(client:pg.ClientBase,scope:ExtractionSourceScope,selection:{target_message_ids:string[];context_message_ids:string[]}):Promise<FrozenExtractionSources>{
 checkScope(scope);const ids=checkSelection(selection),ownedScope={...scope};
 const messages=await readMessages(client,ownedScope,ids,null);
 // 既有helper只依赖query；ClientBase允许原事务PoolClient，不引入新连接。
 const evidence=await captureSnapshot(client as pg.Client,scope.ownerId,ids,[],scope.contactId);
 if(evidence.message_ids.length!==ids.length)throw new ExtractionSourcesError('extraction_sources_unavailable');
 const payload={version:1 as const,scope:ownedScope,target_message_ids:[...selection.target_message_ids],context_message_ids:[...selection.context_message_ids],messages,evidence};
 const frozen={...payload,fingerprint:digest(payload)};
 await requireCurrent(client,scope,frozen);
 return freeze(frozen);
}
function decodeFrozen(value:FrozenExtractionSources|string):FrozenExtractionSources {
 if(typeof value!=='string')return value;
 try {const parsed=parseStoredJSON(value);if(canonicalJSON(parsed.version)!=='1')throw new Error();parsed.version=1;return parsed as FrozenExtractionSources;}
 catch{throw new ExtractionSourcesError('extraction_sources_changed');}
}
/** 沿冻结原引用复验；新ref不补证，任一辅助消息/处理记录/来源摘要变化均撤销提交资格。 */
export async function requireCurrent(client:pg.ClientBase,scope:ExtractionSourceScope,value:FrozenExtractionSources|string):Promise<void>{
 const frozen=decodeFrozen(value);checkScope(scope);
 if(!frozen||frozen.version!==1||frozen.scope.ownerId!==scope.ownerId||frozen.scope.contactId!==scope.contactId)throw new ExtractionSourcesError('extraction_sources_scope');
 try {
  const ids=checkSelection(frozen),{fingerprint,...payload}=frozen;
  if(digest(payload)!==fingerprint||canonicalJSON([...ids].sort())!==canonicalJSON([...frozen.evidence.message_ids].sort()))throw new Error();
  await validateFrozen(client as pg.Client,scope.ownerId,frozen.evidence);
  const refIds=frozen.evidence.source_refs.map((ref:Evidence)=>ref.ref_id);
  const current=await readMessages(client,scope,ids,refIds);
  if(canonicalJSON(current)!==canonicalJSON(frozen.messages))throw new Error();
 }catch{throw new ExtractionSourcesError('extraction_sources_changed');}
}
export async function loadExtractionSources(client:pg.ClientBase,scope:ExtractionSourceScope,value:FrozenExtractionSources|string):Promise<ScopedExtractionMessage[]>{
 const frozen=decodeFrozen(value);
 await requireCurrent(client,scope,frozen);return freeze(frozen.messages);
}
