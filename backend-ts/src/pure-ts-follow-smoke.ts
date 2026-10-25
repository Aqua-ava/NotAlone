/** 原 follow 人工验证控制面；只保留本机内存元数据，不收集消息正文。 */
import type {HostStorage} from './host-storage.ts';
import type {PureTsSync} from './pure-ts-sync.ts';
type Row=Record<string,any>;
const labels=new Set(['baseline','before_follow','after_live_message','after_idle','after_follow_restart','wechat_background','after_reenable','final']);
export class PureTsFollowSmoke {
 private readonly storage:HostStorage;
 private readonly sync:PureTsSync;
 private active=false;
 private checkpoints:Row[]=[];
 constructor(storage:HostStorage,sync:PureTsSync){this.storage=storage;this.sync=sync;}
 private contacts(){
  return this.storage.businessReadTransaction(async client=>(await client.query(`SELECT c.id AS contact_id,
    EXISTS(SELECT 1 FROM conversation_binding b WHERE b.owner_id=c.owner_id AND b.contact_id=c.id AND b.channel='wechat' AND b.status='active') AS bound,
    (SELECT count(*)::int FROM message m WHERE m.owner_id=c.owner_id AND m.contact_id=c.id) AS message_count,
    (SELECT count(*)::int FROM message_source_ref ref WHERE ref.owner_id=c.owner_id AND ref.contact_id=c.id AND ref.source_kind='local_wechat_observation') AS observation_ref_count,
    (SELECT cur.last_local_id::text FROM wechat_observation_cursor cur WHERE cur.owner_id=c.owner_id AND cur.contact_id=c.id) AS watermark,
    coalesce((SELECT obs.mode FROM local_wechat_observation obs WHERE obs.owner_id=c.owner_id AND obs.contact_id=c.id ORDER BY obs.read_at DESC LIMIT 1),'none') AS latest_mode,
    (SELECT count(*)::int FROM(SELECT metadata.external_local_id,coalesce(metadata.source_create_time,-1) FROM wechat_message_metadata metadata WHERE metadata.owner_id=c.owner_id AND metadata.contact_id=c.id GROUP BY metadata.external_local_id,coalesce(metadata.source_create_time,-1) HAVING count(*)>1) duplicates) AS duplicate_identities
    FROM contact c WHERE c.owner_id=$1 ORDER BY c.id`,[this.storage.runtimeOwnerId])).rows.map(row=>({...row,watermark:row.watermark===null?null:BigInt(row.watermark)})));
 }
 private async status(){
  const report=await this.sync.status(),follow=await this.sync.follow('status'),runtime=follow.status===200?follow.body as Row:{};
  return {active:this.active,follow_enabled:runtime.enabled===true,follow_stream_active:runtime.stream_active===true,follow_process_id:runtime.process_id??null,follow_mode:runtime.mode??'bounded_polling',follow_watermark:runtime.watermark??null,
   sync_enabled:report.sync_enabled,phase:report.phase,probe_available:report.probe_available,wechat_in_front:report.wechat_in_front,cli_available:report.cli_available,failure_code:report.failure_code,active_contact_id:report.active_contact_id,active_binding_display_name:report.active_binding_display_name,batch_message_count:report.batch_message_count,
   last_valid_observation:null,contacts:await this.contacts(),checkpoints:this.checkpoints};
 }
 async handle(method:string,url:URL,body:unknown,signal:AbortSignal){
  if(!url.pathname.startsWith('/api/sync/follow-smoke/'))return;
  const action=url.pathname.slice('/api/sync/follow-smoke/'.length);
  if(!['status','start','stop','interrupt','checkpoint'].includes(action)||method!==(action==='status'?'GET':'POST'))return {status:404,body:{error:'not_found'}};
  if(!this.storage.runtimeOwnerId)return {status:503,body:{error:'owner_uninitialized'}};
  const rejected=(reason:string)=>({status:409,body:{error:'follow_smoke_rejected',reason}});
  try{
   if(action==='status')return {status:200,body:await this.status()};
   if(action==='start'){
    if(this.active)return rejected('already_active');if(!(await this.sync.status()).sync_enabled)return rejected('sync_disabled');
    const result=await this.sync.follow('enable',signal);if(result.status!==200)return {status:503,body:{error:'follow_smoke_failed'}};
    this.checkpoints=[];this.active=true;
   }else if(action==='stop'){
    if(this.active)await this.sync.follow('disable',signal);this.active=false;
   }else if(action==='interrupt'){
    if(!this.active)return rejected('not_active');
    const current=await this.sync.follow('status',signal);
    if(current.status!==200||!(current.body as Row).stream_active)return rejected('follow_stream_not_active');
    const result=await this.sync.follow('interrupt',signal);if(result.status!==200)return {status:503,body:{error:'follow_smoke_failed'}};
   }else{
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).join(',')!=='label'||!labels.has((body as Row).label))return {status:400,body:{error:'follow_smoke_request_invalid'}};
    if(!this.active)return rejected('not_active');
    this.checkpoints.push({label:(body as Row).label,recorded_at:new Date().toISOString(),contacts:await this.contacts()});
   }
   signal.throwIfAborted();return {status:200,body:await this.status()};
  }catch{return {status:503,body:{error:'follow_smoke_failed'}};}
 }
 close(){this.active=false;this.checkpoints=[];}
}
