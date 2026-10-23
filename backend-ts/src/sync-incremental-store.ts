/** 增量保存的普通业务模块；原 PostgreSQL 为唯一真相，不依赖模型或 DSH 会话。 */
import {randomUUID} from 'node:crypto';
import {parseJson} from './host-json.ts';
import type pg from 'pg';
import {HostStorageError} from './host-storage.ts';
import type {IncrementalTailResult, NormalizedIncrementalMessage, IncrementalProcessingRecord} from './sync-incremental-normalize.ts';
import {filterAutoRead} from './sync-auto-read-suppression.ts';
import {saveIncrementalMessages, saveIncrementalProcessing} from './sync-incremental-store-write.ts';
export interface IncrementalBinding {binding_id:string; contact_id:string; conversation_locator:string}
export interface IncrementalCursor {last_local_id:string; last_cursor:string}
export interface IncrementalPosition {baseline_at:string;cursor:IncrementalCursor|null;history_busy:boolean;position_token:string}
export interface IncrementalStorage {businessTransaction<T>(operation:(client:pg.Client)=>Promise<T>):Promise<T>}
export interface IncrementalSave {
  binding:IncrementalBinding;page:IncrementalTailResult;messages:readonly NormalizedIncrementalMessage[];
  since_cursor:string|null;since_local_id:string|null;cli_version:string;position_token:string;
  processing_records?:readonly IncrementalProcessingRecord[];
}
export interface IncrementalSaved {observation_id:string;message_ids:string[];created_message_ids:(string|null)[];source_created:boolean;accepted_message_count:number}
export class SyncIncrementalStoreError extends HostStorageError {}
const fail=(code:string):never=>{throw new SyncIncrementalStoreError(code);};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const positive=(v:unknown):boolean=>typeof v==='string'&&/^[1-9]\d*$/.test(v)&&BigInt(v)<=9223372036854775807n;
const current=()=>{};
export class SyncIncrementalStore {
  private readonly options:{storage:IncrementalStorage;ownerId:string;accountScope:string};
  constructor(options:{storage:IncrementalStorage;ownerId:string;accountScope:string}) {
    if(!uuid(options.ownerId)||!options.accountScope.trim())fail('sync_scope_invalid');
    this.options={...options,ownerId:options.ownerId.toLowerCase()};
  }
  private transaction<T>(check:()=>void,fn:(c:pg.Client)=>Promise<T>):Promise<T>{
    check();return this.options.storage.businessTransaction(async c=>{check();const r=await fn(c);check();return r;});
  }
  private async account(c:pg.Client):Promise<void>{
    const r=await c.query("SELECT external_id FROM public.owner_channel_identity WHERE owner_id=$1 AND channel='wechat' AND status='active' FOR SHARE",[this.options.ownerId]);
    if(r.rows.length!==1||r.rows[0].external_id!==this.options.accountScope)fail('cli_account_changed');
  }
  private async lock(c:pg.Client,b:IncrementalBinding,requireEnabled=true):Promise<void>{
    if(!uuid(b.binding_id)||!uuid(b.contact_id)||!b.conversation_locator.trim())fail('sync_binding_invalid');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${this.options.ownerId}:${b.contact_id.toLowerCase()}`]);
    // 与明确重绑定、撤销、来源删除使用相同 contact→owner 顺序。
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${this.options.ownerId}`]);
    await this.account(c);
    const r=await c.query("SELECT id FROM public.conversation_binding WHERE id=$1 AND owner_id=$2 AND contact_id=$3 AND channel='wechat' AND account_scope=$4 AND conversation_locator=$5 AND status='active' FOR SHARE",[b.binding_id,this.options.ownerId,b.contact_id,this.options.accountScope,b.conversation_locator]);
    if(!r.rowCount)fail('sync_binding_invalid');
    if(requireEnabled&&!(await c.query('SELECT enabled FROM public.front_sync_state WHERE owner_id=$1 FOR SHARE',[this.options.ownerId])).rows[0]?.enabled)fail('sync_disabled');
  }
  private async historyBusy(c:pg.Client,b:IncrementalBinding):Promise<boolean>{
    return Boolean((await c.query(`SELECT 1 FROM public.wechat_binding_history_authorization a
      LEFT JOIN public.cli_history_sync_state h ON h.owner_id=a.owner_id AND h.contact_id=a.contact_id AND h.binding_id=a.binding_id
      WHERE a.owner_id=$1 AND a.contact_id=$2 AND a.binding_id=$3 AND a.version=1 AND (h.phase IS NULL OR h.phase<>'complete')`,[this.options.ownerId,b.contact_id,b.binding_id])).rowCount);
  }
  async withBindingTransaction<T>(b:IncrementalBinding,check:()=>void,operation:(client:pg.Client)=>Promise<T>):Promise<T>{
    return this.transaction(check,async c=>{await this.lock(c,b);if(await this.historyBusy(c,b))fail('sync_history_busy');return operation(c);});
  }
  /** 暂停仅改补齐元数据；停用状态仍核验账号、有效绑定及历史执行互斥。 */
  async withBackfillPauseTransaction(b:IncrementalBinding,check:()=>void,operation:(client:pg.Client)=>Promise<void>):Promise<void>{
    return this.transaction(check,async c=>{await this.lock(c,b,false);if(await this.historyBusy(c,b))return;await operation(c);});
  }
  async listBindings(check:()=>void=current):Promise<IncrementalBinding[]>{return this.transaction(check,async c=>{
    await this.account(c);return (await c.query("SELECT id AS binding_id,contact_id,conversation_locator FROM public.conversation_binding WHERE owner_id=$1 AND channel='wechat' AND account_scope=$2 AND status='active' ORDER BY id",[this.options.ownerId,this.options.accountScope])).rows;
  });}
  async readEnabled(check:()=>void=current):Promise<boolean>{return this.transaction(check,async c=>{
    await this.account(c);return (await c.query('SELECT enabled FROM public.front_sync_state WHERE owner_id=$1',[this.options.ownerId])).rows[0]?.enabled===true;
  });}
  async setEnabled(enabled:boolean,check:()=>void=current):Promise<void>{if(typeof enabled!=='boolean')fail('sync_request_invalid');return this.transaction(check,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${this.options.ownerId}`]);await this.account(c);
    await c.query(`INSERT INTO public.front_sync_state(owner_id,enabled,enabled_at,disabled_at) VALUES($1,$2,CASE WHEN $2 THEN now() END,CASE WHEN NOT $2 THEN now() END)
      ON CONFLICT(owner_id) DO UPDATE SET enabled=EXCLUDED.enabled,enabled_at=CASE WHEN EXCLUDED.enabled AND NOT front_sync_state.enabled THEN now() ELSE front_sync_state.enabled_at END,
      disabled_at=CASE WHEN NOT EXCLUDED.enabled THEN now() ELSE front_sync_state.disabled_at END,updated_at=now()`,[this.options.ownerId,enabled]);
  });}
  private async token(c:pg.Client,b:IncrementalBinding):Promise<string>{
    // 来源删除不一定改变 cursor；集合摘要阻止仍在途的旧页复活被删内容。
    const r=await c.query(`SELECT md5(COALESCE((SELECT string_agg(id::text,',' ORDER BY id) FROM public.local_wechat_observation WHERE owner_id=$1 AND contact_id=$2),'') || ':' || COALESCE((SELECT last_cursor FROM public.wechat_observation_cursor WHERE owner_id=$1 AND contact_id=$2),'')) AS token`,[this.options.ownerId,b.contact_id]);return r.rows[0].token;
  }
  async readPosition(b:IncrementalBinding,check:()=>void=current):Promise<IncrementalPosition>{return this.transaction(check,async c=>{
    await this.lock(c,b);const busy=await this.historyBusy(c,b);
    await c.query(`INSERT INTO public.wechat_observation_baseline(owner_id,contact_id,binding_id,conversation_locator,baseline_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(owner_id,contact_id,binding_id) DO NOTHING`,[this.options.ownerId,b.contact_id,b.binding_id,b.conversation_locator]);
    const baseline=(await c.query('SELECT baseline_at FROM public.wechat_observation_baseline WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 AND conversation_locator=$4',[this.options.ownerId,b.contact_id,b.binding_id,b.conversation_locator])).rows[0];
    if(!baseline)fail('sync_baseline_invalid');
    let cursor=(await c.query('SELECT binding_id,conversation_locator,last_local_id,last_cursor FROM public.wechat_observation_cursor WHERE owner_id=$1 AND contact_id=$2 FOR UPDATE',[this.options.ownerId,b.contact_id])).rows[0];
    if(!busy){
      const reliable=(await c.query(`SELECT binding_id,conversation_locator,last_local_id,last_cursor FROM public.local_wechat_observation WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 AND is_reliable ORDER BY commit_order DESC NULLS LAST,read_at DESC,id DESC LIMIT 1`,[this.options.ownerId,b.contact_id,b.binding_id])).rows[0];
      if(!cursor)cursor=reliable;
      else if(!(reliable===undefined&&cursor.conversation_locator===b.conversation_locator)&&
        (cursor.binding_id!==b.binding_id||cursor.conversation_locator!==b.conversation_locator||cursor.last_cursor!==reliable?.last_cursor)){
        if(reliable)await this.putCursor(c,b,reliable.last_local_id,reliable.last_cursor);
        else await c.query('DELETE FROM public.wechat_observation_cursor WHERE owner_id=$1 AND contact_id=$2',[this.options.ownerId,b.contact_id]);
        cursor=reliable;
      }
    }
    return {baseline_at:baseline.baseline_at.toISOString(),cursor:cursor?{last_local_id:String(cursor.last_local_id),last_cursor:cursor.last_cursor}:null,history_busy:busy,position_token:await this.token(c,b)};
  });}
  private async putCursor(c:pg.Client,b:IncrementalBinding,id:string,cursor:string):Promise<void>{
    await c.query(`INSERT INTO public.wechat_observation_cursor(owner_id,contact_id,binding_id,conversation_locator,last_local_id,last_cursor) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(owner_id,contact_id) DO UPDATE SET binding_id=EXCLUDED.binding_id,conversation_locator=EXCLUDED.conversation_locator,last_local_id=EXCLUDED.last_local_id,last_cursor=EXCLUDED.last_cursor,updated_at=now()`,[this.options.ownerId,b.contact_id,b.binding_id,b.conversation_locator,id,cursor]);
  }
  async recordInputFailure(b:IncrementalBinding,record:IncrementalProcessingRecord,check:()=>void=current):Promise<void>{
    const payload=parseJson(record.payload_json) as Record<string,unknown>;
    if(payload.capture_layer!=='metadata_only'||payload.record_text!==null||payload.parsed!==null)fail('observation_failure_record_invalid');
    return this.withBindingTransaction(b,check,c=>saveIncrementalProcessing(c,this.options.ownerId,b.contact_id,null,[record],new Map(),'failed'));
  }
  async save(input:IncrementalSave,check:()=>void=current):Promise<IncrementalSaved>{
    const {binding:b,page,messages}=input;
    if(!positive(page.last_local_id)||!page.cursor?.trim()||!input.cli_version.trim()||!page.freshness_confirmed||page.local_history_state||!input.position_token||
      input.since_local_id!==null&&!positive(input.since_local_id)||input.since_cursor!==null&&!input.since_cursor.trim()||
      !Number.isSafeInteger(page.event_count)||page.event_count<messages.length||!Number.isSafeInteger(page.non_text_count)||page.non_text_count<0||page.non_text_count>page.event_count||
      messages.some(m=>m.wechat_metadata.external_talker!==b.conversation_locator||!positive(m.wechat_metadata.external_local_id)))fail('observation_invalid');
    return this.transaction(check,async c=>{
      await this.lock(c,b);if(await this.historyBusy(c,b))fail('sync_history_busy');
      const filtered=await filterAutoRead(c,this.options.ownerId,b.contact_id,messages,input.processing_records??[...messages.map(m=>m.processing_record),...page.filtered_records]);
      const args=[this.options.ownerId,b.contact_id,b.binding_id,input.cli_version,b.conversation_locator,input.since_local_id,page.last_local_id,input.since_cursor,page.cursor,filtered.messages.length,page.event_count,page.non_text_count];
      const existing=(await c.query(`SELECT id FROM public.local_wechat_observation WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 AND mode='cli_background' AND COALESCE(since_local_id,0)=COALESCE($4::bigint,0) AND last_local_id=$5 AND COALESCE(since_cursor,'')=COALESCE($6,'') AND last_cursor=$7`,[...args.slice(0,3),input.since_local_id,page.last_local_id,input.since_cursor,page.cursor])).rows[0];
      if(!existing&&await this.token(c,b)!==input.position_token)fail('observation_position_stale');
      let observationId:string;
      if(existing){observationId=existing.id;await c.query('UPDATE public.local_wechat_observation SET event_count=$2,non_text_count=$3,is_reliable=true WHERE id=$1',[observationId,page.event_count,page.non_text_count]);}
      else{
        let position=(await c.query('SELECT conversation_locator,last_cursor FROM public.wechat_observation_cursor WHERE owner_id=$1 AND contact_id=$2 FOR UPDATE',[this.options.ownerId,b.contact_id])).rows[0];
        if(!position)position=(await c.query(`SELECT conversation_locator,last_cursor FROM public.local_wechat_observation WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 AND is_reliable ORDER BY commit_order DESC NULLS LAST,read_at DESC,id DESC LIMIT 1`,args.slice(0,3))).rows[0];
        if(position&&position.conversation_locator!==b.conversation_locator||(position?.last_cursor??null)!==input.since_cursor)fail('observation_position_stale');
        observationId=randomUUID();await c.query(`INSERT INTO public.local_wechat_observation(owner_id,contact_id,binding_id,cli_version,conversation_locator,since_local_id,last_local_id,since_cursor,last_cursor,record_count,event_count,non_text_count,mode,is_reliable,id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'cli_background',true,$13)`,[...args,observationId]);
        await this.putCursor(c,b,page.last_local_id!,page.cursor!);
      }
      const written=await saveIncrementalMessages(c,this.options.ownerId,b.contact_id,observationId,filtered.messages);
      const records=[...filtered.records];
      const position=(r:IncrementalProcessingRecord):number=>{const p=(parseJson(r.payload_json) as Record<string,unknown>).input_position;return typeof p==='number'&&Number.isFinite(p)?p:0;};
      records.sort((a,b)=>position(a)-position(b));
      await saveIncrementalProcessing(c,this.options.ownerId,b.contact_id,observationId,records,written.receipts);
      const kept=new Set(filtered.messages);let writeIndex=0;
      check();return {observation_id:observationId,message_ids:written.ids,created_message_ids:existing?[]:messages.map(m=>kept.has(m)?written.created[writeIndex++]:null),source_created:!existing,accepted_message_count:filtered.messages.length};
    });
  }
}
