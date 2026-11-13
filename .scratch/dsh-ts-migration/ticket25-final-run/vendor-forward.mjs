/** 首次一对专用透传：原bridge负责唯一reserve；这里仅核ACK，不创建/退款/重试。 */
import assert from 'node:assert/strict';
import {request as httpsRequest} from 'node:https';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const primary=JSON.parse(await readFile(new URL('./primary.json',import.meta.url),'utf8'));
const legacy=JSON.parse(await readFile(new URL('./legacy-system.json',import.meta.url),'utf8'));
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
const fail=code=>{throw new Error(code);};
export function takeCredential(env=process.env){const key=env.NOTALONE_DEEPSEEK_API_KEY;delete env.NOTALONE_DEEPSEEK_API_KEY;if(typeof key!=='string'||!key.trim()||/[\r\n]/.test(key))fail('vendor_credential_unavailable');return key;}
export function validateRequest({arm,path,raw,body}){
 const old=arm==='old';if(!old&&arm!=='new')fail('vendor_arm');
 if(path!==(old?'/python/chat/completions':'/anthropic/v1/messages')||canonical(JSON.parse(raw))!==canonical(body))fail('vendor_path_or_bytes');
 const fields=old?['model','stream','messages','max_tokens','stop','temperature','tool_choice','tools','top_p','thinking']:['model','stream','messages','max_tokens','thinking','system','temperature','stop_sequences','tools','tool_choice','top_p'];
 const allowedFields=old?fields:fields.filter(field=>!['top_p','stop_sequences','tool_choice'].includes(field));
 if(Object.keys(body).some(field=>!allowedFields.includes(field))||body.model!=='deepseek-flash'||body.max_tokens!==4096||body.temperature!==0||body.stream!==true||canonical(body.thinking)!=='{"type":"disabled"}')fail('vendor_effective_controls');
 if(old){
  if(body.top_p!==1||canonical(body.stop)!==canonical(primary.controls.stop)||canonical(body.tool_choice)!==canonical('required'))fail('vendor_effective_controls');
 }else{
  if(body.top_p!==undefined&&body.top_p!==1||body.stop_sequences!==undefined||body.tool_choice!==undefined&&canonical(body.tool_choice)!==canonical({type:'any'}))fail('vendor_effective_controls');
 }
 const system=old?body.messages[0]?.role==='system'&&body.messages[0]?.content:body.system;
 if(old?canonical(system)!==canonical(legacy.blocks):typeof system!=='string'||!system.trim())fail('vendor_system');
 const names=body.tools?.map(tool=>old?tool?.function?.name:tool?.name);
 // 282f43af 的新臂不挂 Skill，16 例也无 layered scenario；真实注册集为
 // 两个只读历史工具和结构化输出工具。不得为了对齐旧臂注入 read_file。
 const expectedNames=old?primary.tools.map(tool=>tool.name):['ReplyRuntimeOutput','conversation_query','conversation_search'];
 if(canonical(names)!==canonical(expectedNames))fail('vendor_client_tools');
 return old?'https://api.deepseek.com/chat/completions':'https://api.deepseek.com/anthropic/v1/messages';
}
function normalizedUsage(call,bytes){
 const text=bytes.toString('utf8'),messages=[];try{messages.push(JSON.parse(text));}catch{for(const line of text.split('\n'))if(line.startsWith('data: ')){try{messages.push(JSON.parse(line.slice(6)));}catch{}}}
 const usage={};for(const value of messages){if(typeof value.model==='string')call.response_model=value.model;if(typeof value.message?.model==='string')call.response_model=value.message.model;if(value.system_fingerprint)call.response_fingerprint=value.system_fingerprint;Object.assign(usage,value.message?.usage??{},value.usage??{});}
 const n=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
 call.response_usage=call.arm==='new'?messages.flatMap(value=>[value.message?.usage,value.usage].filter(value=>value&&typeof value==='object')):Object.keys(usage).length?usage:null;
 if(call.arm==='new'){
  const input=n(usage.input_tokens),output=n(usage.output_tokens),read=n(usage.cache_read_input_tokens),write=n(usage.cache_creation_input_tokens);
  call.usage=[input,output,read,write].every(value=>value!==null)
   ?{input_tokens:input+read+write,output_tokens:output,reasoning_tokens:null,cache_hit_tokens:read,cache_miss_tokens:input+write}
   :null;
  if(call.usage===null)call.usage_unknown_reason='anthropic_usage_incomplete';
 }else call.usage=call.response_usage?{input_tokens:n(usage.input_tokens??usage.prompt_tokens),output_tokens:n(usage.output_tokens??usage.completion_tokens),reasoning_tokens:n(usage.completion_tokens_details?.reasoning_tokens),cache_hit_tokens:n(usage.prompt_cache_hit_tokens),cache_miss_tokens:n(usage.prompt_cache_miss_tokens)}:null;
 if(call.usage&&[call.usage.input_tokens,call.usage.output_tokens,call.usage.cache_hit_tokens,call.usage.cache_miss_tokens].every(value=>value!==null)){
  const price=call.price_snapshot;
  call.cost={amount:(call.usage.cache_hit_tokens*price.cache_hit_usd_per_million+call.usage.cache_miss_tokens*price.cache_miss_usd_per_million+call.usage.output_tokens*price.output_usd_per_million)/1_000_000,currency:price.currency,price_snapshot_sha256:price.sha256};
 }else call.cost=null;
}
/** 终态只认协议终止事件；正文恰好像JSON不构成完整业务输出。 */
export function responseEnvelopeComplete(arm,status,raw){
 if(!Number.isInteger(status)||status<200||status>=300)return false;
 const text=Buffer.isBuffer(raw)?raw.toString('utf8'):String(raw);
 if(arm==='old'){
  const values=text.split('\n').map(line=>line.trim()).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim());
  if(values.at(-1)==='[DONE]')return true;
  try{
   const value=JSON.parse(text);
   return Array.isArray(value.choices)&&value.choices.length>0&&value.choices.every(choice=>choice&&typeof choice.finish_reason==='string'&&choice.finish_reason.length>0);
  }catch{return false;}
 }
 if(arm!=='new')return false;
 const events=[];
 for(const line of text.split('\n')){
  if(!line.startsWith('data: '))continue;
  try{events.push(JSON.parse(line.slice(6)));}catch{return false;}
 }
 if(!events.length||events.at(-1)?.type!=='message_stop'||events.some(event=>event?.type==='error'))return false;
 return events.some(event=>event?.type==='message_start')&&events.some(event=>event?.type==='message_delta');
}
/** 一次固定官方HTTPS，不跟随redirect；stream逐字写出，完整/中断原字节另存。 */
export function relayOfficial({target,raw,key,res,call,signal,priceSnapshot,requestImpl=httpsRequest}){
 if(!['https://api.deepseek.com/chat/completions','https://api.deepseek.com/anthropic/v1/messages'].includes(target))fail('vendor_official_endpoint_required');
 return new Promise((resolve,reject)=>{
  const chunks=[];let finished=false,upstream;const abort=()=>upstream?.destroy(new Error('vendor_forward_aborted'));
  const finalize=(error,transportEnded=false)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);res.off?.('close',downstreamClosed);const bytes=Buffer.concat(chunks),complete=transportEnded||responseEnvelopeComplete(call.arm,call.upstream_status,bytes);call.response_raw_base64=bytes.toString('base64');call.response_raw_utf8=bytes.toString('utf8');call.response_sha256=sha(bytes);call.response_complete=complete;call.price_snapshot=structuredClone(priceSnapshot);normalizedUsage(call,bytes);if(error&&!complete){call.forward_error='vendor_upstream_failed';reject(new Error('vendor_upstream_failed'));}else resolve();};
  const downstreamClosed=()=>{if(!res.writableFinished)abort();};
  const headers={'content-type':'application/json','content-length':Buffer.byteLength(raw),'authorization':'Bearer '+key,...target.includes('/anthropic/')?{'anthropic-version':'2023-06-01'}:{}};
  const timer=setTimeout(()=>{upstream?.destroy(new Error('vendor_total_timeout'));finalize(true);},10000);
  try{
   upstream=requestImpl(target,{method:'POST',headers},incoming=>{
    call.upstream_status=incoming.statusCode;call.response_started_at=new Date().toISOString();res.statusCode=incoming.statusCode;
    res.setHeader('content-type',incoming.headers['content-type']??'application/json');
    incoming.on('data',chunk=>{const bytes=Buffer.from(chunk);chunks.push(bytes);res.write(bytes);});
    incoming.on('end',()=>{res.end();finalize(incoming.statusCode<200||incoming.statusCode>=300,false);});
    incoming.on('error',()=>finalize(true));incoming.on('aborted',()=>finalize(true));
   });
   signal?.addEventListener('abort',abort,{once:true});res.on?.('close',downstreamClosed);upstream.on('error',()=>finalize(true));if(signal?.aborted)abort();else upstream.end(Buffer.from(raw,'utf8'));
  }catch{finalize(true);}
 });
}
export function createVendorForwarder({key,initialReceipt,acknowledge,send=relayOfficial,priceSnapshot,maxMinutes=120,now=()=>Date.now()}){
 if(!priceSnapshot||!Number.isFinite(priceSnapshot.cache_hit_usd_per_million)||!Number.isFinite(priceSnapshot.cache_miss_usd_per_million)||!Number.isFinite(priceSnapshot.output_usd_per_million)||priceSnapshot.currency!=='USD'||!/^[a-f0-9]{64}$/.test(priceSnapshot.sha256))fail('vendor_price_snapshot');
 if(!Number.isSafeInteger(initialReceipt?.max_reservations)||initialReceipt.max_reservations<1)fail('vendor_initial_ack');
 const max=initialReceipt.max_reservations;
 const valid=r=>r?.schema_version==='reply-budget-bridge-v1'&&r.action==='ack'&&r.reserved===false&&Number.isSafeInteger(r.used_reservations)&&r.used_reservations>=0&&r.max_reservations===max&&r.used_reservations<=max&&Number.isFinite(r.deadline)&&r.deadline*1000>now();
 if(!valid(initialReceipt))fail('vendor_initial_ack');
 const initial=structuredClone(initialReceipt),deadline=Math.min(initial.deadline*1000,now()+maxMinutes*60*1000),controller=new AbortController(),attempts=[];
 let last=initial.used_reservations,actual=0,closed=null,busy=false;
 const close=reason=>{closed??=reason;controller.abort();};
 async function forward(input){
  if(closed||busy){close('vendor_closed_or_concurrent');fail('vendor_closed_or_concurrent');}
  busy=true;const call=input.call;attempts.push(call);
  try{
   const target=validateRequest(input),receipt=await acknowledge();
   if(!valid(receipt)||receipt.deadline!==initial.deadline||receipt.max_reservations!==max||receipt.used_reservations!==last+1||receipt.used_reservations-initial.used_reservations>max||now()>=deadline)fail('vendor_fresh_reservation_required');
   last=receipt.used_reservations;call.reservation_ack={...receipt};call.upstream_target=target;call.upstream_send_ordinal=++actual;
   await send({...input,target,key,signal:controller.signal,priceSnapshot});
  }catch(error){
   // 单个上游流失败只结算当前逻辑运行；不重试原对，也不让单次网络失败吞掉剩余固定分母。
   if(!(error instanceof Error)||error.message!=='vendor_upstream_failed')close('vendor_boundary_rejected');
   throw error instanceof Error?error:new Error('vendor_boundary_rejected');
  }finally{busy=false;}
 }
 forward.close=close;
 return {forward,close,evidence:()=>structuredClone(attempts),summary:()=>({schema_version:'reply-vendor-first-pilot-forward-v1',initial_used_reservations:initial.used_reservations,last_ack_used_reservations:last,new_reservations_acknowledged:last-initial.used_reservations,actual_upstream_requests:actual,guard_closed:closed,deadline:initial.deadline,max_new_requests:max,automatic_retries:0,concurrency:1,actual_usage_cost_usd:attempts.length>0&&attempts.every(call=>Number.isFinite(call.cost?.amount))?attempts.reduce((total,call)=>total+call.cost.amount,0):null,price_snapshot:structuredClone(priceSnapshot),upstream_count_definition:'guarded HTTPS attempts; no remote receipt inferred',actual_supplier_received_count:null})};
}
