/** 固定runner的本机假供应商：只生成合成SSE，不连接外部或读预算／凭据。 */
import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
function payload(body){
 const found=[];
 const visit=value=>{
  if(Array.isArray(value)){value.forEach(visit);return;}
  if(value&&typeof value==='object'){if(Array.isArray(value.evidence)&&value.fidelity_contract)found.push(value);Object.values(value).forEach(visit);return;}
  if(typeof value!=='string')return;
  let parsed;try{parsed=JSON.parse(value);}catch{const first=value.indexOf('{'),last=value.lastIndexOf('}');if(first<0||last<=first)return;try{parsed=JSON.parse(value.slice(first,last+1));}catch{return;}}
  if(parsed!==value)visit(parsed);
 };
 visit(body);if(found.length!==1)throw Error('local_provider_unique_payload');return found[0];
}
export function createLocalForwarder(faults={}){
 let sent=0;
 return async({arm,body,res,call,cancel})=>{
  call.upstream_send_ordinal=++sent;call.response_started_at=new Date().toISOString();
  call.response_model='deepseek-flash';call.response_fingerprint=null;
  const configured=faults[arm],fault=Array.isArray(configured)?configured.find(item=>item.case_id===call.case_id&&item.repeat===call.repeat)?.action:configured;
  if(fault==='cancel'){
   if(arm!=='new')throw Error('local_cancel_requires_new_arm');
   await cancel();res.destroy();call.response_complete=false;return;
  }
  if(fault==='provider_failure'){res.statusCode=503;res.end('{"error":"synthetic_provider_failure"}');call.response_complete=false;return;}
  const input=payload(body),candidate={text:'这次先不参加了，谢谢邀请。',basis:'仅依据本次合成输入。',citation_ids:[input.evidence[0].evidence_id],risk_notes:['本机合成验证，不代表模型质量。']};
  const output=fault==='invalid_output'?{candidates:[]}:{used_skill_version_id:null,candidates:[candidate]};
  const usage={input_tokens:32,output_tokens:16,reasoning_tokens:0,cache_hit_tokens:0,cache_miss_tokens:32};
  let raw;
  if(arm==='new'){
   const events=[{type:'message_start',message:{id:'local-fixture',model:'deepseek-flash',usage:{input_tokens:32,output_tokens:0,cache_read_input_tokens:0}}},
    {type:'content_block_start',index:0,content_block:{type:'tool_use',id:'local-tool',name:'ReplyRuntimeOutput',input:{}}},
    {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(output)}},
    {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:16}},{type:'message_stop'}];
   raw=events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  }else{
   const base={id:'local-fixture',object:'chat.completion.chunk',created:1,model:'deepseek-flash'};
   const chunks=[{...base,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'local-tool',type:'function',function:{name:'ReplyRuntimeOutput',arguments:JSON.stringify(output)}}]},finish_reason:null}]},
    {...base,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]},
    {...base,choices:[],usage:{prompt_tokens:32,completion_tokens:16,total_tokens:48,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:32}}];
   raw=chunks.map(chunk=>`data: ${JSON.stringify(chunk)}\n\n`).join('')+'data: [DONE]\n\n';
  }
  call.response_raw_utf8=raw;call.response_sha256=sha(raw);call.response_complete=true;call.usage=usage;
  call.cost={amount:0.000048,currency:'USD',price_snapshot_sha256:sha('local-fixture-price-only')};
  call.usage_kind='local_fixture_response_not_provider_billing';
  res.setHeader('content-type','text/event-stream');res.end(raw);
 };
}
