import type {IncomingMessage,ServerResponse} from 'node:http';
import {readWechatHttpBody} from '../../../sync/wechat-http-body.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import type {SqliteMemoryManagement} from './service.ts';
import type {MemoryDecisionRequest} from './contracts.ts';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fields=new Set(['requestKey','action','candidateIds','candidateRevisions','memoryId','expectedVersionNo','expectedHeadRevision','restoredFromVersionNo','body','scope']);
function send(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
/** owner来自宿主，系统自动决定没有HTTP分支。 */
export class SqliteMemoryManagementHttp {
 private service:SqliteMemoryManagement;private authorize:(req:IncomingMessage)=>boolean;
 constructor(service:SqliteMemoryManagement,authorize:(req:IncomingMessage)=>boolean){this.service=service;this.authorize=authorize;}
 async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const url=new URL(req.url??'/','http://localhost');if(!url.pathname.startsWith('/api/memory-management'))return false;
  if(!this.authorize(req)||req.headers.origin!==undefined){send(res,401,{error:'unauthorized'});return true;}
  try{
   if(url.pathname==='/api/memory-management'&&req.method==='GET'){
    const keys=[...url.searchParams.keys()],kind=url.searchParams.get('scope_kind'),contactId=url.searchParams.get('contact_id');
    if(new Set(keys).size!==keys.length||keys.some(k=>!['scope_kind','contact_id'].includes(k))||!['self','contact'].includes(kind??'')||(kind==='self'?contactId!==null:!uuid.test(contactId??'')))throw new StorageFailure('memory_request_invalid');
    send(res,200,await this.service.read({scopeKind:kind as 'self'|'contact',contactId}));
   }else if(url.pathname==='/api/memory-management/decisions'&&req.method==='POST'&&!url.search){
    const request=JSON.parse((await readWechatHttpBody(req,65536,10000)).toString('utf8'));
    if(!request||Array.isArray(request)||Object.keys(request).some(k=>!fields.has(k))||!uuid.test(request.requestKey??'')||request.action==='auto_accept'||request.action==='auto_update'||request.scope&&Object.keys(request.scope).some(k=>!['scopeKind','contactId'].includes(k)))throw new StorageFailure('memory_request_invalid');
    send(res,200,await this.service.decide(request as MemoryDecisionRequest));
   }else send(res,404,{error:'memory_not_found'});
  }catch(error){const code=error instanceof StorageFailure?error.code:'memory_request_invalid';send(res,code==='memory_request_invalid'||code==='memory_scope_invalid'?400:409,{error:code});}
  return true;
 }
}
