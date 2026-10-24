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
export interface IncrementalPosition {
  baseline_at:string;
  /** PG 按原始微秒精确向上取整的正文查询下界，不用于改写授权起点。 */
  query_since_at:string;
  cursor:IncrementalCursor|null;history_busy:boolean;position_token:string;
}
export type HistoryCoveragePhase = 'not_started'|'syncing'|'complete'|'incomplete';
/** 历史覆盖只含元数据；正文仍位于既有来源、消息与派生链路。 */
export interface HistoryCoverage {
  binding_id:string;contact_id:string;phase:HistoryCoveragePhase;failure_code:string|null;
  message_count:number;non_text_count:number;page_count:number;
  last_local_id:string|null;last_cursor:string|null;
  watermark_at:string|null;started_at:string|null;completed_at:string|null;updated_at:string|null;
}
export interface HistoryState extends HistoryCoverage {
  phase:Exclude<HistoryCoveragePhase,'not_started'>;
  watermark_at:string;started_at:string;updated_at:string;
}
export interface HistoryPreparation {state:HistoryState;position_token:string}
export interface IncrementalStorage {businessTransaction<T>(operation:(client:pg.Client)=>Promise<T>):Promise<T>}
export interface IncrementalSave {
  binding:IncrementalBinding;page:IncrementalTailResult;messages:readonly NormalizedIncrementalMessage[];
  since_cursor:string|null;since_local_id:string|null;cli_version:string;position_token:string;
  processing_records?:readonly IncrementalProcessingRecord[];
}
export interface IncrementalSaved {observation_id:string;message_ids:string[];created_message_ids:(string|null)[];source_created:boolean;accepted_message_count:number}
export interface HistoryPageSave extends IncrementalSave {history:HistoryState}
export class SyncIncrementalStoreError extends HostStorageError {}
const fail=(code:string):never=>{throw new SyncIncrementalStoreError(code);};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const positive=(v:unknown):boolean=>typeof v==='string'&&/^[1-9]\d*$/.test(v)&&BigInt(v)<=9223372036854775807n;
const current=()=>{};
const historyColumns='binding_id,contact_id,phase,failure_code,message_count,non_text_count,page_count,last_local_id,last_cursor,watermark_at,started_at,completed_at,updated_at';
const timestamp=(value:unknown):string=>{
  if(value instanceof Date&&Number.isFinite(value.getTime()))return value.toISOString();
  return fail('history_state_invalid');
};
const nullableTimestamp=(value:unknown):string|null=>value===null?null:timestamp(value);
const projectHistory=(row:Record<string,any>):HistoryState=>({
  binding_id:String(row.binding_id),contact_id:String(row.contact_id),phase:row.phase,failure_code:row.failure_code,
  message_count:row.message_count,non_text_count:row.non_text_count,page_count:row.page_count,
  last_local_id:row.last_local_id===null?null:String(row.last_local_id),last_cursor:row.last_cursor,
  watermark_at:timestamp(row.watermark_at),started_at:timestamp(row.started_at),
  completed_at:nullableTimestamp(row.completed_at),updated_at:timestamp(row.updated_at),
});
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
  /** 只为已经逐绑定明确授权的 active 会话建立历史状态；重复调用不重置检查点。 */
  async ensureHistoryStarted(bindings:readonly IncrementalBinding[],watermarkAt:Date,check:()=>void=current):Promise<number>{
    if(!Number.isFinite(watermarkAt.getTime()))fail('history_state_invalid');
    const ids=[...new Set(bindings.map(binding=>binding.binding_id))];
    if(ids.some(id=>!uuid(id)))fail('sync_binding_invalid');
    if(!ids.length)return 0;
    return this.transaction(check,async c=>{
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${this.options.ownerId}`]);
      await this.account(c);
      return (await c.query(`INSERT INTO public.cli_history_sync_state(owner_id,contact_id,binding_id,phase,watermark_at,started_at)
        SELECT b.owner_id,b.contact_id,b.id,'syncing',$3,now()
        FROM public.conversation_binding b
        JOIN public.wechat_binding_history_authorization a
          ON a.owner_id=b.owner_id AND a.contact_id=b.contact_id AND a.binding_id=b.id AND a.version=1
        WHERE b.owner_id=$1 AND b.channel='wechat' AND b.account_scope=$2 AND b.status='active'
          AND b.id=ANY($4::uuid[])
        ON CONFLICT(owner_id,contact_id,binding_id) DO NOTHING`, [this.options.ownerId,this.options.accountScope,watermarkAt,ids])).rowCount??0;
    });
  }
  private async requireHistoryAuthorization(c:pg.Client,b:IncrementalBinding):Promise<boolean>{
    return Boolean((await c.query(`SELECT 1 FROM public.wechat_binding_history_authorization
      WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 AND version=1`,[this.options.ownerId,b.contact_id,b.binding_id])).rowCount);
  }
  /** 本轮若不需要读取历史则返回空；此前已完成但因范围复验降级的任务保留完成时间。 */
  async prepareHistory(b:IncrementalBinding,check:()=>void=current):Promise<HistoryPreparation|null>{
    return this.transaction(check,async c=>{
      await this.lock(c,b,true);
      if(!await this.requireHistoryAuthorization(c,b))return null;
      let row=(await c.query(`SELECT ${historyColumns} FROM public.cli_history_sync_state
        WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 FOR UPDATE`,[this.options.ownerId,b.contact_id,b.binding_id])).rows[0];
      if(!row)fail('history_state_missing');
      if(row.phase==='complete')return null;
      if(row.phase==='incomplete'&&row.completed_at!==null)return {state:projectHistory(row),position_token:await this.token(c,b)};
      if(row.phase!=='syncing'||row.failure_code!==null){
        row=(await c.query(`UPDATE public.cli_history_sync_state SET phase='syncing',failure_code=NULL,completed_at=NULL,updated_at=now()
          WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 RETURNING ${historyColumns}`,
          [this.options.ownerId,b.contact_id,b.binding_id])).rows[0];
      }
      return {state:projectHistory(row),position_token:await this.token(c,b)};
    });
  }
  async restoreHistoryCompletion(b:IncrementalBinding,check:()=>void=current):Promise<void>{
    return this.transaction(check,async c=>{
      await this.lock(c,b,true);
      if(!await this.requireHistoryAuthorization(c,b))fail('history_authorization_required');
      const row=(await c.query(`UPDATE public.cli_history_sync_state SET phase='complete',failure_code=NULL,updated_at=now()
        WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 AND completed_at IS NOT NULL RETURNING binding_id`,
        [this.options.ownerId,b.contact_id,b.binding_id])).rowCount;
      if(!row)fail('history_state_changed');
    });
  }
  async markHistoryIncomplete(b:IncrementalBinding,code:string,preserveCompletion:boolean,check:()=>void=current):Promise<void>{
    if(!/^[a-z][a-z0-9_]{0,95}$/.test(code))code='history_sync_failed';
    await this.transaction(check,async c=>{
      await this.lock(c,b,true);
      if(!await this.requireHistoryAuthorization(c,b))return;
      await c.query(`UPDATE public.cli_history_sync_state SET phase='incomplete',failure_code=$4,
        completed_at=CASE WHEN $5 THEN completed_at ELSE NULL END,updated_at=now()
        WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 AND (phase<>'complete' OR $5)`,
        [this.options.ownerId,b.contact_id,b.binding_id,code,preserveCompletion]);
    });
  }
  /** 缺失任务按 active 绑定投影为 not_started，不创建任务或读取正文。 */
  async historyCoverages(bindings:readonly IncrementalBinding[],check:()=>void=current):Promise<HistoryCoverage[]>{
    return this.transaction(check,async c=>{
      await this.account(c);
      const states=(await c.query(`SELECT h.binding_id,h.contact_id,h.phase,h.failure_code,h.message_count,
        h.non_text_count,h.page_count,h.last_local_id,h.last_cursor,h.watermark_at,h.started_at,h.completed_at,h.updated_at
        FROM public.cli_history_sync_state h
        JOIN public.conversation_binding b ON b.owner_id=h.owner_id AND b.contact_id=h.contact_id AND b.id=h.binding_id
        WHERE h.owner_id=$1 AND b.channel='wechat' AND b.account_scope=$2 AND b.status='active'`,
        [this.options.ownerId,this.options.accountScope])).rows.map(projectHistory);
      const byBinding=new Map(states.map(state=>[state.binding_id,state]));
      return bindings.map(binding=>byBinding.get(binding.binding_id)??{
        binding_id:binding.binding_id,contact_id:binding.contact_id,phase:'not_started' as const,failure_code:null,
        message_count:0,non_text_count:0,page_count:0,last_local_id:null,last_cursor:null,
        watermark_at:null,started_at:null,completed_at:null,updated_at:null,
      });
    });
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
    // 在 PG 内取整，避免 timestamp 微秒先被 JS Date 截断成毫秒；UTC 不受回拨影响。
    const baseline=(await c.query(`SELECT baseline_at,CASE
      WHEN baseline_at=date_trunc('second',baseline_at,'UTC') THEN baseline_at
      ELSE date_trunc('second',baseline_at,'UTC')+interval '1 second'
      END AS query_since_at FROM public.wechat_observation_baseline
      WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 AND conversation_locator=$4`,[this.options.ownerId,b.contact_id,b.binding_id,b.conversation_locator])).rows[0];
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
    return {baseline_at:baseline.baseline_at.toISOString(),query_since_at:baseline.query_since_at.toISOString(),cursor:cursor?{last_local_id:String(cursor.last_local_id),last_cursor:cursor.last_cursor}:null,history_busy:busy,position_token:await this.token(c,b)};
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
  private validateObservation(input:IncrementalSave):void {
    const {binding:b,page,messages}=input;
    if(!positive(page.last_local_id)||!page.cursor?.trim()||!input.cli_version.trim()||!page.freshness_confirmed||page.local_history_state||!input.position_token||
      input.since_local_id!==null&&!positive(input.since_local_id)||input.since_cursor!==null&&!input.since_cursor.trim()||
      !Number.isSafeInteger(page.event_count)||page.event_count<messages.length||!Number.isSafeInteger(page.non_text_count)||page.non_text_count<0||page.non_text_count>page.event_count||
      messages.some(m=>m.wechat_metadata.external_talker!==b.conversation_locator||!positive(m.wechat_metadata.external_local_id)))fail('observation_invalid');
  }
  private async saveBatch(input:IncrementalSave,mode:'cli_background'|'cli_history',history:HistoryState|null,check:()=>void):Promise<IncrementalSaved>{
    this.validateObservation(input);
    const {binding:b,page,messages}=input;
    return this.transaction(check,async c=>{
      await this.lock(c,b);
      if(history){
        if(!await this.requireHistoryAuthorization(c,b))fail('history_authorization_required');
        const state=(await c.query(`SELECT ${historyColumns} FROM public.cli_history_sync_state
          WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 FOR UPDATE`,
          [this.options.ownerId,b.contact_id,b.binding_id])).rows[0];
        if(!state||state.phase==='complete'||String(state.last_local_id??'')!==(history.last_local_id??'')||
          (state.last_cursor??null)!==history.last_cursor)fail('history_state_changed');
      }else if(await this.historyBusy(c,b))fail('sync_history_busy');
      const filtered=await filterAutoRead(c,this.options.ownerId,b.contact_id,messages,input.processing_records??[...messages.map(m=>m.processing_record),...page.filtered_records]);
      const args=[this.options.ownerId,b.contact_id,b.binding_id,input.cli_version,b.conversation_locator,input.since_local_id,page.last_local_id,input.since_cursor,page.cursor,filtered.messages.length,page.event_count,page.non_text_count];
      const existing=(await c.query(`SELECT id FROM public.local_wechat_observation WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 AND mode=$4 AND COALESCE(since_local_id,0)=COALESCE($5::bigint,0) AND last_local_id=$6 AND COALESCE(since_cursor,'')=COALESCE($7,'') AND last_cursor=$8`,
        [...args.slice(0,3),mode,input.since_local_id,page.last_local_id,input.since_cursor,page.cursor])).rows[0];
      if(!existing&&await this.token(c,b)!==input.position_token)fail('observation_position_stale');
      let observationId:string;
      if(existing){
        observationId=existing.id;
        if(!history)await c.query('UPDATE public.local_wechat_observation SET event_count=$2,non_text_count=$3,is_reliable=true WHERE id=$1',[observationId,page.event_count,page.non_text_count]);
      }
      else{
        let historyCursorAdvance=false;
        if(history){
          let current=(await c.query(`SELECT conversation_locator,last_local_id FROM public.wechat_observation_cursor
            WHERE owner_id=$1 AND contact_id=$2 FOR UPDATE`,[this.options.ownerId,b.contact_id])).rows[0];
          if(!current)current=(await c.query(`SELECT conversation_locator,last_local_id FROM public.local_wechat_observation
            WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 AND is_reliable
            ORDER BY commit_order DESC NULLS LAST,read_at DESC,id DESC LIMIT 1`,args.slice(0,3))).rows[0];
          // 完成页只在确实前移时成为可靠增量水位；已有更靠前的游标不回退。
          historyCursorAdvance=!current||current.conversation_locator!==b.conversation_locator||BigInt(current.last_local_id)<=BigInt(page.last_local_id!);
        }else{
          let position=(await c.query('SELECT conversation_locator,last_cursor FROM public.wechat_observation_cursor WHERE owner_id=$1 AND contact_id=$2 FOR UPDATE',[this.options.ownerId,b.contact_id])).rows[0];
          if(!position)position=(await c.query(`SELECT conversation_locator,last_cursor FROM public.local_wechat_observation WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 AND is_reliable ORDER BY commit_order DESC NULLS LAST,read_at DESC,id DESC LIMIT 1`,args.slice(0,3))).rows[0];
          if(position&&position.conversation_locator!==b.conversation_locator||(position?.last_cursor??null)!==input.since_cursor)fail('observation_position_stale');
        }
        observationId=randomUUID();
        const reliable=!history||(!page.has_more&&historyCursorAdvance);
        await c.query(`INSERT INTO public.local_wechat_observation(owner_id,contact_id,binding_id,cli_version,conversation_locator,since_local_id,last_local_id,since_cursor,last_cursor,record_count,event_count,non_text_count,mode,is_reliable,id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [...args,mode,reliable,observationId]);
        if(!history)await this.putCursor(c,b,page.last_local_id!,page.cursor!);
        else if(!page.has_more&&historyCursorAdvance)await this.putCursor(c,b,page.last_local_id!,page.cursor!);
      }
      const written=await saveIncrementalMessages(c,this.options.ownerId,b.contact_id,observationId,filtered.messages);
      const records=[...filtered.records];
      const position=(r:IncrementalProcessingRecord):number=>{const p=(parseJson(r.payload_json) as Record<string,unknown>).input_position;return typeof p==='number'&&Number.isFinite(p)?p:0;};
      records.sort((a,b)=>position(a)-position(b));
      await saveIncrementalProcessing(c,this.options.ownerId,b.contact_id,observationId,records,written.receipts);
      if(history&&!existing){
        const complete=!page.has_more;
        if(!(await c.query(`UPDATE public.cli_history_sync_state SET phase=$4,message_count=message_count+$5,
          non_text_count=non_text_count+$6,page_count=page_count+1,last_local_id=$7,last_cursor=$8,
          failure_code=NULL,completed_at=CASE WHEN $4='complete' THEN now() ELSE NULL END,updated_at=now()
          WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 RETURNING binding_id`,
          [this.options.ownerId,b.contact_id,b.binding_id,complete?'complete':'syncing',filtered.messages.length,page.non_text_count,page.last_local_id,page.cursor])).rowCount)fail('history_state_changed');
      }
      const kept=new Set(filtered.messages);let writeIndex=0;
      check();return {observation_id:observationId,message_ids:written.ids,created_message_ids:existing?[]:messages.map(m=>kept.has(m)?written.created[writeIndex++]:null),source_created:!existing,accepted_message_count:filtered.messages.length};
    });
  }
  save(input:IncrementalSave,check:()=>void=current):Promise<IncrementalSaved>{
    return this.saveBatch(input,'cli_background',null,check);
  }
  saveHistoryPage(input:HistoryPageSave,check:()=>void=current):Promise<IncrementalSaved>{
    return this.saveBatch(input,'cli_history',input.history,check);
  }
}
