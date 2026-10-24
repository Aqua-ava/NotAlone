/** 认证宿主到探索业务的薄桥；业务身份不会由模型或公开请求声明。 */
import type {IncomingMessage,ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {parseJson,stringifyJson} from './host-json.ts';
import {readWechatHttpBody,WechatHttpBodyError} from './wechat-http-body.ts';
import {ReplyError,record} from './reply-contract.ts';
export interface ExplorationHttpService {
 execute(scope:{owner_id:string;contact_id:string},session:string|undefined,action:string,request:Record<string,any>,signal:AbortSignal,internal?:{manual_input:boolean}):Promise<unknown>;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid=():never=>{throw new ReplyError('exploration_request_invalid',400);};
function exact(value:unknown,required:string[],optional:string[]=[]):value is Record<string,any>{return record(value)&&required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k));}
function identifier(value:unknown,optional=false){if(optional&&value==null)return; if(typeof value!=='string'||!uuid.test(value))invalid();}
function text(value:unknown,optional=false){if(optional&&value===undefined)return;if(typeof value!=='string'||Array.from(value).length>4096)invalid();}
function safeBudget(value:unknown):Record<string,unknown>|null{
 const keys=['state','allowed','model_id','context_window_tokens','input_tokens','output_reserve_tokens','total_tokens','measurement_kind','measurement_id','reason'];
 if(!exact(value,keys,['safety_margin_tokens'])||!['exceeded','unavailable','warning','ready'].includes(value.state)||typeof value.allowed!=='boolean'||typeof value.model_id!=='string'||value.measurement_kind!==null&&!['approximate','exact','verified_upper_bound'].includes(value.measurement_kind)||value.measurement_id!==null&&typeof value.measurement_id!=='string'||value.reason!==null&&typeof value.reason!=='string'||['context_window_tokens','input_tokens','output_reserve_tokens','total_tokens','safety_margin_tokens'].some(k=>value[k]!==undefined&&value[k]!==null&&(!Number.isSafeInteger(value[k])||value[k]<0)))return null;
 return value;
}
function input(value:unknown){
 if(!record(value))return invalid();
 const primary=value.type==='response_exploration'?'target_message_id':value.type==='purpose_exploration'?'purpose_hint':invalid();
 if(!exact(value,['type'],[primary,'correction','requirements','skill_mode','skill_version_id','skill_scene','answer','confirmed_intent']))invalid();
 if(primary==='target_message_id')identifier(value.target_message_id);else text(value.purpose_hint,true);
 for(const k of ['correction','requirements'])text(value[k],true);
 if(value.answer!==undefined&&value.answer!==''||value.confirmed_intent!==undefined&&value.confirmed_intent!=='')invalid();
 const mode=value.skill_mode??'auto';if(typeof mode!=='string'||!['auto','disabled','user'].includes(mode))invalid();
 if(mode==='user')identifier(value.skill_version_id);else if(value.skill_version_id!=null)invalid();
 if(value.skill_scene!=null&&(typeof value.skill_scene!=='string'||!value.skill_scene.trim()||value.skill_scene.trim()!==value.skill_scene||Array.from(value.skill_scene).length>256))invalid();
}
/** 严格解析动作，避免私有薄桥变成任意方法调用能力。 */
export function parseExplorationEnvelope(value:unknown,owner:string){
 if(!exact(value,['owner_id','contact_id','action','request'],['session_id','manual_input'])||value.owner_id!==owner)return invalid();
 if(value.manual_input!==undefined&&typeof value.manual_input!=='boolean')invalid();identifier(value.owner_id);identifier(value.contact_id);identifier(value.session_id,true);
 const r=value.request,a=value.action;if(typeof a!=='string'||!record(r))return invalid();
 const common=['exploration_id','input_version_id'];
 if(a==='open'){
  if(!value.session_id||!exact(r,['content','operation_key'],['expected_input_version_id','previous_id','automatic','change_group']))invalid();
  input(r.content);identifier(r.operation_key);identifier(r.expected_input_version_id,true);identifier(r.previous_id,true);
  for(const k of ['automatic','change_group'])if(r[k]!==undefined&&typeof r[k]!=='boolean')invalid();
 }else if(['read','require_session'].includes(a)){
  if(!exact(r,['exploration_id'])||a==='require_session'&&!value.session_id)invalid();identifier(r.exploration_id);
 }else if(['confirm','answer'].includes(a)){
  const required=a==='confirm'?common:[...common,'question_id','answer','operation_key'];
  if(!value.session_id||!exact(r,required,a==='confirm'?['suggestion_id','direct_intent','prepare_only','selection_only']:['prepare_only','selection_only']))invalid();
  for(const k of common)identifier(r[k]);
  for(const k of ['prepare_only','selection_only'])if(r[k]!==undefined&&typeof r[k]!=='boolean')invalid();
  if(a==='confirm'){identifier(r.suggestion_id,true);if(r.direct_intent!==null)text(r.direct_intent,true);if((r.suggestion_id==null)===(r.direct_intent==null))invalid();}
  else {identifier(r.question_id);identifier(r.operation_key);text(r.answer);}
 }else if(a==='reconfirm'){
  if(!value.session_id||!exact(r,[...common,'expected_input_version_id','request_key'],['suggestion_id','direct_intent']))invalid();
  for(const k of [...common,'expected_input_version_id','request_key'])identifier(r[k]);identifier(r.suggestion_id,true);if(r.direct_intent!==null)text(r.direct_intent,true);if((r.suggestion_id==null)===(r.direct_intent==null))invalid();
 }else if(a==='stop'||a==='finish'){
  if(!value.session_id||!exact(r,a==='stop'?common:[...common,'request_key']))invalid();for(const k of a==='stop'?common:[...common,'request_key'])identifier(r[k]);
 }else invalid();
 return value;
}
export function createExplorationHttp(options:{ownerId?:string;token:string;available?:boolean;service:ExplorationHttpService}){
 if(options.token.length<32||options.ownerId!==undefined&&!uuid.test(options.ownerId))throw new Error('exploration_http_config_invalid');
 const expected=Buffer.from(`Bearer ${options.token}`);
 return {async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  if(!(req.url??'').startsWith('/internal/exploration'))return false;
  const respond=(status:number,body:unknown)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Connection':'close'}).end(stringifyJson(body));};
  const auth=Buffer.from(typeof req.headers.authorization==='string'?req.headers.authorization:''),count=req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()==='authorization').length;
  if(!['127.0.0.1','::ffff:127.0.0.1','::1'].includes(req.socket.remoteAddress??'')||count!==1||req.headers.origin!==undefined||auth.length!==expected.length||!timingSafeEqual(auth,expected)){respond(401,{error:'unauthorized'});return true;}
  if(req.method!=='POST'||req.url!=='/internal/exploration'){respond(404,{error:'not_found'});return true;}
  if(!options.ownerId||options.available===false){respond(503,{error:'exploration_unavailable'});return true;}
  const controller=new AbortController(),abort=()=>controller.abort();req.once('aborted',abort);res.once('close',abort);
  try{
   if((req.headers['content-type']??'').split(';')[0].trim()!=='application/json')invalid();
   const bytes=await readWechatHttpBody(req,1024*1024);let decoded:unknown;
   try{decoded=parseJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{invalid();}
   const v=parseExplorationEnvelope(decoded,options.ownerId);controller.signal.throwIfAborted();
   const result=await options.service.execute({owner_id:v.owner_id,contact_id:v.contact_id},v.session_id,v.action,v.request,controller.signal,{manual_input:v.manual_input??false});
   controller.signal.throwIfAborted();respond(200,{owner_id:v.owner_id,contact_id:v.contact_id,result});
  }catch(error){
   if(!controller.signal.aborted){
    if(error instanceof WechatHttpBodyError)respond(error.status,{error:error.code});
    else if(error instanceof ReplyError){const code=error.code;const allowed=['exploration_request_invalid','exploration_rejected','exploration_failed','input_budget_exceeded','input_budget_unavailable','provider_context_limit'],raw=(error as any).input_budget,budget=raw===undefined?null:safeBudget(raw);if(!allowed.includes(code)||raw!==undefined&&!budget)respond(503,{error:'exploration_failed'});else respond(error.status,{error:code,...(budget?{input_budget:budget}:{})});}
    else respond(503,{error:'exploration_failed'});
   }
  }finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
  return true;
 }};
}
