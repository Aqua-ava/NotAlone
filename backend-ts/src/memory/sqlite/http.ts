import type {IncomingMessage,ServerResponse} from 'node:http';
import {readWechatHttpBody} from '../../sync/wechat-http-body.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {SqliteMemoryExtraction} from './service.ts';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function send(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
/** 认证函数来自唯一宿主；owner和固定输入不能由HTTP指定。 */
export class SqliteMemoryExtractionHttp {
 private service:SqliteMemoryExtraction;private authorize:(req:IncomingMessage)=>boolean;
 private readonly schedule:()=>Promise<unknown>;
 constructor(service:SqliteMemoryExtraction,authorize:(req:IncomingMessage)=>boolean,schedule=()=>service.readSchedule()){this.service=service;this.authorize=authorize;this.schedule=schedule;}
 async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const url=new URL(req.url??'/','http://localhost');
  if(!url.pathname.startsWith('/api/memory-processing/'))return false;
  if(!this.authorize(req)||req.headers.origin!==undefined){send(res,401,{error:'unauthorized'});return true;}
  if(url.pathname==='/api/memory-processing/schedule'){
   if(req.method!=='GET'||url.search){send(res,400,{error:'memory_extraction_request_invalid'});return true;}
   try{send(res,200,await this.schedule());}catch{send(res,409,{error:'memory_extraction_schedule_unavailable'});}return true;
  }
  const task=/^\/api\/memory-processing\/tasks\/([a-f0-9-]{36})\/events$/.exec(url.pathname);
  const run=/^\/api\/memory-processing\/runs(?:\/(current|[a-f0-9-]{36})(?:\/(pause|continue))?)?$/.exec(url.pathname);
  if(!task&&!run){send(res,404,{error:'memory_extraction_not_found'});return true;}
  try{
   if(url.search)throw new StorageFailure('memory_extraction_request_invalid');
   let value:unknown;
   if(task){if(req.method!=='GET'||!uuid.test(task[1]!))throw new StorageFailure('memory_extraction_request_invalid');value=await this.service.trace(task[1]!);}
   else if(!run![1]){
    if(req.method!=='POST')throw new StorageFailure('memory_extraction_request_invalid');
    const body=JSON.parse((await readWechatHttpBody(req,2048,10_000)).toString('utf8'));
    if(!body||Array.isArray(body)||Object.keys(body).join(',')!=='request_key'||!uuid.test(body.request_key))throw new StorageFailure('memory_extraction_request_invalid');
    value=await this.service.start(body.request_key);
   }else if(run![2]){
    if(req.method!=='POST'||run![1]==='current'||!uuid.test(run![1]!))throw new StorageFailure('memory_extraction_request_invalid');
    const body=JSON.parse((await readWechatHttpBody(req,1024,10_000)).toString('utf8')||'{}');
    const fields=body&&typeof body==='object'&&!Array.isArray(body)?Object.keys(body).sort().join(','):'';
    if(fields!=='action_version,operation_id'||!Number.isSafeInteger(body.action_version)||body.action_version<0||!uuid.test(body.operation_id??''))throw new StorageFailure('memory_extraction_request_invalid');
    value=await (run![2]==='pause'?this.service.pause(run![1]!,body.action_version,body.operation_id):this.service.continue(run![1]!,body.action_version,body.operation_id));
   }else{if(req.method!=='GET'||run![1]!=='current'&&!uuid.test(run![1]!))throw new StorageFailure('memory_extraction_request_invalid');value=await this.service.read(run![1]==='current'?undefined:run![1]);}
   send(res,200,value);
  }catch(error){const code=error instanceof StorageFailure?error.code:'memory_extraction_request_invalid';send(res,code.includes('not_found')?404:code==='memory_extraction_request_invalid'?400:409,{error:code});}
  return true;
 }
}
