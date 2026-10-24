/** 单联系人导入业务：范围核验、原子保存、幂等重放与提交后唤醒。 */
import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {parseHistoryImport,type NormalizedHistoryMessage,type ParsedHistoryImport} from './history-import-format.ts';
import {HostStorageError} from './host-storage.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type HistoryImportTransaction=<T>(work:(client:pg.ClientBase)=>Promise<T>)=>Promise<T>;
export interface HistoryImportScope {ownerId:string;contactId:string}
export type HistoryImportWakeResult=boolean|void|'started'|'busy'|'queued';
export type HistoryImportWake=(scope:HistoryImportScope,taskId:string)=>
  HistoryImportWakeResult|Promise<HistoryImportWakeResult>;
export interface HistoryImportServiceOptions {
  transaction:HistoryImportTransaction;
  ownerId:string;
  wake?:HistoryImportWake;
}
export interface HistoryImportReceipt {
  imported_count:number;
  skipped_duplicates:number;
  contact_id:string;
  task_id:string;
  processing_deferred?:true;
  deferred_reason?:string;
}
export class HistoryImportError extends HostStorageError {
  readonly status:number;
  constructor(code:string,status=409){super(code);this.status=status;this.name='HistoryImportError';}
}

function wakeFailureReason(error:unknown):string{
  const reason=error&&typeof error==='object'&&'deferredReason' in error
    ? (error as {deferredReason?:unknown}).deferredReason : undefined;
  return reason==='worker_unavailable'||reason==='model_configuration_unavailable'
    ? reason : 'wake_failed';
}

interface PersistedImport {receipt:HistoryImportReceipt;scope:HistoryImportScope}
interface ImportRow extends NormalizedHistoryMessage {messageId:string;sourceRefId:string;processingId:string}
type StoredSource={id:string;status:string;record_count:number};

function execution(at:string,status='succeeded'):Record<string,unknown>{
  return {started_at:at,finished_at:at,status,rule_version:'history-import-ts-v1'};
}

export class HistoryImportService {
  private readonly transaction:HistoryImportTransaction;
  private readonly ownerId:string;
  private readonly wake:HistoryImportWake|undefined;
  constructor(options:HistoryImportServiceOptions){
    if(!uuid.test(options.ownerId))throw new HistoryImportError('import_identity_conflict',422);
    this.transaction=options.transaction;this.ownerId=options.ownerId.toLowerCase();this.wake=options.wake;
  }

  async preview(path:string,contactId:string):Promise<Record<string,unknown>>{
    const parsed=await parseHistoryImport(path);
    await this.transaction(client=>this.validateIdentity(client,contactId,parsed));
    return {valid:true,file_name:parsed.fileName,content_sha256:parsed.contentSha256,
      record_count:parsed.messages.length,kind_counts:parsed.kindCounts,
      owner_channel_identity:{external_id:parsed.ownerIdentity.externalId,observed_name:parsed.ownerIdentity.observedName},
      contact_channel_identity:{external_id:parsed.contactIdentity.externalId,observed_name:parsed.contactIdentity.observedName}};
  }

  async commit(path:string,contactId:string,expectedDigest:string):Promise<HistoryImportReceipt>{
    const parsed=await parseHistoryImport(path);
    if(parsed.contentSha256!==expectedDigest)throw new HistoryImportError('import_file_changed',409);
    const persisted=await this.transaction(client=>this.persist(client,contactId,parsed));
    if(!this.wake)return {...persisted.receipt,processing_deferred:true,deferred_reason:'worker_unavailable'};
    try{
      const awakened=await this.wake(persisted.scope,persisted.receipt.task_id);
      if(awakened===false)return {...persisted.receipt,processing_deferred:true,deferred_reason:'worker_unavailable'};
      return persisted.receipt;
    }catch(error){
      return {...persisted.receipt,processing_deferred:true,deferred_reason:wakeFailureReason(error)};
    }
  }

  private async validateIdentity(client:pg.ClientBase,contactId:string,parsed:ParsedHistoryImport):Promise<void>{
    const owner=(await client.query("SELECT external_id FROM public.owner_channel_identity WHERE owner_id=$1 AND channel='wechat' AND status='active' FOR SHARE",[this.ownerId])).rows[0];
    if(!owner||owner.external_id!==parsed.ownerIdentity.externalId)throw new HistoryImportError('import_identity_conflict',422);
    if(!(await client.query('SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2 FOR KEY SHARE',[this.ownerId,contactId])).rowCount)throw new HistoryImportError('import_identity_conflict',422);
    const contact=(await client.query("SELECT external_id FROM public.channel_identity WHERE owner_id=$1 AND contact_id=$2 AND channel='wechat' AND status='active' FOR SHARE",[this.ownerId,contactId])).rows[0];
    if(contact&&contact.external_id!==parsed.contactIdentity.externalId)throw new HistoryImportError('import_identity_conflict',422);
  }

  private async persist(client:pg.ClientBase,contactId:string,parsed:ParsedHistoryImport):Promise<PersistedImport>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${this.ownerId}:${contactId}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${this.ownerId}`]);
    await this.validateIdentityLocked(client,contactId,parsed);
    const channelId=await this.ensureContactIdentity(client,contactId,parsed);
    const inserted=(await client.query(`INSERT INTO public.source_document(owner_id,contact_id,source_type,file_name,content_sha256,record_count)
      VALUES($1,$2,'wechat_jsonl',$3,$4,$5) ON CONFLICT(owner_id,contact_id,content_sha256) DO NOTHING RETURNING id`,
    [this.ownerId,contactId,parsed.fileName,parsed.contentSha256,parsed.messages.length])).rows[0]?.id as string|undefined;
    if(!inserted){
      const existing=(await client.query(`SELECT id,status,record_count FROM public.source_document
        WHERE owner_id=$1 AND contact_id=$2 AND content_sha256=$3 FOR UPDATE`,
      [this.ownerId,contactId,parsed.contentSha256])).rows[0] as StoredSource|undefined;
      if(!existing||existing.status!=='active')throw new HistoryImportError('import_commit_failed');
      const confirmation=(await client.query(`SELECT channel_identity_id,method FROM public.import_confirmation
        WHERE owner_id=$1 AND contact_id=$2 AND source_document_id=$3 FOR UPDATE`,
      [this.ownerId,contactId,existing.id])).rows[0];
      if(!confirmation||confirmation.method!=='manual_select')throw new HistoryImportError('import_commit_failed');
      return {scope:{ownerId:this.ownerId,contactId},
        receipt:{imported_count:0,skipped_duplicates:existing.record_count,contact_id:contactId,
          task_id:await this.ensureTask(client,contactId,existing.id,existing.record_count)}};
    }
    const sourceId=inserted;
    await client.query(`INSERT INTO public.import_confirmation(owner_id,contact_id,source_document_id,channel_identity_id,method)
      VALUES($1,$2,$3,$4,'manual_select')`,[this.ownerId,contactId,sourceId,channelId]);
    await this.rejectOverlap(client,contactId,parsed.messages);
    await this.insertMessages(client,contactId,sourceId,parsed.messages);
    const taskId=await this.ensureTask(client,contactId,sourceId,parsed.messages.length);
    return {scope:{ownerId:this.ownerId,contactId},receipt:{imported_count:parsed.messages.length,skipped_duplicates:0,contact_id:contactId,task_id:taskId}};
  }

  private async validateIdentityLocked(client:pg.ClientBase,contactId:string,parsed:ParsedHistoryImport):Promise<void>{
    const owner=(await client.query("SELECT external_id FROM public.owner_channel_identity WHERE owner_id=$1 AND channel='wechat' AND status='active' FOR UPDATE",[this.ownerId])).rows[0];
    if(!owner||owner.external_id!==parsed.ownerIdentity.externalId)throw new HistoryImportError('import_commit_failed');
    if(!(await client.query('SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2 FOR UPDATE',[this.ownerId,contactId])).rowCount)throw new HistoryImportError('import_commit_failed');
  }

  private async ensureContactIdentity(client:pg.ClientBase,contactId:string,parsed:ParsedHistoryImport):Promise<string>{
    const existing=(await client.query(`SELECT id,external_id FROM public.channel_identity
      WHERE owner_id=$1 AND contact_id=$2 AND channel='wechat' AND status='active' FOR UPDATE`,
    [this.ownerId,contactId])).rows[0];
    if(existing){
      if(existing.external_id!==parsed.contactIdentity.externalId)throw new HistoryImportError('import_commit_failed');
      return existing.id;
    }
    return (await client.query(`INSERT INTO public.channel_identity(owner_id,contact_id,channel,external_id,observed_name)
      VALUES($1,$2,'wechat',$3,$4) RETURNING id`,
    [this.ownerId,contactId,parsed.contactIdentity.externalId,parsed.contactIdentity.observedName])).rows[0].id;
  }

  private async rejectOverlap(client:pg.ClientBase,contactId:string,messages:NormalizedHistoryMessage[]):Promise<void>{
    const overlap=await client.query(`SELECT 1 FROM public.wechat_message_metadata existing
      JOIN unnest($1::bigint[],$2::bigint[]) incoming(external_local_id,source_create_time)
      ON incoming.external_local_id=existing.external_local_id AND incoming.source_create_time=existing.source_create_time
      WHERE existing.owner_id=$3 AND existing.contact_id=$4 LIMIT 1`,
    [messages.map(message=>message.externalLocalId),messages.map(message=>message.sourceCreateTime),this.ownerId,contactId]);
    if(overlap.rowCount)throw new HistoryImportError('import_commit_failed');
  }

  private async insertMessages(client:pg.ClientBase,contactId:string,sourceId:string,messages:NormalizedHistoryMessage[]):Promise<void>{
    const rows:ImportRow[]=messages.map(message=>({...message,messageId:randomUUID(),sourceRefId:randomUUID(),processingId:randomUUID()}));
    for(let offset=0;offset<rows.length;offset+=500){
      const chunk=rows.slice(offset,offset+500);
      await client.query(`INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,media_placeholder,occurred_at)
        SELECT incoming.message_id,$1,$2,incoming.speaker,incoming.message_type,incoming.text_content,
          incoming.media_placeholder,incoming.occurred_at::timestamptz
        FROM unnest($3::uuid[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[])
          AS incoming(message_id,speaker,message_type,text_content,media_placeholder,occurred_at)`,
      [this.ownerId,contactId,chunk.map(row=>row.messageId),chunk.map(row=>row.speaker),chunk.map(row=>row.messageType),
        chunk.map(row=>row.textContent),chunk.map(row=>row.mediaPlaceholder),chunk.map(row=>row.occurredAt)]);
      await client.query(`INSERT INTO public.wechat_message_metadata(message_id,owner_id,contact_id,external_local_id,
          external_server_id,external_talker,source_create_time)
        SELECT incoming.message_id,$1,$2,incoming.external_local_id,incoming.external_server_id,
          incoming.external_talker,incoming.source_create_time
        FROM unnest($3::uuid[],$4::bigint[],$5::text[],$6::text[],$7::bigint[])
          AS incoming(message_id,external_local_id,external_server_id,external_talker,source_create_time)`,
      [this.ownerId,contactId,chunk.map(row=>row.messageId),chunk.map(row=>row.externalLocalId),
        chunk.map(row=>row.externalServerId),chunk.map(row=>row.externalTalker),chunk.map(row=>row.sourceCreateTime)]);
      await client.query(`INSERT INTO public.message_source_ref(id,message_id,owner_id,contact_id,source_kind,
          source_document_id,source_locator,raw_payload)
        SELECT incoming.source_ref_id,incoming.message_id,$1,$2,'source_document',$3,
          incoming.source_locator,incoming.raw_payload::jsonb
        FROM unnest($4::uuid[],$5::uuid[],$6::text[],$7::text[])
          AS incoming(source_ref_id,message_id,source_locator,raw_payload)`,
      [this.ownerId,contactId,sourceId,chunk.map(row=>row.sourceRefId),chunk.map(row=>row.messageId),
        chunk.map(row=>row.sourceLocator),chunk.map(row=>JSON.stringify(row.rawPayload))]);
    }
    await this.saveProcessing(client,contactId,sourceId,rows);
  }

  private async saveProcessing(client:pg.ClientBase,contactId:string,sourceId:string,rows:ImportRow[]):Promise<void>{
    const batchId=randomUUID(),now=new Date().toISOString();
    await client.query(`INSERT INTO public.source_processing_batch(batch_id,owner_id,contact_id,source_kind,source_id,status)
      VALUES($1,$2,$3,'source_document',$4,'recorded')`,[batchId,this.ownerId,contactId,sourceId]);
    for(let offset=0;offset<rows.length;offset+=250){
      const chunk=rows.slice(offset,offset+250);
      const payloads=chunk.map(row=>JSON.stringify({
        capture_layer:'jsonl_record_text',capture_status:'recorded',record_text:row.recordText,parsed:row.rawPayload,
        read:execution(now),parse:execution(now),converted:{speaker:row.speaker,message_type:row.messageType,
          text_content:row.textContent,media_placeholder:row.mediaPlaceholder,occurred_at:row.occurredAt},
        validation:execution(now),normalize:execution(now),transformations:{
          speaker:{rule:'system_else_is_from_me',output:row.speaker},
          time:{rule:'validated_time_iso_preserve_offset',output:row.occurredAt},
          body:{rule:'media_placeholder_or_unchanged_text',output_field:row.mediaPlaceholder?'media_placeholder':'text_content'}},
        capture_record_id:row.processingId,
        persistence:{message_id:row.messageId,source_ref_id:row.sourceRefId,outcome:'message_created',
          source_ref_added:true,dedup_rule:'active_source_sha256_reuse_else_reject_overlapping_message'},
        model_read_status:'not_claimed',outcome:'normalized',
      }));
      await client.query(`INSERT INTO public.source_processing_record(record_id,batch_id,owner_id,contact_id,position,
          locator,message_id,source_ref_id,outcome,payload)
        SELECT incoming.record_id,$1,$2,$3,incoming.position,incoming.locator,incoming.message_id,
          incoming.source_ref_id,'normalized',incoming.payload::jsonb
        FROM unnest($4::uuid[],$5::integer[],$6::text[],$7::uuid[],$8::uuid[],$9::text[])
          AS incoming(record_id,position,locator,message_id,source_ref_id,payload)`,
      [batchId,this.ownerId,contactId,chunk.map(row=>row.processingId),chunk.map((_,index)=>offset+index),
        chunk.map(row=>row.sourceLocator),chunk.map(row=>row.messageId),chunk.map(row=>row.sourceRefId),payloads]);
    }
  }

  private async ensureTask(client:pg.ClientBase,contactId:string,sourceId:string,messageCount:number):Promise<string>{
    const inserted=(await client.query(`INSERT INTO public.background_task(owner_id,contact_id,source_document_id,task_type,status,current_step,message_count)
      VALUES($1,$2,$3,'import','queued','parse',$4)
      ON CONFLICT(owner_id,contact_id,source_document_id,task_type) DO NOTHING RETURNING id`,
    [this.ownerId,contactId,sourceId,messageCount])).rows[0]?.id;
    const taskId=inserted??(await client.query(`SELECT id FROM public.background_task
      WHERE owner_id=$1 AND contact_id=$2 AND source_document_id=$3 AND task_type='import' FOR UPDATE`,
    [this.ownerId,contactId,sourceId])).rows[0]?.id;
    if(!taskId)throw new HistoryImportError('import_commit_failed');
    for(const [index,name] of ['parse','normalize','extract_memory','index','verify'].entries()){
      await client.query(`INSERT INTO public.background_task_step(task_id,step_name,step_order,total_count)
        VALUES($1,$2,$3,$4) ON CONFLICT(task_id,step_name) DO NOTHING`,[taskId,name,index+1,messageCount]);
    }
    return taskId;
  }
}
