import {replyFailureReason} from '../diagnostics.ts';
import {diagnose} from '../../../diagnostics/context.ts';
import {checkedTraceId,tracedRequest} from '../../../diagnostics/request-trace.ts';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {readWechatHttpBody,WechatHttpBodyError} from '../../../sync/wechat-http-body.ts';
import type {SqliteStorage} from '../../../storage/sqlite/client.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import type {SqliteReplyCandidateService} from './service.ts';
import type {SqliteReplyTurns} from './turns.ts';
import {readReplyWorkspace} from './workspace.ts';
import {skillPresentation} from '../../../skills/sqlite/presentation.ts';
const uuid='[a-f0-9-]{36}',route=new RegExp(`^/api/contacts/(${uuid})/assistant-sessions/(${uuid})/reply-candidates(?:/(${uuid})/(edit|select|versions/([1-9][0-9]{0,5})))?$`);
const statusRoute=new RegExp(`^/api/contacts/(${uuid})/assistant-sessions/(${uuid})/reply-candidates/status$`);
const skillsRoute=new RegExp(`^/api/contacts/(${uuid})/assistant-sessions/(${uuid})/reply-candidates/(${uuid})/skills$`);
const id=(v:unknown):v is string=>typeof v==='string'&&new RegExp(`^${uuid}$`).test(v);
/** 宿主只放行候选状态和详情页的固定查询，禁止借 URL query 扩大读取范围。 */
export function replyCandidateQueryAllowed(method:string|undefined,url:URL):boolean{
 if(method!=='GET')return false;
 const entries=[...url.searchParams];
 if(statusRoute.test(url.pathname))return entries.length===1&&entries[0][0]==='request_key'&&id(entries[0][1]);
 if(!skillsRoute.test(url.pathname))return false;
 return entries.length===0||entries.length===1&&entries[0][0]==='offset'&&/^(?:0|[1-9][0-9]{0,5})$/.test(entries[0][1]);
}
function invalid():never{throw new StorageFailure('reply_input_invalid');}
function respond(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function occurredAt(value:string|null):string|null{if(value===null)return null;const timestamp=Number(value);if(!Number.isSafeInteger(timestamp))return null;const date=new Date(timestamp);return Number.isFinite(date.valueOf())?date.toISOString():null;}
const requestWindowLimit=20,pageMaxBytes=1_800_000;
export class SqliteReplyCandidateHttp {
 private readonly options:{storage:SqliteStorage;service:SqliteReplyCandidateService;turns?:SqliteReplyTurns;authorize:(request:IncomingMessage)=>boolean};
 constructor(options:SqliteReplyCandidateHttp['options']){this.options=options;}
 async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const raw=req.url??'',url=new URL(raw,'http://localhost'),statusMatch=statusRoute.exec(url.pathname),skillsMatch=skillsRoute.exec(url.pathname),match=statusMatch??skillsMatch??route.exec(url.pathname);if(!match)return false;
  const o=this.options;if(!o.authorize(req)){respond(res,401,{error:'unauthorized'});return true;}
  const trace=req.headers['x-trace-id'];if(trace!==undefined&&!checkedTraceId(trace)){respond(res,400,{error:'reply_input_invalid'});return true;}
  return tracedRequest(checkedTraceId(trace),'reply','reply_generate',async()=>{
  try{
   if(!statusMatch&&!skillsMatch&&raw!==url.pathname)invalid();
   const [,contactId,discussionId,candidateId,command,version]=match,scope={contactId,discussionId};
   if(skillsMatch){
    const offset=url.searchParams.get('offset')??'0',entries=[...url.searchParams];
    if(req.method!=='GET'||!Number.isSafeInteger(Number(offset))||Number(offset)<0||Number(offset)>1_000_000||entries.some(([key])=>key!=='offset')||entries.length>1)invalid();
    respond(res,200,await o.service.skillInputs({...scope,requestId:skillsMatch[3],offset:Number(offset)}));
   }else if(statusMatch){
    const requestKey=url.searchParams.get('request_key');
    if(req.method!=='GET'||!id(requestKey)||[...url.searchParams].length!==1||url.searchParams.has('request_key')===false)invalid();
    respond(res,200,await o.service.status(contactId,discussionId,requestKey));
   }else if(req.method==='GET'&&!candidateId){
    const requests=await o.service.view(contactId,discussionId,{includeSkillText:false,limit:requestWindowLimit+1});
    const history=await o.service.recentHistory(contactId);
    const recentMessages=history.messages.map((m:any)=>({messageId:m.id,sender:m.sender,text:m.text,occurredAt:occurredAt(m.sentAt),timePrecision:m.timePrecision,displayPosition:m.displayPosition,ordering:m.ordering}));
    const compact=(request:any)=>({
     requestId:request.requestId,
     ...(request.generationState===undefined?{}:{generationState:request.generationState}),
     coverageWarning:request.coverageWarning,
     ...(request.skillWarning===undefined?{}:{skillWarning:request.skillWarning}),
     sourceState:request.sourceState,
     candidates:request.candidates,
     selections:request.selections,
     loadedSkills:(request.loadedSkills??[]).map(({text:_text,catalogRevision:_catalogRevision,...skill}:any)=>{const title=typeof skill.name==='string'?skillPresentation(skill.name)?.title:undefined;return title?{...skill,title}:skill;}),
     ...(request.preloadedSkills===undefined?{}:{preloadedSkills:request.preloadedSkills.map(({catalogRevision:_catalogRevision,...skill}:any)=>skill)}),
    });
    let visible=requests.slice(-requestWindowLimit),hasMoreRequests=requests.length>requestWindowLimit;
    const build=()=>({requests:visible.map(compact),coverage:{phase:history.coverage.phase},recentMessages,hasMoreRequests});
    while(visible.length>1&&Buffer.byteLength(JSON.stringify(build()),'utf8')>pageMaxBytes){visible=visible.slice(1);hasMoreRequests=true;}
    if(Buffer.byteLength(JSON.stringify(build()),'utf8')>pageMaxBytes)throw new StorageFailure('reply_page_too_large');
    respond(res,200,build());
   }else if(req.method==='GET'&&command.startsWith('versions/'))respond(res,200,await o.service.version({...scope,candidateId,versionNo:Number(version)}));
   else if(req.method==='POST'){
    let v;try{v=JSON.parse((await readWechatHttpBody(req,610000,10000)).toString('utf8'));}catch(error){if(error instanceof WechatHttpBodyError)throw error;invalid();}
    if(!v||typeof v!=='object'||Array.isArray(v))invalid();
    if(!candidateId){
     if(Object.keys(v).some(k=>!['request_key','text','confirmed_contact','accept_incomplete','carried_selection_id','selected_package_id','context_message_ids','workspace'].includes(k))||!id(v.request_key)||typeof v.text!=='string'||v.text.length>100000||v.confirmed_contact!==true||v.accept_incomplete!==undefined&&typeof v.accept_incomplete!=='boolean'||v.carried_selection_id!==undefined&&!id(v.carried_selection_id)||v.selected_package_id!==undefined&&!id(v.selected_package_id)||v.context_message_ids!==undefined&&(!Array.isArray(v.context_message_ids)||v.context_message_ids.length>20||v.context_message_ids.some((x:unknown)=>!id(x))))invalid();
     const workspace=v.workspace===undefined?undefined:readReplyWorkspace(v.workspace);
     if(workspace?(v.text!==workspace.draftText||v.context_message_ids!==undefined||v.carried_selection_id!==undefined&&!workspace.includeRelationshipContext):!v.text.trim())invalid();
     if(!o.turns)throw new StorageFailure('reply_model_unavailable');
     const controller=new AbortController(),abort=()=>controller.abort();req.once('aborted',abort);res.once('close',abort);
     try{const result=await o.turns.generate({...scope,requestKey:v.request_key,text:v.text,confirmedContact:true,acceptIncomplete:v.accept_incomplete,carriedSelectionId:v.carried_selection_id,selectedPackageId:v.selected_package_id,contextMessageIds:v.context_message_ids,workspace,signal:controller.signal});respond(res,200,{session_id:result.discussionId,segmented:result.segmented,replayed:result.replayed,request_key:v.request_key});}
     finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
    }else{
     if(Object.keys(v).some(k=>!['version_no',...(command==='edit'?['parts']:[])].includes(k))||!Number.isSafeInteger(v.version_no)||v.version_no<1)invalid();
     if(command==='edit')respond(res,200,await o.service.edit({...scope,candidateId,versionNo:v.version_no,parts:v.parts}));
     else if(command==='select')respond(res,200,await o.service.select({...scope,candidateId,versionNo:v.version_no}));
     else respond(res,405,{error:'method_not_allowed'});
    }
   }else respond(res,405,{error:'method_not_allowed'});
  }catch(error){diagnose({event:'diagnostics.error',module:'reply',caller:'reply_http',reasonCode:replyFailureReason(error),contactPrefix:match[1].slice(0,8)});const code=error instanceof StorageFailure?error.code:error instanceof WechatHttpBodyError?error.code:'reply_unavailable';respond(res,code==='reply_input_invalid'||code==='reply_content_invalid'?400:409,{error:code});}
  return true;
  });
 }
}
