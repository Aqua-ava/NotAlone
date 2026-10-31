import type {IncomingMessage,ServerResponse} from 'node:http';
import {readWechatHttpBody,WechatHttpBodyError} from '../../../sync/wechat-http-body.ts';
import type {SqliteStorage} from '../../../storage/sqlite/client.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import type {SqliteReplyCandidateService} from './service.ts';
import type {SqliteReplyTurns} from './turns.ts';
import {readReplyWorkspace} from './workspace.ts';
const uuid='[a-f0-9-]{36}',route=new RegExp(`^/api/contacts/(${uuid})/assistant-sessions/(${uuid})/reply-candidates(?:/(${uuid})/(edit|select|versions/([1-9][0-9]{0,5})))?$`);
const id=(v:unknown):v is string=>typeof v==='string'&&new RegExp(`^${uuid}$`).test(v);
function invalid():never{throw new StorageFailure('reply_input_invalid');}
function respond(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function occurredAt(value:string|null):string|null{if(value===null)return null;const timestamp=Number(value);if(!Number.isSafeInteger(timestamp))return null;const date=new Date(timestamp);return Number.isFinite(date.valueOf())?date.toISOString():null;}
export class SqliteReplyCandidateHttp {
 private readonly options:{storage:SqliteStorage;service:SqliteReplyCandidateService;turns?:SqliteReplyTurns;authorize:(request:IncomingMessage)=>boolean};
 constructor(options:SqliteReplyCandidateHttp['options']){this.options=options;}
 async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const raw=req.url??'',url=new URL(raw,'http://localhost'),match=route.exec(url.pathname);if(!match)return false;
  const o=this.options;if(!o.authorize(req)){respond(res,401,{error:'unauthorized'});return true;}
  try{
   if(raw!==url.pathname)invalid();
   const [,contactId,discussionId,candidateId,command,version]=match,scope={contactId,discussionId};
   if(req.method==='GET'&&!candidateId){
    const requests=await o.service.view(contactId,discussionId),coverage=await o.storage.execute('history.coverage',{ownerId:o.service.ownerId,contactId});
    const skills=await o.storage.execute<any[]>('skills.list',{ownerId:o.service.ownerId});
    const history=await o.storage.execute<any>('history.read',{ownerId:o.service.ownerId,contactId,limit:20});
    const recentMessages=history.messages.filter((m:any)=>m.kind==='text'&&typeof m.text==='string'&&m.text.length>0).slice(0,20).map((m:any)=>({messageId:m.id,sender:m.sender,text:m.text,occurredAt:occurredAt(m.sentAt),timePrecision:m.timePrecision,displayPosition:m.displayPosition,ordering:m.ordering}));
    respond(res,200,{requests:requests.map(({ownerId:_owner,...r})=>r),coverage,recentMessages,availableSkills:skills.filter(s=>s.enabledState==='enabled'&&s.verificationState==='verified'&&s.currentRevisionNo!==null).map(s=>({packageId:s.id,name:s.displayName,revisionNo:Number(s.currentRevisionNo)}))});
   }else if(req.method==='GET'&&command.startsWith('versions/'))respond(res,200,await o.service.version({...scope,candidateId,versionNo:Number(version)}));
   else if(req.method==='POST'){
    let v;try{v=JSON.parse((await readWechatHttpBody(req,610000,10000)).toString('utf8'));}catch(error){if(error instanceof WechatHttpBodyError)throw error;invalid();}
    if(!v||typeof v!=='object'||Array.isArray(v))invalid();
    if(!candidateId){
     if(Object.keys(v).some(k=>!['request_key','text','confirmed_contact','accept_incomplete','carried_selection_id','selected_package_id','context_message_ids','workspace'].includes(k))||!id(v.request_key)||typeof v.text!=='string'||v.text.length>100000||v.confirmed_contact!==true||v.accept_incomplete!==undefined&&typeof v.accept_incomplete!=='boolean'||v.carried_selection_id!==undefined&&!id(v.carried_selection_id)||v.selected_package_id!==undefined&&!id(v.selected_package_id)||v.context_message_ids!==undefined&&(!Array.isArray(v.context_message_ids)||v.context_message_ids.length>20||v.context_message_ids.some((x:unknown)=>!id(x))))invalid();
     const workspace=v.workspace===undefined?undefined:readReplyWorkspace(v.workspace);
     if(workspace?(v.text!==workspace.draftText||v.context_message_ids!==undefined||v.carried_selection_id!==undefined&&(!workspace.includeRelationshipContext||workspace.excludedMessageIds.length>0)):!v.text.trim())invalid();
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
  }catch(error){const code=error instanceof StorageFailure?error.code:error instanceof WechatHttpBodyError?error.code:'reply_unavailable';respond(res,code==='reply_input_invalid'||code==='reply_content_invalid'?400:409,{error:code});}
  return true;
 }
}
