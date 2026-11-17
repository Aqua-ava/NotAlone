import {replyFailureReason} from './diagnostics.ts';
import {diagnose} from '../../diagnostics/context.ts';
import {checkedTraceId,tracedRequest} from '../../diagnostics/request-trace.ts';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {readHttpBody,HttpBodyError} from '../../platform/http/body.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {SqliteDiscussionService} from './service.ts';
import type {SqliteDiscussionTurns} from './turns.ts';
const uuid='[a-f0-9-]{36}';
const route=new RegExp(`^/api/contacts/(${uuid})/assistant-sessions(?:/(${uuid})(?:/(continue|entries))?)?$`);
const defaultRoute=new RegExp(`^/api/contacts/(${uuid})/assistant-session/(default|binding)$`);
function respond(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function invalid():never{throw new StorageFailure('discussion_input_invalid');}
/** 认证由唯一宿主注入，owner固定在服务；不接收SQL、路径、运行身份或资格证明。 */
export class SqliteDiscussionHttp {
 private readonly service:SqliteDiscussionService;private readonly authorize:(req:IncomingMessage)=>boolean;private readonly turns?:SqliteDiscussionTurns;
 constructor(service:SqliteDiscussionService,authorize:(req:IncomingMessage)=>boolean,turns?:SqliteDiscussionTurns){this.service=service;this.authorize=authorize;this.turns=turns;}
 async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const raw=req.url??'',url=new URL(raw,'http://localhost'),match=route.exec(url.pathname),fallback=defaultRoute.exec(url.pathname);
  if(!match&&!fallback)return false;
  // DELETE沿05唯一删除服务；不能在这里实现第二套清理。
  if(req.method==='DELETE')return false;
  if(!this.authorize(req)){respond(res,401,{error:'unauthorized'});return true;}
  const trace=req.headers['x-trace-id'];if(trace!==undefined&&!checkedTraceId(trace)){respond(res,400,{error:'discussion_input_invalid'});return true;}
  return tracedRequest(checkedTraceId(trace),'reply','reply_generate',async()=>{
  try{
   if(raw!==url.pathname)invalid();
   const contactId=(match??fallback)![1],discussionId=match?.[2],command=match?.[3]??fallback?.[2];
   if(req.method==='POST'){
    // 信封覆盖10万UTF-16字符的JSON转义形式；正文字符限制仍在具名受理事务核验。
    let value;try{value=JSON.parse((await readHttpBody(req,610000,10000)).toString('utf8'));}catch(error){if(error instanceof HttpBodyError)throw error;invalid();}
    if(!value||typeof value!=='object'||Array.isArray(value))invalid();
    if(command==='entries'){
     if(!this.turns)throw new StorageFailure('discussion_model_unavailable');
     if(Object.keys(value).some(k=>!['request_key','text','confirmed_contact'].includes(k))||!new RegExp(`^${uuid}$`).test(value.request_key)||typeof value.text!=='string'||value.confirmed_contact!==true)invalid();
     const controller=new AbortController(),abort=()=>controller.abort();req.once('aborted',abort);res.once('close',abort);
     try{const result=await this.turns.generate({contactId,discussionId:discussionId!,requestKey:value.request_key,text:value.text,confirmedContact:true,signal:controller.signal});respond(res,200,{session_id:result.discussionId,segmented:result.segmented,replayed:result.replayed,request_key:value.request_key});}
     finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
    }else if(Object.keys(value).length)invalid();
    else if(command==='continue'){await this.service.continueDiscussion(contactId,discussionId!);respond(res,200,{session_id:discussionId});}
    else if(!discussionId&&!command||command==='default'){
     const catalog=command==='default'?await this.service.list(contactId):undefined;
     const id=catalog?.currentDiscussionId??(await this.service.newDiscussion(contactId)).id;respond(res,200,{session_id:id});
    }else{respond(res,405,{error:'method_not_allowed'});}
   }else if(req.method==='GET'){
    if(command==='binding'){await this.service.list(contactId);respond(res,200,{confirmed:true});}
    else if(discussionId&&!command){
     // 回看只核验业务正文资格，运行副本是否可继续由显式生成入口另行核对。
     const view=await this.service.view(contactId,discussionId),recovery=view.discussion.currentRuntimeId?'unchecked':'none';
     // 撤下内容只规范化公开投影，原库的调用身份继续保留给审计与删除。
     respond(res,200,{mode:'sqlite',session_id:discussionId,entries:view.entries.map((e:any)=>({entry_id:e.id,position:String(e.position),role:e.role,text:e.content_state==='cleared'?null:e.body,request_id:e.origin_request_id,call_id:e.content_state==='cleared'?null:e.origin_call_id,content_state:e.content_state})),runtime_recovery:recovery});
    }else if(!command){const catalog=await this.service.list(contactId);respond(res,200,{sessions:catalog.discussions.map(d=>({session_id:d.id,is_current:d.isCurrent,last_user_activity_at:new Date(Number(d.lastActivityAt)).toISOString()})),current_session_id:catalog.currentDiscussionId});}
    else respond(res,405,{error:'method_not_allowed'});
   }else respond(res,405,{error:'method_not_allowed'});
  }catch(error){diagnose({event:'diagnostics.error',module:'reply',caller:'reply_http',reasonCode:replyFailureReason(error),contactPrefix:(match??fallback)![1].slice(0,8)});const code=error instanceof StorageFailure?error.code:error instanceof HttpBodyError?error.code:'discussion_unavailable';respond(res,code==='discussion_input_invalid'?400:code==='discussion_unavailable'?404:409,{error:code==='discussion_unavailable'?'not_found':code});}
  return true;
  });
 }
}
