import type {IncomingMessage,ServerResponse} from 'node:http';
import {checkedTraceId,tracedRequest} from '../../../diagnostics/request-trace.ts';
import {diagnose} from '../../../diagnostics/context.ts';
import {readHttpBody} from '../../../platform/http/body.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import type {SqliteMemoryManagement} from './service.ts';
import type {MemoryDecisionRequest} from './contracts.ts';
import { sendJson } from '../../../platform/http/json.ts';
import {uuidPattern as uuid} from '../../../platform/uuid.ts';
const fields=new Set(['requestKey','action','candidateIds','candidateRevisions','memoryId','expectedVersionNo','expectedHeadRevision','restoredFromVersionNo','expectedMergedParents','body','scope']);
export function memoryManagementQueryAllowed(method:string|undefined,url:URL):boolean{
 const keys=[...url.searchParams.keys()],kind=url.searchParams.get('scope_kind'),contactId=url.searchParams.get('contact_id');
 const history=url.pathname==='/api/memory-management/history';
 return method==='GET'&&(url.pathname==='/api/memory-management'||history)&&new Set(keys).size===keys.length&&keys.every(k=>['scope_kind','contact_id','display_contact_id','cursor','memory_id',...history?[]:['candidate_id']].includes(k))
  &&['self','contact'].includes(kind??'')&&(kind==='self'?contactId===null:uuid.test(contactId??''))
  &&['display_contact_id','memory_id','candidate_id'].every(key=>!url.searchParams.has(key)||uuid.test(url.searchParams.get(key)!))
  &&(!history||url.searchParams.has('memory_id'))&&(!url.searchParams.has('cursor')||/^[A-Za-z0-9_-]{1,4096}$/.test(url.searchParams.get('cursor')!));
}
/** owner来自宿主，系统自动决定没有HTTP分支。 */
export class SqliteMemoryManagementHttp {
 private service:SqliteMemoryManagement;private authorize:(req:IncomingMessage)=>boolean;
 private readonly afterDecision:()=>void;
 constructor(service:SqliteMemoryManagement,authorize:(req:IncomingMessage)=>boolean,afterDecision:()=>void=()=>{}){this.service=service;this.authorize=authorize;this.afterDecision=afterDecision;}
 async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const url=new URL(req.url??'/','http://localhost');if(!url.pathname.startsWith('/api/memory-management'))return false;
  if(!this.authorize(req)||req.headers.origin!==undefined){sendJson(res,401,{error:'unauthorized'});return true;}
  const traceHeader=req.headers['x-trace-id'];if(traceHeader!==undefined&&!checkedTraceId(traceHeader)){sendJson(res,400,{error:'memory_request_invalid'});return true;}
  const caller=url.pathname.endsWith('/history')?'management_history':req.method==='POST'?'management_decide':'management_read';
  return tracedRequest(checkedTraceId(traceHeader),'memory.management',caller,async()=>{try{
   if(['/api/memory-management','/api/memory-management/history'].includes(url.pathname)&&req.method==='GET'){
    const kind=url.searchParams.get('scope_kind'),contactId=url.searchParams.get('contact_id');
    if(!memoryManagementQueryAllowed(req.method,url))throw new StorageFailure('memory_request_invalid');
    const scope={scopeKind:kind as 'self'|'contact',contactId},query={
     ...(url.searchParams.has('display_contact_id')?{displayContactId:url.searchParams.get('display_contact_id')!}:{}),
     ...(url.searchParams.has('cursor')?{cursor:url.searchParams.get('cursor')!}:{}),
    };
    const controller=new AbortController(),cancel=()=>controller.abort();res.once('close',cancel);
    try{sendJson(res,200,url.pathname.endsWith('/history')?await this.service.readHistory(scope,url.searchParams.get('memory_id')!,query):await this.service.read(scope,{...query,
     ...(url.searchParams.has('memory_id')?{memoryId:url.searchParams.get('memory_id')!}:{}),...(url.searchParams.has('candidate_id')?{candidateId:url.searchParams.get('candidate_id')!}:{}),
    },{signal:controller.signal}));}finally{res.removeListener('close',cancel);}
   }else if(url.pathname==='/api/memory-management/decisions'&&req.method==='POST'&&!url.search){
    const request=JSON.parse((await readHttpBody(req,65536,10000)).toString('utf8'));
    if(!request||Array.isArray(request)||Object.keys(request).some(k=>!fields.has(k))||!uuid.test(request.requestKey??'')||['auto_accept','auto_update','auto_retire','auto_noop'].includes(request.action)||request.scope&&Object.keys(request.scope).some(k=>!['scopeKind','contactId'].includes(k)))throw new StorageFailure('memory_request_invalid');
    const result=await this.service.decide(request as MemoryDecisionRequest);this.afterDecision();sendJson(res,200,result);
   }else sendJson(res,404,{error:'memory_not_found'});
  }catch(error){const code=error instanceof StorageFailure?error.code:'memory_request_invalid';diagnose({event:'request.failed',module:'memory.management',caller,reasonCode:code==='memory_source_stale'?'source_stale':'request_failed'});sendJson(res,code==='memory_request_invalid'||code==='memory_scope_invalid'?400:409,{error:code});}
  return true;
  });
 }
}
