import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import { readWechatHttpBody, WechatHttpBodyError } from '../../sync/wechat-http-body.ts';
import type { SqliteContactService } from './service.ts';
import type { ContactSelection } from './contracts.ts';
function object(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw new StorageFailure('identity_request_invalid');return v as Record<string,unknown>;}
function exact(v:Record<string,unknown>,keys:string[]){if(Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw new StorageFailure('identity_request_invalid');}
const result=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v));};
const setup=(state:string,account:string|null=null,token:string|null=null,code:string|null=null)=>({state,account_id:account,candidate_token:token,failure_code:code});
// 只返回固定诊断码，底层错误文本可能包含本机路径或账号资料。
const detectionFailures = new Set(['wechat_tool_unavailable', 'history_artifact_manifest_missing', 'history_artifact_unverified',
 'history_account_unavailable', 'history_program_version_uncertified', 'history_program_version_unavailable',
 'history_metadata_profile_unverified', 'metadata_identity_unverified', 'metadata_identity_conflict',
 'history_native_unavailable', 'history_native_timeout', 'history_protocol_invalid', 'history_source_unverified', 'history_source_changed', 'history_scope_changed']);
/** 必须由宿主先执行唯一 Bearer/Origin 认证；不接收 owner、SQL 或适配器配置。 */
export class SqliteContactHttp {
 private readonly service:SqliteContactService;
 private readonly manualContext=randomUUID();
 constructor(service:SqliteContactService){this.service=service;}
 async syncStatus(){
  const directory=await this.service.syncDirectory();
  return {identity_protocol:'sqlite-selected-v1',body_available:false,sync_mode:'cli_background',sync_enabled:directory.read_enabled,sync_scope:'selected',sync_scope_failure_code:null,
   cli_available:false,probe_available:false,wechat_in_front:false,cli_sync_phase:directory.read_enabled?'degraded':'disabled',
   foreground_phase:directory.read_enabled?'unavailable':'sync_disabled',cli_failure_code:'wechat_body_unavailable',foreground_failure_code:null,
   cli_bound_count:directory.bindings.filter(b=>b.status==='active').length,
   cli_backfill_phase:'not_required',cli_backfill_failure_code:null,cli_backfill_total_contacts:0,cli_backfill_completed_contacts:0,
   cli_backfill_succeeded_contacts:0,cli_backfill_skipped_contacts:0,cli_backfill_failed_contacts:0,cli_backfill_incomplete_contacts:0,
   cli_backfill_pending_contacts:0,cli_backfill_total_message_count:0,cli_backfill_total_non_text_count:0,
   cli_history_coverages:directory.bindings.filter(b=>b.status==='active').map(b=>({binding_id:b.binding_id,contact_id:b.contact_id,phase:'not_started',failure_code:'wechat_body_unavailable',message_count:0,non_text_count:0,page_count:0}))};
 }
 async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const path=req.url??'';
  const methods=new Map([['/api/setup/status','GET'],['/api/contacts','GET'],['/api/setup/wechat','GET'],['/api/setup/wechat/detect','POST'],['/api/setup/wechat/confirm','POST'],['/api/sync/cli-bindings','GET'],['/api/sync/cli-sessions','GET'],['/api/sync/cli-bindings/confirm','POST'],['/api/sync/cli-bindings/revoke','POST'],['/api/sync/status','GET'],['/api/sync/enable','POST'],['/api/sync/disable','POST']]);
  const manual=/^\/api\/contacts\/([a-f0-9-]{36})\/manual-confirmation$/.exec(path);
  const avatar=/^\/api\/contacts\/([a-f0-9-]{36})\/avatar$/.exec(path);
  if(manual)methods.set(path,'POST');
  if(avatar)methods.set(path,'GET');
  if(!methods.has(path))return false;
  if(methods.get(path)!==req.method){result(res,405,{error:'method_not_allowed'});return true;}
  const controller=new AbortController();const abort=()=>controller.abort();req.once('aborted',abort);
  try{
   let body:Record<string,unknown>={};
   if(req.method==='POST')body=object(JSON.parse((await readWechatHttpBody(req,1024*1024,10_000)).toString('utf8')||'{}'));
   let value:unknown;
   if(manual){exact(body,[]);const contact=(await this.service.directory()).contacts.find(c=>c.contact_id===manual[1]);if(!contact)throw new StorageFailure('identity_not_found');value={confirmed:true,manual_confirmation_id:await this.service.manualConfirm(manual[1],`${this.manualContext}:${manual[1]}:${contact.data_generation}`)};}
   else if(path==='/api/setup/status')value={runtime_owner_configured:true,owner_id:this.service.ownerId,storage:'sqlite',capabilities:['contacts']};
   else if(path==='/api/contacts')value={contacts:(await this.service.directory()).contacts};
   else if(avatar)value={avatar:await this.service.avatar(avatar[1],controller.signal)};
   else if(path==='/api/setup/wechat'){const d=await this.service.directory();value=d.account?setup('connected',d.account.external_key):setup('needs_detection');}
   else if(path.endsWith('/wechat/detect')){
    exact(body,[]);
    try{const c=await this.service.detectAccount(controller.signal);value=c.verified?{...setup('ready',c.account_id,c.candidate_token),...(c.source_reconfirmation_required?{source_reconfirmation_required:true}:{})}:setup('tool_not_ready',c.account_id,null,c.failure_code&&detectionFailures.has(c.failure_code)?c.failure_code:'metadata_identity_unverified');}
    catch(error){
     const code=error instanceof StorageFailure&&detectionFailures.has(error.code)?error.code:'wechat_detection_failed';
     value=setup(code==='wechat_tool_unavailable'?'tool_unavailable':'tool_not_ready',null,null,code);
    }
   }else if(path.endsWith('/wechat/confirm')){
    const reconfirmed=Object.hasOwn(body,'source_reconfirmed');
    exact(body,['candidate_token','confirmed','mode','history_authorized',...(reconfirmed?['source_reconfirmed']:[])]);
    if(reconfirmed&&(body.source_reconfirmed!==true||body.history_authorized!==false))throw new StorageFailure('identity_request_invalid');
    if(body.confirmed!==true||body.mode!=='selected'||typeof body.history_authorized!=='boolean'||typeof body.candidate_token!=='string')throw new StorageFailure('identity_request_invalid');
    await this.service.confirmAccount(body.candidate_token,controller.signal,reconfirmed);const d=await this.service.directory();value=setup('connected',d.account!.external_key);
   }else if(path==='/api/sync/cli-bindings'){
    const d=await this.service.syncDirectory();value={identity_protocol:'sqlite-selected-v1',sync_enabled:d.read_enabled,bindings:d.bindings.filter(b=>b.status==='active'),revoked_bindings:d.bindings.filter(b=>b.status==='revoked')};
   }else if(path==='/api/sync/cli-sessions'){
    // 此请求只由用户明确同意的刷新操作发出；普通状态/重开不调用它。
    if(req.headers['x-notalone-metadata-consent']!=='selected-list')throw new StorageFailure('metadata_consent_required');
    value=await this.service.candidates(true,controller.signal);
   }else if(path.endsWith('/cli-bindings/confirm')){
    exact(body,['snapshot_token','selections','history_authorized']);
    if(typeof body.snapshot_token!=='string'||body.history_authorized!==true||!Array.isArray(body.selections))throw new StorageFailure('identity_request_invalid');
    const choices=body.selections.map(raw=>{const row=object(raw);if(Object.keys(row).some(k=>!['locator','contact_id','display_name','observed_display_name','expected_selection_generation'].includes(k))||typeof row.locator!=='string'||typeof row.observed_display_name!=='string'||typeof row.expected_selection_generation!=='string'||row.contact_id!==undefined&&typeof row.contact_id!=='string')throw new StorageFailure('identity_request_invalid');return row as unknown as ContactSelection;});
    await this.service.confirm(body.snapshot_token,choices,controller.signal);value=await this.syncStatus();
   }else if(path.endsWith('/cli-bindings/revoke')){
    exact(body,['contact_id','binding_id','expected_selection_generation']);
    if(typeof body.contact_id!=='string'||typeof body.binding_id!=='string'||typeof body.expected_selection_generation!=='string')throw new StorageFailure('identity_request_invalid');
    await this.service.revoke(body.contact_id,body.binding_id,body.expected_selection_generation);
    value=(await this.service.directory()).bindings.find(b=>b.binding_id===body.binding_id&&b.contact_id===body.contact_id);
   }else if(path==='/api/sync/status')value=await this.syncStatus();
   else{exact(body,[]);await this.service.setReading(path.endsWith('/enable'));value=await this.syncStatus();}
   result(res,200,value);
  }catch(error){
   const code=error instanceof StorageFailure?error.code:error instanceof WechatHttpBodyError?error.code:'identity_request_failed';
   const status=error instanceof WechatHttpBodyError?error.status:code==='identity_request_invalid'?400:/unavailable|unverified|not_authorized/.test(code)?503:409;
   result(res,status,{error:code});
  }finally{req.removeListener('aborted',abort);}
  return true;
 }
}
