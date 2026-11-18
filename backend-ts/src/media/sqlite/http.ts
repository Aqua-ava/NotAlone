import type {IncomingMessage,ServerResponse} from 'node:http';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {readHttpBody,HttpBodyError} from '../../platform/http/body.ts';
import type {SqliteMediaService} from './service.ts';
import type {MediaGoal} from './contracts.ts';
import { sendJson } from '../../platform/http/json.ts';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
async function body(req:IncomingMessage):Promise<Record<string,unknown>> {
 const value=JSON.parse((await readHttpBody(req,2048,10_000)).toString('utf8')||'{}');
 if(!value||typeof value!=='object'||Array.isArray(value))throw new StorageFailure('media_request_invalid');return value;
}
/** 调用前由正常宿主统一Bearer/无Origin认证；owner永远由服务持有。 */
export class SqliteMediaHttp {
 private readonly service:SqliteMediaService;
 constructor(service:SqliteMediaService){this.service=service;}
 async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const url=new URL(req.url??'/','http://localhost');
  const message=/^\/api\/contacts\/([^/]+)\/messages\/([^/]+)\/media(?:\/files\/([^/]+)\/preview)?$/.exec(url.pathname);
  const preview=/^\/api\/media\/previews\/([^/]+)$/.exec(url.pathname);
  if(!message&&!preview)return false;
  try{
   if(url.search||[...(message?.slice(1).filter(Boolean)??[]),...(preview?.slice(1)??[])].some(v=>!uuid.test(v)))throw new StorageFailure('media_request_invalid');
   if(preview){
    const sessionId=preview[1]!.toLowerCase();
    if(req.method==='GET')sendJson(res,200,this.service.previewStatus(sessionId));
    else if(req.method==='DELETE'){await this.service.releasePreview(sessionId);sendJson(res,200,{released:true});}
    else sendJson(res,405,{error:'method_not_allowed'});
   }else{
    const contactId=message![1]!.toLowerCase(),messageId=message![2]!.toLowerCase(),fileId=message![3]?.toLowerCase();
    if(fileId){
     if(req.method!=='POST'){sendJson(res,405,{error:'method_not_allowed'});return true;}
     if(Object.keys(await body(req)).length)throw new StorageFailure('media_request_invalid');
     const result=await this.service.openPreview(contactId,messageId,fileId);
     if(res.destroyed){await this.service.releasePreview(result.sessionId);return true;}
     sendJson(res,200,result);
    }else if(req.method==='GET')sendJson(res,200,await this.service.read(contactId,messageId));
    else if(req.method==='POST'){
     const value=await body(req);
     if(Object.keys(value).sort().join(',')!=='goal,request_key'||typeof value.request_key!=='string'||!uuid.test(value.request_key)||!['extract','audio_conversion'].includes(String(value.goal)))throw new StorageFailure('media_request_invalid');
     const controller=new AbortController(),abort=()=>controller.abort();req.once('aborted',abort);
     try{sendJson(res,200,await this.service.extract(contactId,messageId,{requestKey:value.request_key,goal:value.goal as MediaGoal},controller.signal));}finally{req.removeListener('aborted',abort);}
    }else if(req.method==='DELETE'){
     const key=req.headers['idempotency-key'];if(typeof key!=='string'||!uuid.test(key))throw new StorageFailure('media_request_invalid');
     sendJson(res,200,await this.service.clear(contactId,messageId,key));
    }else sendJson(res,405,{error:'method_not_allowed'});
   }
  }catch(error){
   const code=error instanceof StorageFailure?error.code:error instanceof HttpBodyError?error.code:error instanceof SyntaxError?'media_request_invalid':'media_request_failed';
   sendJson(res,error instanceof HttpBodyError?error.status:code==='media_request_invalid'?400:/not_found/.test(code)?404:409,{error:code});
  }
  return true;
 }
}
