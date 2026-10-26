/** 仅本机 Python 薄壳可调用的讨论业务入口；公开请求不能声明已验证 owner。 */
import type {IncomingMessage,ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {parseJson,stringifyJson} from '../../host/host-json.ts';
import {readWechatHttpBody,WechatHttpBodyError} from '../../sync/wechat-http-body.ts';
import {
  AssistantDiscussionError,
  AssistantDiscussionService,
  type AssistantDiscussionScope,
} from './assistant-discussion-service.ts';

type Row=Record<string,any>;
function exact(value:unknown,required:string[],optional:string[]=[]):boolean {
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  const record=value as Row;
  return required.every(key=>Object.hasOwn(record,key))
    &&Object.keys(record).every(key=>required.includes(key)||optional.includes(key));
}
const invalid=():never=>{throw new AssistantDiscussionError('invalid',undefined,400);};
const identifier=(value:unknown):string=>{
  if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))return invalid();
  return value as string;
};

function envelope(value:unknown,owner:string):Row{
  if(!exact(value,['owner_id','contact_id','action','request'],['session_id']))invalid();
  const result=value as Row;
  if(result.owner_id!==owner)invalid();
  identifier(result.owner_id);identifier(result.contact_id);
  if(result.session_id!==undefined)identifier(result.session_id);
  if(typeof result.action!=='string'||!exact(result.request,[])) {
    if(!result.request||typeof result.request!=='object'||Array.isArray(result.request))invalid();
  }
  return result;
}

const knownReasons=new Set([
  'binding_ambiguous','binding_changed','candidate_not_selected','candidate_unavailable',
  'assistant_session_input_conflict','source_unavailable','source_deleted','generation_interrupted',
  'request_deleted','selection_stale','request_invalidated','target_message_unavailable',
  'input_version_stale',
]);
function failure(error:unknown):{status:number;body:Row}{
  if(error instanceof WechatHttpBodyError)return {status:error.status,body:{error:error.code}};
  if(!(error instanceof AssistantDiscussionError))return {status:503,body:{error:'discussion_unavailable'}};
  const reason=error.reason&&knownReasons.has(error.reason)?error.reason:undefined;
  if(error.code==='invalid')return {status:400,body:{error:'discussion_request_invalid'}};
  if(error.code==='not_found')return {status:404,body:{error:'not_found'}};
  if(error.code==='conflict')return {status:409,body:{error:'discussion_conflict',...(reason?{reason}:{})}};
  return {status:error.status,body:{error:'discussion_unavailable'}};
}

export function createAssistantDiscussionHttp(options:{
  ownerId?:string;token:string;service:AssistantDiscussionService;
  onChanged?:(scope:AssistantDiscussionScope)=>void;
}){
  if(options.token.length<32||options.ownerId!==undefined&&!identifier(options.ownerId))throw new Error('discussion_http_config_invalid');
  const expected=Buffer.from(`Bearer ${options.token}`);
  return {async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
    if(!(req.url??'').startsWith('/internal/discussion'))return false;
    const respond=(status:number,body:unknown)=>{
      if(res.destroyed||res.writableEnded)return;
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Connection':'close'});
      res.end(stringifyJson(body));
    };
    const supplied=Buffer.from(typeof req.headers.authorization==='string'?req.headers.authorization:'');
    const authCount=req.rawHeaders.filter((_,index)=>index%2===0&&req.rawHeaders[index].toLowerCase()==='authorization').length;
    if(!['127.0.0.1','::ffff:127.0.0.1','::1'].includes(req.socket.remoteAddress??'')
      ||authCount!==1||req.headers.origin!==undefined
      ||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){
      respond(401,{error:'unauthorized'});return true;
    }
    if(req.method!=='POST'||req.url!=='/internal/discussion'){respond(404,{error:'not_found'});return true;}
    if(!options.ownerId){respond(503,{error:'discussion_unavailable'});return true;}
    const controller=new AbortController(),abort=()=>controller.abort();
    req.once('aborted',abort);res.once('close',abort);
    try{
      if((req.headers['content-type']??'').split(';')[0].trim()!=='application/json')invalid();
      const bytes=await readWechatHttpBody(req,1024*1024);
      let decoded:unknown;
      try{decoded=parseJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{invalid();}
      const value=envelope(decoded,options.ownerId);
      controller.signal.throwIfAborted();
      const scope:AssistantDiscussionScope={owner_id:value.owner_id,contact_id:value.contact_id};
      const request=value.request as Row,sessionId=value.session_id as string|undefined;
      const session=():string=>{
        if(!sessionId)return invalid();
        return sessionId;
      };
      let result:unknown;
      switch(value.action){
        case 'require_binding':
          if(!exact(request,[]))invalid();
          await options.service.requireBinding(scope);result={confirmed:true};break;
        case 'default':
          if(!exact(request,[]))invalid();
          result={session_id:await options.service.defaultSession(scope)};break;
        case 'new':
          if(!exact(request,[]))invalid();
          result={session_id:await options.service.createSession(scope)};break;
        case 'list':
          if(!exact(request,[]))invalid();
          result=await options.service.listSessions(scope);break;
        case 'resume':
        case 'select':
          if(!sessionId||!exact(request,[]))invalid();
          result=await options.service.resumeSession(scope,session());break;
        case 'read':
          if(!sessionId||!exact(request,[]))invalid();
          result=await options.service.readSession(scope,session());break;
        case 'delete':
          if(!sessionId||!exact(request,['confirmed'])||request.confirmed!==true)invalid();
          result=await options.service.deleteSession(scope,session());break;
        case 'input':
          if(!sessionId||!exact(request,['content'],['expected_input_version_id']))invalid();
          if(request.expected_input_version_id!==null&&request.expected_input_version_id!==undefined)identifier(request.expected_input_version_id);
          result={session_id:session(),input_version_id:await options.service.recordInput(
            scope,session(),request.content,request.expected_input_version_id??null,
          )};break;
        case 'interrupt':
          if(!sessionId||!exact(request,['request_key','input_version_id'],['reason']))invalid();
          identifier(request.request_key);identifier(request.input_version_id);
          if(request.reason!==undefined&&!['app_quit','configuration_reload','user_cancelled'].includes(request.reason))invalid();
          result=await options.service.interrupt(
            scope,session(),request.request_key,request.input_version_id,request.reason??'app_quit',
          );break;
        case 'read_candidate':
          if(!sessionId||!exact(request,['candidate_id']))invalid();
          identifier(request.candidate_id);
          result=await options.service.readCandidate(scope,session(),request.candidate_id);break;
        case 'edit_candidate':
          if(!sessionId||!exact(request,['candidate_id','edit'],['receipt']))invalid();
          identifier(request.candidate_id);if(typeof request.receipt!=='boolean')invalid();
          result=request.receipt
            ?await options.service.editReceipt(scope,session(),request.candidate_id,request.edit)
            :await options.service.editCandidate(scope,session(),request.candidate_id,request.edit);break;
        case 'select_candidate':
          if(!sessionId||!exact(request,['candidate_id','version_id','selection_key']))invalid();
          for(const key of ['candidate_id','version_id','selection_key'])identifier(request[key]);
          result=await options.service.selectCandidate(
            scope,session(),request.candidate_id,request.version_id,request.selection_key,
          );break;
        case 'selected_candidate':
          if(!sessionId||!exact(request,[]))invalid();
          result={selection:await options.service.selectedCandidate(scope,session())};break;
        case 'carry':
          if(!sessionId||!exact(request,['expected_selection_id','candidate_id','version_id']))invalid();
          for(const key of ['expected_selection_id','candidate_id','version_id'])identifier(request[key]);
          result=await options.service.carryCandidate(scope,session(),{
            expected_selection_id:request.expected_selection_id,
            candidate_id:request.candidate_id,
            version_id:request.version_id,
          });break;
        default:invalid();
      }
      controller.signal.throwIfAborted();
      if(options.onChanged&&['input','edit_candidate','select_candidate','carry','delete'].includes(value.action))
        options.onChanged(scope);
      respond(200,{owner_id:scope.owner_id,contact_id:scope.contact_id,result});
    }catch(error){
      if(!controller.signal.aborted){const mapped=failure(error);respond(mapped.status,mapped.body);}
    }finally{
      req.removeListener('aborted',abort);res.removeListener('close',abort);
    }
    return true;
  }};
}
