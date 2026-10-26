/** 公开桌面协议的运输适配；讨论和回复继续调用原 TS 业务服务。 */
import type {IncomingMessage,ServerResponse} from 'node:http';
import {AssistantDiscussionError,type AssistantDiscussionService} from '../reply/discussion/assistant-discussion-service.ts';
import {readWechatHttpBody,WechatHttpBodyError} from '../sync/wechat-http-body.ts';
import {parseJson,stringifyJson} from './host-json.ts';
import type {ReplyHttpService} from '../reply/generation/reply-http.ts';
import {ReplyError} from '../reply/generation/reply-contract.ts';
import {parseReplyRequest} from '../reply/generation/reply-contract.ts';
import {resolvePublicReplyScope,withPublicReplyScope} from './pure-ts-reply-scope.ts';
import type {HostStorage} from '../platform/database/host-storage.ts';
import {parseExplorationEnvelope,type ExplorationHttpService} from '../reply/exploration/exploration-http.ts';
import type {AssistantGenerationLifecycle} from '../reply/discussion/assistant-generation-lifecycle.ts';
import {readPublicReplyEvidence} from './pure-ts-reply-evidence.ts';
import {PublicTransportError,sessionReadPayload,candidateHistoryPayload} from './pure-ts-public-pages.ts';
type Row=Record<string,any>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function exact(value:unknown,keys:string[],optional:string[]=[]):value is Row{
 return Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&keys.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>keys.includes(key)||optional.includes(key)));
}
// 会话读取保留嵌套轮次；生成完成响应沿用桌面要求的候选与归属字段，不能直接返回内部轮次。
function completedGenerationPayload(value:unknown,sessionId:string,restoreInput=false):unknown{
 if(!value||typeof value!=='object'||Array.isArray(value))return value;
 const turn=value as Row;
 if(turn.state!=='completed'||!turn.reply||typeof turn.reply!=='object'||Array.isArray(turn.reply))return value;
 return {...turn.reply,session_id:(turn.session_id??sessionId).toLowerCase(),turn_id:turn.turn_id,input_version_id:turn.input_version_id,state:turn.state,
  ...(turn.basis_changes===undefined?{}:{basis_changes:turn.basis_changes}),
  ...(turn.continuation===undefined?{}:{continuation:turn.continuation,effective_input:turn.effective_input,effective_scene:turn.effective_scene}),
  ...(restoreInput?{restored_input:turn.input}:{})};
}
export function createPureTsPublicApi(options:{ownerId?:string;available:boolean;discussion:AssistantDiscussionService;reply:ReplyHttpService;storage:HostStorage;skillsRoot:string;exploration:ExplorationHttpService;generation?:AssistantGenerationLifecycle}){
 return {async handle(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>{
  const path=url.pathname;
  if(path!=='/api/reply/generate'&&path!=='/api/reply/explore'&&!/^\/api\/contacts\/[^/]+\/(?:assistant-session(?:s)?(?:\/|$)|replies\/[^/]+\/evidence$)/.test(path))return false;
  const respond=(status:number,body:unknown)=>{if(!res.destroyed&&!res.writableEnded)res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(stringifyJson(body));};
  if(!options.ownerId){respond(503,{error:'owner_uninitialized'});return true;}
  if(path.startsWith('/api/reply/')&&req.method!=='POST'){respond(404,{error:'not_found'});return true;}
  if(path==='/api/reply/explore'){respond(options.available?409:503,{error:options.available?'exploration_protocol_changed':'reply_unavailable'});return true;}
  if(path==='/api/reply/generate'&&!options.available){respond(503,{error:'reply_unavailable'});return true;}
  const controller=new AbortController(),abort=()=>controller.abort();req.once('aborted',abort);res.once('close',abort);
  try{
   const bytes=await readWechatHttpBody(req,1024*1024);
   let body:unknown={};if(bytes.length){try{body=parseJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AssistantDiscussionError('invalid');}}
   if(path==='/api/reply/generate'){
    if(req.method!=='POST'){respond(404,{error:'not_found'});return true;}
    if(!exact(body,['contact_id','idempotency_key','content'],['continued_from_candidate_id','skill_version_id','skill_disabled','scene','allow_incomplete_history','suggestion','expected_input_version_id']))throw new ReplyError('reply_request_invalid',400);
    const input=parseReplyRequest(body);
    const verified=await resolvePublicReplyScope(options.storage,input.contact_id);
    const result=await withPublicReplyScope(verified,()=>options.reply.generate(verified,body,controller.signal));
    controller.signal.throwIfAborted();respond(200,result);return true;
   }
   const parts=path.split('/').slice(1),contact=parts[2];
   if(!uuid.test(contact))throw new AssistantDiscussionError('invalid');
   const scope={owner_id:options.ownerId,contact_id:contact.toLowerCase()},service=options.discussion;
   if(parts.length===6&&parts[3]==='replies'&&parts[5]==='evidence'&&req.method==='GET'){
    if(!uuid.test(parts[4])){respond(400,{error:'invalid_scope'});return true;}
    const result=await readPublicReplyEvidence(options.storage,options.skillsRoot,scope.contact_id,parts[4]);respond(result.status,result.body);return true;
   }
   const generationPath=/^\/api\/contacts\/[^/]+\/assistant-sessions\/[^/]+\/(?:replies|replace|retry-interrupted|continue|interrupt|preparation-format|generation-receipt)(?:\/|$)/.test(path);
   if(generationPath&&options.generation){
    if(!options.available&&req.method==='POST'&&!/\/(?:interrupt|preparation-format|generation-receipt)$/.test(path)&&!path.includes('/status/')){respond(503,{error:'reply_unavailable'});return true;}
    const verified=await resolvePublicReplyScope(options.storage,scope.contact_id,req.headers['x-notalone-manual-contact']===contact);
    const result=await withPublicReplyScope(verified,()=>options.generation!.handle({method:req.method??'',path:req.url??path,body,scope:verified,signal:controller.signal,respondAsync:req.headers.prefer==='respond-async'}));
    if(result){
     const completed=result.status===200&&parts.length===6&&['replies','replace','retry-interrupted','continue'].includes(parts[5]);
     respond(result.status,completed?completedGenerationPayload(result.payload,parts[4],parts[5]==='retry-interrupted'):result.payload);return true;
    }
   }
   const dispatch=async()=>{
   const session=parts[4];let result:unknown;
   if(parts[3]==='assistant-session'&&parts.length===5&&session==='binding'&&req.method==='GET'){
    await service.requireBinding(scope);result={confirmed:true};
   }else if(parts[3]==='assistant-session'&&parts.length===5&&session==='default'&&req.method==='POST'){
    if(!exact(body,[]))throw new AssistantDiscussionError('invalid');result={session_id:await service.defaultSession(scope)};
   }else if(parts[3]==='assistant-sessions'&&parts.length===4&&req.method==='GET')result=await service.listSessions(scope);
   else if(parts[3]==='assistant-sessions'&&parts.length===4&&req.method==='POST'){
    if(!exact(body,[]))throw new AssistantDiscussionError('invalid');result={session_id:await service.createSession(scope)};
   }else if(parts[3]==='assistant-sessions'&&uuid.test(session??'')){
    if(parts.length===5&&req.method==='GET')result=sessionReadPayload(await service.readSession(scope,session),url);
    else if(parts.length===5&&req.method==='DELETE'){
     if(!exact(body,['confirmed'])||body.confirmed!==true)throw new AssistantDiscussionError('invalid');result=await service.deleteSession(scope,session);
    }else if(parts.length===6&&['select','resume'].includes(parts[5])&&req.method==='POST'){
     if(!exact(body,[]))throw new AssistantDiscussionError('invalid');result=await service.resumeSession(scope,session,controller.signal);
    }else if(parts.length===6&&parts[5]==='inputs'&&req.method==='POST'){
     if(!exact(body,['content'],['expected_input_version_id']))throw new AssistantDiscussionError('invalid');
     result={session_id:session,input_version_id:await service.recordInput(scope,session,body.content,body.expected_input_version_id??null)};
    }else if(parts.length===6&&parts[5]==='selections'&&req.method==='GET'){
     result={selection:await service.selectedCandidate(scope,session)};
    }else if(parts.length===6&&parts[5]==='selections'&&req.method==='POST'){
     if(!exact(body,['candidate_id','version_id','selection_key']))throw new AssistantDiscussionError('invalid');
     result=await service.selectCandidate(scope,session,body.candidate_id,body.version_id,body.selection_key);
    }else if(parts.length===8&&parts[5]==='candidates'&&parts[7]==='versions'&&uuid.test(parts[6])){
     if(req.method==='GET')result=candidateHistoryPayload(await service.readCandidate(scope,session,parts[6]),url);
     else if(req.method==='POST'){
      if(!exact(body,['edit_key','parent_version_id','messages'],['requirements'])||!uuid.test(body.edit_key)||!uuid.test(body.parent_version_id)||!Array.isArray(body.messages)||body.messages.some((message:unknown)=>!exact(message,['message_id','text'])||!uuid.test(message.message_id)||typeof message.text!=='string'))throw new PublicTransportError('assistant_candidate_version_request_invalid');
      if(url.search){if(url.searchParams.getAll('receipt').length!==1||url.searchParams.get('receipt')!=='1'||[...url.searchParams.keys()].length!==1)throw new PublicTransportError('assistant_candidate_version_request_invalid');result=await service.editReceipt(scope,session,parts[6],body as any);}
      else result=candidateHistoryPayload(await service.editCandidate(scope,session,parts[6],body as any),url);
     }
     else{respond(405,{error:'method_not_allowed'});return true;}
    }else if(parts.length===6&&parts[5]==='new-with-candidate'&&req.method==='POST'){
     if(!exact(body,['expected_selection_id','candidate_id','version_id']))throw new AssistantDiscussionError('invalid');
     result=await service.carryCandidate(scope,session,body as any);
    }else if(parts.length===6&&parts[5]==='interrupt'&&req.method==='POST'){
     if(!exact(body,['request_key','input_version_id'],['reason']))throw new AssistantDiscussionError('invalid');
     result=await service.interrupt(scope,session,body.request_key,body.input_version_id,body.reason??'app_quit');
    }else if(parts[5]==='explorations'){
     if(!options.available){respond(503,{error:'exploration_unavailable'});return true;}
     if(options.generation&&parts.length===8&&['confirm','answer','prepare-confirm','prepare-answer'].includes(parts[7])){
      const verified=await resolvePublicReplyScope(options.storage,scope.contact_id,req.headers['x-notalone-manual-contact']===contact);
      const generated=await withPublicReplyScope(verified,()=>options.generation!.handleExploration({method:req.method??'',path:req.url??path,body,scope:verified,signal:controller.signal},options.exploration));
      if(generated){
       const payload=generated.payload as Row;
       respond(generated.status,generated.status===200&&payload?.kind==='generated'?{...payload,turn:completedGenerationPayload(payload.turn,session)}:payload);return true;
      }
     }
     let action:string,request:Row;
     if(parts.length===6&&req.method==='POST'){action='open';request=body as Row;}
     else if(parts.length===7&&req.method==='GET'){action='read';request={exploration_id:parts[6]};}
     else if(parts.length===8&&req.method==='POST'){
      action=parts[7];if(!['stop','reconfirm'].includes(action)||!exact(body,[],['input_version_id','suggestion_id','direct_intent','question_id','answer','operation_key','expected_input_version_id','request_key','generate']))throw new AssistantDiscussionError('invalid');
      request={...body,exploration_id:parts[6]};
     }else{respond(404,{error:'not_found'});return true;}
     const verified=parseExplorationEnvelope({...scope,session_id:session,action,request,manual_input:req.headers['x-notalone-manual-contact']===contact},options.ownerId!);
     result=await options.exploration.execute(scope,session,verified.action,verified.request,controller.signal,{manual_input:verified.manual_input});
    }else{respond(404,{error:'not_found'});return true;}
   }else{respond(404,{error:'not_found'});return true;}
   controller.signal.throwIfAborted();return result;
   };
   const result=req.headers['x-notalone-manual-contact']===contact
    ?await withPublicReplyScope(await resolvePublicReplyScope(options.storage,scope.contact_id,true),dispatch)
    :await dispatch();
   respond(200,result);
  }catch(error){
   if(controller.signal.aborted)return true;
   if(error instanceof PublicTransportError)respond(error.status,{error:error.code,...(error.reason?{reason:error.reason}:{})});
   else if(error instanceof WechatHttpBodyError)respond(error.status,{error:error.code});
   else if(error instanceof AssistantDiscussionError){
    if(path==='/api/reply/generate'&&error.code==='invalid'){respond(400,{error:'reply_request_invalid'});return true;}
    if(/\/(?:candidates\/[^/]+\/versions|selections)$/.test(path)){
      const invalid=error.code==='invalid'||error.code==='candidate_invalid';
      respond(invalid?400:error.status,{error:invalid?'assistant_candidate_version_request_invalid':error.code==='not_found'?'not_found':error.code==='conflict'?'assistant_candidate_version_conflict':'assistant_candidate_version_save_failed',...(error.reason?{reason:error.reason}:{})});return true;
    }
    const reason=error.reason;
    const code=error.code==='invalid'?'assistant_session_request_invalid':error.code==='not_found'?'not_found':error.code==='conflict'?'assistant_session_rejected':error.code==='in_progress'?'assistant_session_in_progress':'assistant_session_save_failed';
    respond(error.status,{error:code,...(reason?{reason}:{})});
   }else if(error instanceof ReplyError)respond(error.status,{error:error.code,...(typeof (error as any).reason==='string'?{reason:(error as any).reason}:{}),...((error as any).input_budget?{input_budget:(error as any).input_budget}:{})});
   else respond(503,{error:'assistant_session_save_failed'});
  }finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
  return true;
 }};
}
