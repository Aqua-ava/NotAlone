/** 固定目标的一次 HTTP；无 SDK 重试、重定向或正文改写。 */
import assert from 'node:assert/strict';
import {request as httpsRequest} from 'node:https';
import {request as httpRequest,validateHeaderValue} from 'node:http';
import {sha} from './attempt-journal.mjs';
export const ENDPOINTS=Object.freeze({messages:'https://api.deepseek.com/anthropic/v1/messages',
  strict_chat:'https://api.deepseek.com/beta/chat/completions',chat:'https://api.deepseek.com/chat/completions'});
export const PATHS=Object.freeze({messages:'/anthropic/v1/messages',strict_chat:'/beta/chat/completions',chat:'/v1/chat/completions'});
const n=x=>Number.isSafeInteger(x)&&x>=0?x:null;
function envelope(route,status,bytes){
  const text=bytes.toString('utf8');let values=[],malformed=false;
  try{values=[JSON.parse(text)];}catch{for(const line of text.split('\n'))if(line.startsWith('data:')){
    const payload=line.slice(5).trim();if(payload==='[DONE]'){values.push({done:true});continue;}
    try{values.push(JSON.parse(payload));}catch{malformed=true;}
  }}
  const ok=status>=200&&status<300;let complete=false;
  if(route==='messages')complete=ok&&!malformed&&values.at(-1)?.type==='message_stop'&&values.some(v=>v.type==='message_start')&&values.some(v=>v.type==='message_delta')&&!values.some(v=>v.type==='error');
  else complete=ok&&!malformed&&(values.at(-1)?.done===true||values.length===1&&values[0].choices?.length>0&&values[0].choices.every(c=>typeof c.finish_reason==='string'&&c.finish_reason.length>0));
  let model='unknown',fingerprint='unknown',rawUsage={};
  for(const v of values){model=v.model??v.message?.model??model;fingerprint=v.system_fingerprint??fingerprint;Object.assign(rawUsage,v.message?.usage??{},v.usage??{});}
  const input=n(rawUsage.input_tokens??rawUsage.prompt_tokens),output=n(rawUsage.output_tokens??rawUsage.completion_tokens);
  const read=n(rawUsage.cache_read_input_tokens??rawUsage.prompt_cache_hit_tokens),write=n(rawUsage.cache_creation_input_tokens);
  const usage=input!==null&&output!==null?{input_tokens:route==='messages'&&read!==null&&write!==null?input+read+write:input,
    output_tokens:output,cache_read_tokens:read,cache_write_tokens:write,input_tokens_complete:route!=='messages'||read!==null&&write!==null}:null;
  return {terminal_status:complete?'complete':ok?'unknown':'failed',response_model:model,response_fingerprint:fingerprint,usage,cost:null,
    cost_unknown_reason:'no_verified_price_snapshot_injected',usage_unknown_reason:usage&&usage.input_tokens_complete?null:'protocol_usage_incomplete'};
}
function onceRequest({target,route,raw,headers,signal,timeoutMs=120000,requestImpl}){
  return new Promise(resolve=>{
    const phases={dispatch_write_invoked_at:new Date().toISOString(),first_protocol_event_at:null,first_model_delta_at:null},chunks=[];let outgoing,finished=false,status=null,contentType=null,physical=false,timer,pending='';
    const finish=(transportError=null)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      const bytes=Buffer.concat(chunks);phases.transport_finished_at=new Date().toISOString();
      const result=envelope(route,status??0,bytes);
      if(transportError)result.terminal_status='unknown';
      resolve({...result,physical_attempted:physical,http_status:status,content_type:contentType,raw_response:bytes.toString('utf8'),
        response_sha256:sha(bytes),transport_error:transportError,transport_timeline:phases});};
    const abort=()=>{outgoing?.destroy(Error('transport_cancelled'));finish('transport_cancelled');};
    try{
      signal?.throwIfAborted();
      outgoing=requestImpl(target,{method:'POST',headers,agent:false},incoming=>{
        status=incoming.statusCode;contentType=incoming.headers['content-type']??null;phases.response_headers_at=new Date().toISOString();
        incoming.on('data',part=>{phases.first_response_byte_at??=new Date().toISOString();chunks.push(Buffer.from(part));
          if(contentType?.includes('text/event-stream')){pending+=Buffer.from(part).toString('utf8');const lines=pending.split('\n');pending=lines.pop();
            for(const line of lines)if(line.startsWith('data:')){const text=line.slice(5).trim();try{const event=JSON.parse(text);
              phases.first_protocol_event_at??=new Date().toISOString();
              if(event.type==='content_block_delta'||event.choices?.some(c=>c.delta?.content||c.delta?.tool_calls))phases.first_model_delta_at??=new Date().toISOString();
            }catch{}}
          }
        });
        incoming.on('end',()=>finish());incoming.on('error',()=>finish('response_transport_failed'));incoming.on('aborted',()=>finish('response_aborted'));
      });
      outgoing.on('error',()=>finish('request_transport_failed'));signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>{outgoing.destroy(Error('transport_timeout'));finish('transport_timeout');},timeoutMs);
      signal?.throwIfAborted();physical=true;outgoing.end(Buffer.from(raw,'utf8'));
    }catch{outgoing?.destroy();finish('request_dispatch_failed');}
  });
}
export function createOfficialTransport({resolveCredential,timeoutMs=120000}){
  assert.equal(typeof resolveCredential,'function','root_credential_resolver_required');
  return Object.freeze({mode:'official',async prepare({route}){
    assert.ok(Object.hasOwn(ENDPOINTS,route),'transport_route_unknown');
    const key=await resolveCredential({endpoint:ENDPOINTS[route],route});
    assert.ok(typeof key==='string'&&key.trim()===key&&key&&!/[\r\n]/.test(key),'root_credential_unavailable');validateHeaderValue('authorization','Bearer '+key);
    const headers={'content-type':'application/json',authorization:'Bearer '+key,...route==='messages'?{'anthropic-version':'2023-06-01',accept:'text/event-stream'}:{accept:'application/json'}};
    return Object.freeze({async send({raw,signal}){return onceRequest({target:ENDPOINTS[route],route,raw,signal,headers:{...headers,'content-length':Buffer.byteLength(raw)},timeoutMs,requestImpl:httpsRequest});}});
  }});
}
export function createLoopbackTransport({origin,timeoutMs=5000}){
  const url=new URL(origin);assert.ok(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port&&url.pathname==='/'&&!url.search&&!url.hash&&!url.username&&!url.password,'exact_loopback_origin_required');
  return Object.freeze({mode:'loopback_synthetic',async prepare({route}){
    assert.ok(Object.hasOwn(PATHS,route),'transport_route_unknown');
    return Object.freeze({async send({raw,signal}){return onceRequest({target:url.origin+PATHS[route],route,raw,signal,
      headers:{'content-type':'application/json','content-length':Buffer.byteLength(raw)},timeoutMs,requestImpl:httpRequest});}});
  }});
}
