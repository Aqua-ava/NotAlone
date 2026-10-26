/** 仅宿主认证的Python薄桥入口；公开请求不能声明已验证范围或续写权限。 */
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Client} from 'pg';
import {timingSafeEqual} from 'node:crypto';
import {parseJson,stringifyJson} from '../../host/host-json.ts';
import {readWechatHttpBody,WechatHttpBodyError} from '../../sync/wechat-http-body.ts';
import {ReplyError,record,parseReplyRequest} from './reply-contract.ts';
import type {VerifiedReplyScope} from './reply-scope.ts';
import type {ReplyInternalContext} from './reply-service.ts';
export interface ReplyHttpService {
 prepare(scope:VerifiedReplyScope,body:unknown,signal:AbortSignal,internal?:ReplyInternalContext):Promise<unknown>;
 generate(scope:VerifiedReplyScope,body:unknown,signal:AbortSignal,internal?:ReplyInternalContext):Promise<unknown>;
}
export interface ReplyHttpOptions {
 ownerId?:string;token:string;
 /** 明确未配置时，认证后在正文/DB/预算之前拒绝。 */
 available?:boolean;
 read<T>(work:(client:Client)=>Promise<T>):Promise<T>;
 service:ReplyHttpService;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid=():never=>{throw new ReplyError('reply_request_invalid',400);};
function exact(value:unknown,required:string[],optional:string[]=[]):value is Record<string,any>{return record(value)&&required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k));}
const scopeKeys=['owner_id','contact_id','conversation_binding_id'];
function envelope(value:unknown,owner:string){
 if(!exact(value,['verified_scope','request','internal'])||!exact(value.verified_scope,scopeKeys)||scopeKeys.some(k=>typeof value.verified_scope[k]!=='string'||!uuid.test(value.verified_scope[k]))||value.verified_scope.owner_id!==owner)return invalid();
 if(!exact(value.request,['contact_id','idempotency_key','content'],['continued_from_candidate_id','skill_version_id','skill_disabled','scene','allow_incomplete_history','suggestion','expected_input_version_id'])||value.request.contact_id!==value.verified_scope.contact_id)return invalid();
 if(!exact(value.internal,[],['authenticatedContinuation']))return invalid();
 if(value.internal.authenticatedContinuation!==undefined){
  const auth=value.internal.authenticatedContinuation;
  if(!exact(auth,['continuation','continuation_reference'])||!record(auth.continuation))return invalid();
  const ref=auth.continuation_reference;
  if(ref!==null){
   if(!exact(ref,['candidate_id','version_id','messages'])||![ref.candidate_id,ref.version_id].every(id=>typeof id==='string'&&uuid.test(id))||!Array.isArray(ref.messages)||ref.messages.length<1||ref.messages.length>8)return invalid();
   if(ref.candidate_id!==value.request.continued_from_candidate_id||ref.messages.some((m:unknown)=>!exact(m,['message_id','text'])||typeof m.message_id!=='string'||!uuid.test(m.message_id)||typeof m.text!=='string'||!m.text.trim())||new Set(ref.messages.map((m:any)=>m.message_id)).size!==ref.messages.length)return invalid();
  }
 }
 parseReplyRequest(value.request,value.internal.authenticatedContinuation);
 return value;
}
const knownErrors=new Set(['reply_deletion_pending','reply_request_invalid','reply_input_invalidated','reply_input_conflict','reply_in_progress','reply_continuation_invalid','expression_preferences_changed','reply_candidates_rejected','reply_review_invalid','reply_timeout','reply_budget_exceeded','reply_budget_unavailable','reply_generation_failed','reply_context_invalidated','reply_context_unavailable','reply_not_found','reply_rejected','input_budget_exceeded','input_budget_unavailable','exploration_stale','exploration_expired','reply_cancelled','runtime_stopping','provider_context_limit','reply_persistence_unavailable']);
const knownReasons=new Set(['resume_required','output_missing','output_schema_invalid','output_candidates_invalid','scope_mismatch','no_active_binding','manual_contact_unconfirmed','invalid_verification','history_sync_pending','history_incomplete_confirmation_required']);
/** 不回传任意Error字段/堆栈；输入预算必须是既有公开纯元数据。 */
function errorBody(error:unknown):{status:number;body:Record<string,unknown>}{
 if(error instanceof WechatHttpBodyError)return {status:error.status,body:{error:error.code}};
 if(!(error instanceof ReplyError)||!knownErrors.has(error.code))return {status:503,body:{error:'reply_remote_unavailable'}};
 const body:Record<string,unknown>={error:error.code},e=error as ReplyError&{reason?:unknown;input_budget?:unknown};
 if(e.code==='reply_rejected'&&(typeof e.reason!=='string'||!knownReasons.has(e.reason)))return {status:503,body:{error:'reply_remote_unavailable'}};
 if(e.reason!==undefined&&typeof e.reason==='string'&&knownReasons.has(e.reason))body.reason=e.reason;
 if(e.input_budget!==undefined){
  const b=e.input_budget;
  if(!exact(b,['state','allowed','model_id','context_window_tokens','input_tokens','output_reserve_tokens','total_tokens','measurement_kind','measurement_id','reason'],['safety_margin_tokens']))return {status:503,body:{error:'reply_remote_unavailable'}};
  // 这里只转发原预算DTO；不把内部provider预算请求或正文展开成响应。
  if(!['ready','warning','exceeded','unavailable'].includes(b.state)||typeof b.allowed!=='boolean'||typeof b.model_id!=='string'||typeof b.measurement_id!=='string'&&b.measurement_id!==null||typeof b.reason!=='string'&&b.reason!==null||b.measurement_kind!==null&&!['approximate','exact','verified_upper_bound'].includes(b.measurement_kind)||['context_window_tokens','input_tokens','output_reserve_tokens','total_tokens','safety_margin_tokens'].some(k=>b[k]!==undefined&&b[k]!==null&&(!Number.isSafeInteger(b[k])||b[k]<0)))return {status:503,body:{error:'reply_remote_unavailable'}};
  body.input_budget=b;
 }
 return {status:Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:503,body};
}
export function createReplyHttp(options:ReplyHttpOptions){
 if((options.ownerId!==undefined&&!uuid.test(options.ownerId))||(options.available!==false&&!options.ownerId)||(options.available!==undefined&&typeof options.available!=='boolean')||typeof options.token!=='string'||options.token.length<32||!/^[\x21-\x7e]+$/.test(options.token)||typeof options.read!=='function'||typeof options.service?.prepare!=='function'||typeof options.service?.generate!=='function')throw new Error('reply_http_config_invalid');
 const expected=Buffer.from(`Bearer ${options.token}`),owner=options.ownerId;
 return {async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  if(!(req.url??'').startsWith('/internal/reply'))return false;
  const respond=(status:number,body:unknown)=>{if(res.destroyed||res.writableEnded)return;const encoded=stringifyJson(body);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Connection':'close'});res.end(encoded);};
  const supplied=Buffer.from(typeof req.headers.authorization==='string'?req.headers.authorization:''),address=req.socket.remoteAddress;
  const authCount=req.rawHeaders.filter((_,index)=>index%2===0&&req.rawHeaders[index].toLowerCase()==='authorization').length;
  if(!['127.0.0.1','::ffff:127.0.0.1','::1'].includes(address??'')||authCount!==1||req.headers.origin!==undefined||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){respond(401,{error:'unauthorized'});return true;}
  if(req.method!=='POST'||!['/internal/reply/prepare','/internal/reply/generate'].includes(req.url!)){respond(404,{error:'not_found'});return true;}
  if(!owner||options.available===false){respond(503,{error:'reply_remote_unavailable'});return true;}
  const controller=new AbortController(),abort=()=>controller.abort();req.once('aborted',abort);res.once('close',abort);
  try{
   if((req.headers['content-type']??'').split(';')[0].trim()!=='application/json')invalid();
   const bytes=await readWechatHttpBody(req,1024*1024);
   let decoded:unknown;try{decoded=parseJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{invalid();}
   const input=envelope(decoded,owner);controller.signal.throwIfAborted();
   const scope=await options.read(async client=>{
    const identity=input.verified_scope;
    const rows=(await client.query(`SELECT 'manual' AS confirmation FROM manual_contact_confirmation WHERE owner_id=$1 AND contact_id=$2 AND id=$3
      UNION ALL SELECT 'desktop' AS confirmation FROM conversation_binding WHERE owner_id=$1 AND contact_id=$2 AND id=$3 AND status='active'`,[owner,identity.contact_id,identity.conversation_binding_id])).rows;
    if(rows.length!==1)throw new ReplyError('reply_input_invalidated',409);
    return {...identity,confirmation:rows[0].confirmation} as VerifiedReplyScope;
   });
   controller.signal.throwIfAborted();
   const result=await (req.url==='/internal/reply/prepare'?options.service.prepare(scope,input.request,controller.signal,input.internal):options.service.generate(scope,input.request,controller.signal,input.internal));
   controller.signal.throwIfAborted();
   if(req.url==='/internal/reply/prepare'){
    if(!exact(result,['receipt'],['input_budget'])||!record(result.receipt))throw new Error('reply_prepare_result_invalid');
    respond(200,{verified_scope:input.verified_scope,prepared:true,...result});
   }else respond(200,{verified_scope:input.verified_scope,reply:result});
  }catch(error){if(!controller.signal.aborted){const result=errorBody(error);respond(result.status,result.body);}}
  finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
  return true;
 }};
}
