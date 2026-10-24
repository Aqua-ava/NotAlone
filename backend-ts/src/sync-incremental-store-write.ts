/** 原事务内的消息、来源、处理回执与持久派生调度；不运行模型。 */
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
// 加载时固化实际规则字节摘要；后续处理不再访问磁盘。
const ruleVersion=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
import type pg from 'pg';
import {HostStorageError} from './host-storage.ts';
import {parseJson,stringifyJson} from './host-json.ts';
import type {NormalizedIncrementalMessage,IncrementalProcessingRecord} from './sync-incremental-normalize.ts';
import {recordExtractionObservation} from './extraction-task-store-schedule.ts';
type Receipt=Record<string,unknown>;
export async function saveIncrementalMessages(c:pg.Client,owner:string,contact:string,observation:string,messages:readonly NormalizedIncrementalMessage[]){
  const ids:string[]=[],created:(string|null)[]=[],receipts=new Map<string,Receipt>();
  for(const m of messages){
    const startedAt=new Date().toISOString();
    const meta=m.wechat_metadata, time=meta.source_create_time??-1;
    const old=(await c.query('SELECT message_id FROM public.wechat_message_metadata WHERE owner_id=$1 AND contact_id=$2 AND external_local_id=$3 AND COALESCE(source_create_time,-1)=$4',[owner,contact,meta.external_local_id,time])).rows[0];
    const id=old?.message_id??randomUUID();ids.push(id);created.push(old?null:id);
    if(!old){
      await c.query('INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,media_placeholder,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,owner,contact,m.speaker,m.message_type,m.text_content,m.media_placeholder,m.occurred_at]);
      await c.query('INSERT INTO public.wechat_message_metadata(message_id,owner_id,contact_id,external_local_id,external_server_id,external_talker,source_create_time) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,owner,contact,meta.external_local_id,meta.external_server_id,meta.external_talker,meta.source_create_time]);
    }
    let ref=(await c.query('SELECT id,source_locator FROM public.message_source_ref WHERE owner_id=$1 AND contact_id=$2 AND observation_id=$3 AND message_id=$4 ORDER BY id LIMIT 1',[owner,contact,observation,id])).rows[0];
    const added=!ref;
    if(!ref)ref=(await c.query(`INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,observation_id,source_locator,raw_payload) VALUES($1,$2,$3,'local_wechat_observation',$4,$5,$6::jsonb) RETURNING id,source_locator`,[id,owner,contact,observation,`cli:v2:${meta.external_local_id}:${time}`,meta.raw_payload_json])).rows[0];
    const receipt={locator:m.source_locator,capture_record_id:m.processing_record.record_id,message_id:id,source_ref_id:ref.id,source_ref_locator:ref.source_locator,
      outcome:old?'message_reused':'message_created',source_ref_added:added,dedup_key:{owner_id:owner,contact_id:contact,external_local_id:meta.external_local_id,source_create_time:time},
      dedup_rule:'stable_local_id_and_create_time_or_minus_one',execution:{started_at:startedAt,finished_at:new Date().toISOString(),status:'prepared_for_commit',rule_version:ruleVersion}};
    receipts.set(m.processing_record.record_id,receipt);
  }
  await recordExtractionObservation(c,{ownerId:owner,contactId:contact},observation,created.filter((v):v is string=>v!==null));
  return {ids,created,receipts};
}
export async function saveIncrementalProcessing(c:pg.Client,owner:string,contact:string,source:string|null,records:readonly IncrementalProcessingRecord[],receipts:Map<string,Receipt>,status:'recorded'|'failed'='recorded'){
  if(!records.length)return;
  const tombstone=await c.query('SELECT 1 FROM public.source_processing_capture_tombstone WHERE owner_id=$1 AND contact_id=$2 AND capture_record_id=ANY($3::uuid[]) LIMIT 1',[owner,contact,records.map(r=>r.record_id)]);
  if(tombstone.rowCount)throw new HostStorageError('source_processing_write_failed');
  const batch=randomUUID();
  await c.query("INSERT INTO public.source_processing_batch(batch_id,owner_id,contact_id,source_kind,source_id,status) VALUES($1,$2,$3,'local_wechat_observation',$4,$5)",[batch,owner,contact,source,status]);
  for(const [position,r]of records.entries()){
    const receipt=receipts.get(r.record_id)??{},payload=parseJson(r.payload_json) as Record<string,unknown>;
    payload.capture_record_id=r.record_id;payload.persistence=receipt;payload.model_read_status='not_claimed';
    await c.query('INSERT INTO public.source_processing_record(record_id,batch_id,owner_id,contact_id,position,locator,message_id,source_ref_id,outcome,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)',[randomUUID(),batch,owner,contact,position,r.locator,receipt.message_id??null,receipt.source_ref_id??null,receipt.outcome??payload.outcome??'filtered',stringifyJson(payload)]);
  }
}
