import type {IncomingMessage,ServerResponse} from 'node:http';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import type {SqliteMemoryDocuments} from './service.ts';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function memoryDocumentsQueryAllowed(method:string|undefined,url:URL):boolean {
 const keys=[...url.searchParams.keys()],kind=url.searchParams.get('scope_kind'),contactId=url.searchParams.get('contact_id');
 return method==='GET'&&url.pathname==='/api/memory-documents'&&new Set(keys).size===keys.length
  &&keys.every(k=>['scope_kind','contact_id'].includes(k))&&['self','contact'].includes(kind??'')
  &&(kind==='self'?contactId===null:uuid.test(contactId??''));
}
function send(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
/** 仅暴露固定owner下的只读集合；发布和任务执行不经页面或HTTP提交。 */
export class SqliteMemoryDocumentsHttp {
 private readonly service:SqliteMemoryDocuments;private readonly authorize:(req:IncomingMessage)=>boolean;
 constructor(service:SqliteMemoryDocuments,authorize:(req:IncomingMessage)=>boolean){this.service=service;this.authorize=authorize;}
 async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const url=new URL(req.url??'/','http://localhost');if(!url.pathname.startsWith('/api/memory-documents'))return false;
  if(!this.authorize(req)||req.headers.origin!==undefined){send(res,401,{error:'unauthorized'});return true;}
  try{
   if(url.pathname!=='/api/memory-documents'){send(res,404,{error:'document_not_found'});return true;}
   if(!memoryDocumentsQueryAllowed(req.method,url))throw new StorageFailure('document_request_invalid');
   const scopeKind=url.searchParams.get('scope_kind') as 'self'|'contact',contactId=url.searchParams.get('contact_id');
   const scope={scopeKind,contactId};
   send(res,200,{...await this.service.read(scope),scope});
  }catch(error){const code=error instanceof StorageFailure?error.code:'document_request_invalid';send(res,code==='document_request_invalid'||code==='memory_scope_invalid'?400:409,{error:code});}
  return true;
 }
}
