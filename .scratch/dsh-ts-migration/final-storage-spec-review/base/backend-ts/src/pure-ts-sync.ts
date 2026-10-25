/** TS 增量引擎的应用寿命与原公开状态投影，不另建同步写者。 */
import type {HostStorage} from './host-storage.ts';
import {HostStorageError} from './host-storage.ts';
import {PostgresWechatSetupStore,WechatSetupConflict} from './wechat-setup.ts';
import type {createSyncIncrementalApi} from './sync-incremental-api.ts';
import {projectHistoryCoverages} from './history-runtime.ts';
import type {PureTsEvents} from './pure-ts-events.ts';
type Incremental=Awaited<ReturnType<typeof createSyncIncrementalApi>>;
type Row=Record<string,any>;
export class PureTsSync {
 readonly accountScope:string|null;
 private readonly storage:HostStorage;
 private readonly incremental:Incremental;
 private readonly events:PureTsEvents;
 private stopped=false;
 private active=false;
 private timer:NodeJS.Timeout|undefined;
 private readonly controller=new AbortController();
 private pending:Promise<void>|undefined;
 private lastStatus:string|undefined;
 private constructor(storage:HostStorage,incremental:Incremental,events:PureTsEvents,account:string|null){this.storage=storage;this.incremental=incremental;this.events=events;this.accountScope=account;}
 static async create(storage:HostStorage,incremental:Incremental,events:PureTsEvents){
  let account:string|null=null;
  try{account=storage.runtimeOwnerId?await new PostgresWechatSetupStore(storage).read(storage.runtimeOwnerId):null;}
  catch(error){if(!(error instanceof WechatSetupConflict))throw error;}
  return new PureTsSync(storage,incremental,events,account);
 }
 private assertCurrent=()=>{if(this.stopped)throw new HostStorageError('runtime_stopping');};
 private async execute(command:string,body:Row={},signal:AbortSignal=this.controller.signal){
  this.assertCurrent();
  if(!this.accountScope||!this.storage.runtimeOwnerId)return {status:503,body:{error:'sync_unavailable'}};
  return this.incremental.execute('POST',`/api/runtime/sync-incremental/${command}`,
   {owner_id:this.storage.runtimeOwnerId,channel:'wechat',account_scope:this.accountScope,...body},this.assertCurrent,signal);
 }
 async status():Promise<Row>{
  this.assertCurrent();
  let raw:Row;
  if(this.accountScope)raw=await this.incremental.status(this.assertCurrent);
  else raw={enabled:false,phase:'disabled',bound_count:0};
  const enabled=raw.enabled===true;
  const result:Row={sync_enabled:enabled,sync_mode:'cli_background',sync_scope:'selected',sync_scope_failure_code:raw.sync_scope_failure_code??null,
   phase:enabled?'waiting_foreground':'sync_disabled',probe_available:false,wechat_in_front:false,cli_available:raw.cli_available===true,
   failure_code:null,active_contact_id:null,active_binding_display_name:null,decision_reason:null,batch_message_count:0,candidates:[],
   foreground_phase:enabled?'waiting_foreground':'sync_disabled',foreground_failure_code:null,
   cli_sync_phase:raw.phase??(enabled?'waiting_bindings':'disabled'),cli_sync_mode:raw.stream_mode??'bounded_polling',cli_stream_active:raw.stream_active===true,
   cli_bound_count:raw.bound_count??0,cli_pending_count:raw.pending_count??0,cli_batch_message_count:raw.batch_message_count??0,cli_failure_code:raw.failure_code??null,
   cli_history_coverages:projectHistoryCoverages(raw.history_coverages??[]),
   cli_history_authorization_state:'unknown',cli_history_authorization_version:null,cli_history_authorization_current_version:1};
  for(const key of ['priority_contact_id','priority_last_success_at','priority_last_duration_ms','priority_last_cli_duration_ms','priority_last_store_duration_ms','priority_last_failure_code','priority_local_history_state','priority_queue_wait_ms'])result[`cli_${key}`]=raw[key]??null;
  result.cli_backfill_phase=raw.backfill_phase??'not_required';
  for(const key of ['contact_id','last_cursor','failure_code'])result[`cli_backfill_${key}`]=raw[`backfill_${key}`]??null;
  for(const key of ['message_count','non_text_count','total_contacts','completed_contacts','succeeded_contacts','skipped_contacts','failed_contacts','incomplete_contacts','pending_contacts','total_message_count','total_non_text_count'])result[`cli_backfill_${key}`]=raw[`backfill_${key}`]??0;
  return result;
 }
 async start(){
  this.assertCurrent();if(this.active)return;this.active=true;
  if(!this.accountScope)return;
  await this.execute('follow-enable');
  const tick=()=>{
   if(this.stopped||!this.active)return;
   const work=(async()=>{await this.execute('cycle');await this.publishStatus();})().catch(()=>{}).finally(()=>{
    if(this.pending===work)this.pending=undefined;
    if(!this.stopped&&this.active){this.timer=setTimeout(tick,3000);this.timer.unref();}
   });this.pending=work;
  };
  this.timer=setTimeout(tick,0);this.timer.unref();
 }
 private async publishStatus(){
  const report=await this.status(),key=JSON.stringify([report.sync_enabled,report.cli_sync_phase,report.cli_failure_code]);
  if(this.lastStatus===key)return;this.lastStatus=key;
  if(!this.storage.runtimeOwnerId)return;
  const contacts=await this.storage.businessReadTransaction(async client=>(await client.query("SELECT DISTINCT contact_id FROM conversation_binding WHERE owner_id=$1 AND status='active'",[this.storage.runtimeOwnerId])).rows);
  this.assertCurrent();for(const row of contacts)this.events.publish('sync.status_changed',row.contact_id,{phase:report.cli_sync_phase,sync_enabled:report.sync_enabled,failure_code:report.cli_failure_code});
 }
 async handle(method:string,url:URL,body:unknown,signal:AbortSignal):Promise<{status:number;body:unknown}|undefined>{
  const command=new Map([['/api/sync/enable','enable'],['/api/sync/disable','disable'],['/api/sync/check','check'],['/api/sync/priority','priority'],['/api/sync/backfill/pause','pause'],['/api/sync/backfill/retry','retry']]).get(url.pathname);
  if(url.pathname==='/api/sync/status')return method==='GET'?{status:200,body:await this.status()}:{status:404,body:{error:'not_found'}};
  if(!command)return;
  if(method!=='POST')return {status:404,body:{error:'not_found'}};
  if(url.search||!body||typeof body!=='object'||Array.isArray(body))return {status:400,body:{error:'sync_request_invalid'}};
  const value=body as Row;
  if(command==='priority'){
   if(Object.keys(value).join(',')!=='contact_id'||value.contact_id!==null&&(typeof value.contact_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.contact_id)))return {status:400,body:{error:'sync_priority_request_invalid'}};
  }else if(Object.keys(value).length)return {status:400,body:{error:'sync_request_invalid'}};
  const result=await this.execute(command,command==='priority'?{priority_contact_id:value.contact_id}:{},signal);
  if(result.status!==200)return result;
  if(command==='check'||command==='retry'){const checked=await this.execute('cycle',{},signal);if(checked.status!==200)return checked;}
  await this.publishStatus();return {status:200,body:await this.status()};
 }
 async follow(command:'status'|'enable'|'disable'|'interrupt',signal?:AbortSignal){
  const result=await this.execute(`follow-${command}`,{},signal);
  if(result.status!==200)return result;
  if(command!=='status')await this.execute('cycle',{},signal);
  return result;
 }
 async close(){this.stopped=true;this.active=false;this.controller.abort();clearTimeout(this.timer);await this.incremental.invalidateAndDrain('shutdown');await this.pending;}
}
