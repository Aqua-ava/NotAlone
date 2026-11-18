import type {IncomingMessage,ServerResponse} from 'node:http';
import {readHttpBody} from '../../platform/http/body.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {SqliteMemoryExtraction} from './service.ts';
import { sendJson } from '../../platform/http/json.ts';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** 认证函数来自唯一宿主；owner和固定输入不能由HTTP指定。 */
export class SqliteMemoryExtractionHttp {
 private service:SqliteMemoryExtraction;private authorize:(req:IncomingMessage)=>boolean;
 private readonly schedule:()=>Promise<unknown>;
 constructor(service:SqliteMemoryExtraction,authorize:(req:IncomingMessage)=>boolean,schedule=()=>service.readSchedule()){this.service=service;this.authorize=authorize;this.schedule=schedule;}
 async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const url=new URL(req.url??'/','http://localhost');
  if(!url.pathname.startsWith('/api/memory-processing/'))return false;
  if(!this.authorize(req)||req.headers.origin!==undefined){sendJson(res,401,{error:'unauthorized'});return true;}
  if(url.pathname==='/api/memory-processing/schedule'){
   if(req.method!=='GET'||url.search){sendJson(res,400,{error:'memory_extraction_request_invalid'});return true;}
   try{sendJson(res,200,await this.schedule());}catch{sendJson(res,409,{error:'memory_extraction_schedule_unavailable'});}return true;
  }
  if(url.pathname==='/api/memory-processing/automatic'){
   // 记忆自动处理总开关：GET 读取当前值，POST 以唯一布尔字段设置；owner 与范围不由请求指定。
   try{
    if(url.search)throw new StorageFailure('memory_extraction_request_invalid');
    if(req.method==='GET'){sendJson(res,200,this.service.readAutomatic());return true;}
    if(req.method!=='POST')throw new StorageFailure('memory_extraction_request_invalid');
    const body=JSON.parse((await readHttpBody(req,512,10_000)).toString('utf8')||'null');
    if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).join(',')!=='enabled'||typeof body.enabled!=='boolean')throw new StorageFailure('memory_extraction_request_invalid');
    sendJson(res,200,await this.service.setAutomatic(body.enabled));
   }catch(error){const code=error instanceof StorageFailure?error.code:'memory_extraction_request_invalid';sendJson(res,code==='memory_extraction_request_invalid'?400:409,{error:code});}
   return true;
  }
  const contact=/^\/api\/memory-processing\/contacts\/([a-f0-9-]{36})\/(current|history|readjudicate|complete)$/.exec(url.pathname);
  const task=/^\/api\/memory-processing\/tasks\/([a-f0-9-]{36})\/events$/.exec(url.pathname);
  const run=/^\/api\/memory-processing\/runs(?:\/(current|[a-f0-9-]{36})(?:\/(pause|continue|abandon-unknown|retry-images))?)?$/.exec(url.pathname);
  if(!contact&&!task&&!run){sendJson(res,404,{error:'memory_extraction_not_found'});return true;}
  try{
   if(url.search)throw new StorageFailure('memory_extraction_request_invalid');
   let value:unknown;
   if(contact){
    if(!uuid.test(contact[1]!))throw new StorageFailure('memory_extraction_request_invalid');
    if(contact[2]==='current'){if(req.method!=='GET')throw new StorageFailure('memory_extraction_request_invalid');value=await this.service.readContact(contact[1]!);}
    else if(contact[2]==='readjudicate'||contact[2]==='complete'){
     // 只让该联系人遗留的待处理候选重新进入裁决；不接收任何字段，范围由路径中的联系人固定。
     if(req.method!=='POST')throw new StorageFailure('memory_extraction_request_invalid');
     const body=JSON.parse((await readHttpBody(req,64,10_000)).toString('utf8')||'{}');
     if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).length)throw new StorageFailure('memory_extraction_request_invalid');
     value=await (contact[2]==='complete'?this.service.completeContact(contact[1]!):this.service.readjudicate(contact[1]!));
    }
    else{
     if(req.method!=='POST')throw new StorageFailure('memory_extraction_request_invalid');
     const body=JSON.parse((await readHttpBody(req,2048,10_000)).toString('utf8'));
     if(!body||Array.isArray(body)||Object.keys(body).join(',')!=='request_key'||!uuid.test(body.request_key))throw new StorageFailure('memory_extraction_request_invalid');
     value=await this.service.startHistory(contact[1]!,body.request_key);
    }
   }
   else if(task){if(req.method!=='GET'||!uuid.test(task[1]!))throw new StorageFailure('memory_extraction_request_invalid');value=await this.service.trace(task[1]!);}
   else if(!run![1]){
    if(req.method!=='POST')throw new StorageFailure('memory_extraction_request_invalid');
    const body=JSON.parse((await readHttpBody(req,2048,10_000)).toString('utf8'));
    if(!body||Array.isArray(body)||Object.keys(body).join(',')!=='request_key'||!uuid.test(body.request_key))throw new StorageFailure('memory_extraction_request_invalid');
    value=await this.service.start(body.request_key);
   }else if(run![2]){
    if(req.method!=='POST'||run![1]==='current'||!uuid.test(run![1]!))throw new StorageFailure('memory_extraction_request_invalid');
    const body=JSON.parse((await readHttpBody(req,1024,10_000)).toString('utf8')||'{}');
    const fields=body&&typeof body==='object'&&!Array.isArray(body)?Object.keys(body).sort().join(','):'';
    if(fields!=='action_version,operation_id'||!Number.isSafeInteger(body.action_version)||body.action_version<0||!uuid.test(body.operation_id??''))throw new StorageFailure('memory_extraction_request_invalid');
    value=await (run![2]==='pause'?this.service.pause(run![1]!,body.action_version,body.operation_id):run![2]==='abandon-unknown'?this.service.abandonUnknown(run![1]!,body.action_version,body.operation_id):run![2]==='retry-images'?this.service.retryImages(run![1]!,body.action_version,body.operation_id):this.service.continue(run![1]!,body.action_version,body.operation_id));
   }else{if(req.method!=='GET'||run![1]!=='current'&&!uuid.test(run![1]!))throw new StorageFailure('memory_extraction_request_invalid');value=await this.service.read(run![1]==='current'?undefined:run![1]);}
   sendJson(res,200,value);
  }catch(error){const code=error instanceof StorageFailure?error.code:'memory_extraction_request_invalid';sendJson(res,code.includes('not_found')?404:code==='memory_extraction_request_invalid'?400:409,{error:code});}
  return true;
 }
}
