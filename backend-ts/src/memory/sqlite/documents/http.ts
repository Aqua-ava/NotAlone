import type {IncomingMessage,ServerResponse} from 'node:http';
import {checkedTraceId,tracedRequest} from '../../../diagnostics/request-trace.ts';
import {diagnose} from '../../../diagnostics/context.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import type {SqliteMemoryDocuments} from './service.ts';
import { sendJson } from '../../../platform/http/json.ts';
import {uuidPattern as uuid} from '../../../platform/uuid.ts';

export function memoryDocumentsQueryAllowed(method:string|undefined,url:URL):boolean {
 const keys=[...url.searchParams.keys()],kind=url.searchParams.get('scope_kind'),contactId=url.searchParams.get('contact_id');
 return method==='GET'&&url.pathname==='/api/memory-documents'&&new Set(keys).size===keys.length
  &&keys.every(k=>['scope_kind','contact_id'].includes(k))&&['self','contact'].includes(kind??'')
  &&(kind==='self'?contactId===null:uuid.test(contactId??''));
}
/** 仅暴露固定owner下的只读集合；发布和任务执行不经页面或HTTP提交。 */
export class SqliteMemoryDocumentsHttp {
 private readonly service:SqliteMemoryDocuments;private readonly authorize:(req:IncomingMessage)=>boolean;
 constructor(service:SqliteMemoryDocuments,authorize:(req:IncomingMessage)=>boolean){this.service=service;this.authorize=authorize;}
 async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const url=new URL(req.url??'/','http://localhost');if(!url.pathname.startsWith('/api/memory-documents'))return false;
  if(!this.authorize(req)||req.headers.origin!==undefined){sendJson(res,401,{error:'unauthorized'});return true;}
  const traceHeader=req.headers['x-trace-id'];if(traceHeader!==undefined&&!checkedTraceId(traceHeader)){sendJson(res,400,{error:'document_request_invalid'});return true;}
  return tracedRequest(checkedTraceId(traceHeader),'memory.management','management_documents',async()=>{try{
   if(url.pathname!=='/api/memory-documents'){sendJson(res,404,{error:'document_not_found'});return true;}
   if(!memoryDocumentsQueryAllowed(req.method,url))throw new StorageFailure('document_request_invalid');
   const scopeKind=url.searchParams.get('scope_kind') as 'self'|'contact',contactId=url.searchParams.get('contact_id');
   const scope={scopeKind,contactId};
   sendJson(res,200,{...await this.service.read(scope),scope});
  }catch(error){const code=error instanceof StorageFailure?error.code:'document_request_invalid';diagnose({event:'request.failed',module:'memory.management',caller:'management_documents',reasonCode:'request_failed'});sendJson(res,code==='document_request_invalid'||code==='memory_scope_invalid'?400:409,{error:code});}
  return true;
  });
 }
}
