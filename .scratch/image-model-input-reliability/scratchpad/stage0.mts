// 仅用于授权图片的离线对照；正文、凭据、图片和原始异常均不输出或落盘。
import {readFileSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createRequire} from 'node:module';
import https from 'node:https';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {resolveHostReplyConfiguration} from '../../../backend-ts/src/host/host-reply-config.ts';
import {bindDiagnosticProblemBudget} from '../../../backend-ts/src/diagnostics/diagnostic-problem-budget.ts';
const require=createRequire(new URL('../../../backend-ts/package.json',import.meta.url));
const sharp=require('sharp');
const root=readFileSync('/tmp/notalone-image-reliability-location','utf8').trim();
const file=JSON.parse(readFileSync(`${root}/target.json`,'utf8'));
const original=readFileSync(readFileSync(`${root}/image-path.txt`,'utf8').trim());
if(createHash('sha256').update(original).digest('hex')!==file.content_digest)throw Error('source_digest_mismatch');
const environment={...process.env,...parseEnv(readFileSync(new URL('../../../.env',import.meta.url),'utf8'))};
const config=resolveHostReplyConfiguration(environment);
if(config.status!=='configured')throw Error('configured_model_required');
const auth=await config.provider.resolveAuth(config.provider.connection);
const base=config.provider.connection.baseURL.replace(/\/+$/,'');
const endpoint=`${base.endsWith('/v1')?base:base+'/v1'}/messages`;
const budget=bindDiagnosticProblemBudget();
if(!budget)throw Error('diagnostic_budget_binding_required');
const variants=new Map<string,{data:Buffer;mime:string;width:number;height:number}>();
for(const [name,format,edge] of [['original','png',0],['jpeg85','jpeg',0],['edge1536','png',1536],['edge1024','png',1024]] as const){
 let data=original;
 if(name!=='original'){
  let pipe=sharp(original).rotate().toColourspace('srgb');
  if(edge)pipe=pipe.resize({width:edge,height:edge,fit:'inside',withoutEnlargement:true});
  data=await (format==='jpeg'?pipe.flatten({background:'#ffffff'}).jpeg({quality:85}):pipe.png()).toBuffer();
 }
 const meta=await sharp(data).metadata();variants.set(name,{data,mime:format==='jpeg'?'image/jpeg':'image/png',width:meta.width,height:meta.height});
}
const codes=new Set(['UND_ERR_SOCKET','ECONNRESET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','ENOTFOUND','EAI_AGAIN','CERT_HAS_EXPIRED','ECONNREFUSED','ABORT_ERR']);
function failure(error:any){
 const chain=[];let current=error;
 for(let i=0;current&&i<5;i++,current=current.cause){
  chain.push({name:['TypeError','Error','AbortError','TimeoutError'].includes(current.name)?current.name:'other',code:codes.has(current.code)?current.code:null,
   category:/other side closed/i.test(String(current.message))?'socket_other_side_closed':/reset/i.test(String(current.message))?'socket_reset':/timeout|timed out/i.test(String(current.message))?'timeout':/fetch failed/i.test(String(current.message))?'fetch_failed':'other'});
 }
 return chain;
}
const cases=[['original',1,'fetch'],['original',1,'fresh'],['jpeg85',1,'fetch'],['edge1536',1,'fetch'],['edge1024',1,'fetch'],['jpeg85',1,'fresh'],['original',2,'fetch'],['original',3,'fetch']] as const;
const results:any[]=[];
for(let index=0;index<cases.length;index++){
 const [variant,count,transport]=cases[index],image=variants.get(variant)!;
 const body=JSON.stringify({model:config.model.model,stream:true,max_tokens:32,temperature:0,thinking:{type:'disabled'},messages:[{role:'user',content:[
  {type:'text',text:`授权图片传输对照 ${index+1}。仅回复 OK，不描述图片。`},...Array.from({length:count},()=>({type:'image',source:{type:'base64',media_type:image.mime,data:image.data.toString('base64')}}))]}]});
 const headers={...auth.headers,'content-type':'application/json',accept:'text/event-stream','anthropic-version':'2023-06-01','x-deepseek-harness-user-id':'notalone-image-reliability-diagnostic'};
 const signal=AbortSignal.timeout(60000),check=budget.reserve();check();
 const start=performance.now();let status:number|null=null,stopped=false,streamError=false,reusedSocket:boolean|null=null,connected:boolean|null=null;
 let error:any;
 const consume=(text:string)=>{if(/event:\s*message_stop/.test(text)||/"type"\s*:\s*"message_stop"/.test(text))stopped=true;if(/event:\s*error/.test(text))streamError=true;};
 try{
  if(transport==='fetch'){
   const response=await fetch(endpoint,{method:'POST',headers,body,signal,redirect:'error'});status=response.status;
   consume(await response.text());
  }else{
   await new Promise<void>((resolve,reject)=>{
    const req=https.request(endpoint,{method:'POST',headers:{...headers,'content-length':Buffer.byteLength(body)},agent:false,signal},res=>{
     status=res.statusCode??null;reusedSocket=req.reusedSocket;res.setEncoding('utf8');let tail='';
     res.on('data',chunk=>{consume(tail+chunk);tail=String(chunk).slice(-128);});res.on('end',resolve);res.on('error',reject);
    });
    req.on('socket',socket=>{connected=false;socket.on('secureConnect',()=>{connected=true;});});
    req.on('error',e=>{reusedSocket=req.reusedSocket;reject(e);});req.end(body);
   });
  }
 }catch(e){error=failure(e);}
 const row={case:index+1,variant,count,transport,width:image.width,height:image.height,imageBytes:image.data.length,requestBytes:Buffer.byteLength(body),
  status,success:status!==null&&status>=200&&status<300&&stopped&&!streamError,transportFailure:status===null,elapsedMs:Math.round(performance.now()-start),reusedSocket,connected,streamStopped:stopped,streamError,cause:error??[]};
 results.push(row);writeFileSync(`${root}/stage0-results.json`,JSON.stringify(results,null,2),{mode:0o600});process.stdout.write(JSON.stringify(row)+'\n');
}
for(const v of variants.values())v.data.fill(0);
