/** 宿主私有 A 段入口；只接原任务/trace身份，正文从原PG窗口核验读取。 */
import type {IncomingMessage,ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {readWechatHttpBody} from '../../sync/wechat-http-body.ts';
import {ExtractionBatchError,type ExtractionBatchInput,type ExtractionBatchWireOutcome} from './service.ts';
import {ExtractionAdoptionError,type ExtractionAdoptionResult} from '../adoption/service.ts';
import {decodeExtractionArguments} from './arguments.ts';

export function createExtractionBatchHttp(options:{
 token:string;
 execute(input:ExtractionBatchInput,signal:AbortSignal):Promise<ExtractionBatchWireOutcome>;
 executeWithAdoption?(input:ExtractionBatchInput,signal:AbortSignal):Promise<{
  outcome:ExtractionBatchWireOutcome;
  adoption:ExtractionAdoptionResult|null;
 }>;
}){
 if(!options.token)throw new Error('extraction_private_token_missing');
 return {async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  if(!(req.url??'').startsWith('/internal/extraction'))return false;
  const respond=(status:number,value:unknown)=>{if(res.destroyed)return;res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  const supplied=Buffer.from(req.headers.authorization??''),expected=Buffer.from(`Bearer ${options.token}`);
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){respond(401,{error:'unauthorized'});return true;}
  const bRoute=req.url==='/internal/extraction/run-b';
  if((req.url!=='/internal/extraction/run'&&!bRoute)||req.method!=='POST'
    ||bRoute&&!options.executeWithAdoption){respond(404,{error:'not_found'});return true;}
  const stopping=new AbortController(),abort=()=>stopping.abort();req.once('aborted',abort);res.once('close',abort);
  try{
   let input:ExtractionBatchInput;
   try{const bytes=await readWechatHttpBody(req,32768);input=decodeExtractionArguments(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown as ExtractionBatchInput;}
   catch{respond(400,{error:'extraction_batch_invalid'});return true;}
   if(bRoute)respond(200,await options.executeWithAdoption!(input,stopping.signal));
   else respond(200,{outcome:await options.execute(input,stopping.signal)});
  }catch(error){
   const code=error instanceof ExtractionBatchError||error instanceof ExtractionAdoptionError
    ?error.code:'extraction_batch_unavailable';
   respond(['extraction_batch_invalid','adoption_request_invalid','adoption_a_result_invalid'].includes(code)?400:
    code==='extraction_batch_unavailable'||code==='extraction_adoption_unavailable'?503:409,{error:code});
  }finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
  return true;
 }};
}
