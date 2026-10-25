/** E/V 完整语义事件中性化；原请求、返回和运行绑定独立私有保留。 */
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {mkdir,writeFile,chmod,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {digest} from './material-adapter.mjs';
const metadata=new Set(['arm','commit','source_commit','candidate_commit','provider','model','model_name','model_fingerprint',
  'elapsed_ms','latency_ms','started_at','finished_at','recorded_at','called_at','ledger_entry_id','attempt_id','permit_id',
  'execution_id','a_execution_id','profile_hash','lock_hash','worker_id','lease_generation','source_code_hash',
  '_execution','capture_layer','configuration','versions','task_runtime','transport','provider_capture','model_parameters',
  'prompt_sha256','schema_sha256','executor','rule_version','input_sha256','task_id','request_id','batch_key',
  'b_execution_id','a_receipt','receipt','typescript_a_receipt','typescript_b_receipt','usage_metadata','response_metadata','model_accounting_owner']);
function category(stage){
  if(['model_request','model_response','model_error','adoption','window','batch_end','candidate_saved'].includes(stage))return stage;
  if(/^typescript_a_(?:begin|result|not_sent|superseded)$/.test(stage))return 'extraction_state';
  if(/^typescript_b_|adoption|watermark|arbitration|decision|candidate|memory_|confirmed|owner_memory|contact_memory/.test(stage))return 'business_decision';
  if(/verif|source_support/.test(stage))return 'verification_state';
  if(['timing','pragmatics','deleted_fingerprint','duplicate','similarity','adjudication','write_plan','write_result','ledger_call'].includes(stage))return 'business_decision';
  if(/parse|extract|batch_start|batch_begin|replay|failure|source|target|gate|context/.test(stage))return 'processing_state';
  throw Error('unmapped_trace_stage:'+stage);
}
function purpose(value){
  if(/verif/i.test(value??''))return 'verification';
  if(/extract/i.test(value??''))return 'extraction';
  return 'other';
}
export function neutralizeTrace(input){
  assert.ok(Array.isArray(input.events),'trace_events_required');
  const aliases=new Map(),privateAliases=[];
  for(const [key,value]of Object.entries(input.scope??{}))aliases.set(value,key==='owner_id'?'本人':'当前联系人');
  for(const [i,source]of (input.sources??[]).entries())for(const key of ['storage_id','message_id','memory_id'])
    if(source[key])aliases.set(source[key],`来源${i+1}:${key==='memory_id'?'资料':key==='message_id'?'消息':'记录'}`);
  const alias=value=>{
    if(!aliases.has(value)){const neutral=`记录${aliases.size+1}`;aliases.set(value,neutral);privateAliases.push({raw:value,neutral});}
    return aliases.get(value);
  };
  const literalText=new Set(['text','quote','text_content','verbatim_text','instruction','basis','description']);
  const rewrite=(value,field)=>{
    if(Array.isArray(value))return value.map(item=>rewrite(item,field));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
      .filter(([key])=>!metadata.has(key)).map(([key,child])=>[key,rewrite(child,key)]));
    if(typeof value!=='string')return value;
    if(literalText.has(field))return value;
    let text=value;
    for(const [raw,neutral]of aliases)text=text.replaceAll(raw,neutral);
    text=text.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,alias);
    // 保留正文逐字内容；不能用替换组件名的办法制造盲化或改写模型输出。
    return text;
  };
  const coverage={extraction_requests:0,extraction_responses:0,verification_requests:0,verification_responses:0};
  const hasRawResponse=p=>input.events.some(e=>e.stage==='model_response'&&purpose(e.payload?.purpose)===p);
  const semanticReturn=blocks=>({body:blocks.filter(b=>b.type==='text').map(b=>b.text??b.content??'').join(''),
    tool_calls:blocks.filter(b=>['tool-call','tool_call'].includes(b.type)).map(b=>({name:b.name,
      args:typeof b.arguments==='string'?parseJSON(b.arguments):b.arguments??b.args}))});
  function parseJSON(text){try{return JSON.parse(text);}catch{return {unparsed_arguments:text};}}
  const events=input.events.map((original,index)=>{
    let event=original;
    const returnedPurpose=original.stage==='extraction_return'?'extraction':original.stage==='verification_return'?'verification':null;
    if(returnedPurpose&&!hasRawResponse(returnedPurpose)&&Array.isArray(original.payload?.blocks))
      event={stage:'model_response',payload:{purpose:returnedPurpose,raw_output:semanticReturn(original.payload.blocks)}};
    else if(original.stage==='model_response'&&original.payload?.raw){
      const raw=original.payload.raw;
      event={stage:'model_response',payload:{purpose:original.payload.purpose,raw_output:{body:raw.content,
        tool_calls:(raw.tool_calls??[]).map(t=>({name:t.name,args:t.args})),invalid_tool_calls:raw.invalid_tool_calls??[]}}};
    }
    const stage=category(event.stage),p=purpose(event.payload?.purpose);
    if(stage==='model_request'&&p!=='other')coverage[`${p}_requests`]++;
    if(stage==='model_response'&&p!=='other')coverage[`${p}_responses`]++;
    return {position:index+1,stage,purpose:p,data:rewrite(event.payload)};
  });
  const visible={schema_version:'nonreply-neutral-ev-trace-v1',case_id:input.case_id,
    scope:{owner:'本人',contact:'当前联系人'},events,coverage,
    coverage_status:coverage.extraction_requests&&coverage.extraction_responses&&coverage.verification_requests&&coverage.verification_responses
      ?'ev_observed':'ev_incomplete_or_not_required_requires_explicit_review',
    semantic_review:'not_reviewed'};
  return {visible,binding:{arm:input.arm,commit:input.commit,raw_trace_sha256:digest(input.events),
    neutral_trace_sha256:digest(visible),aliases:privateAliases,redacted_metadata_keys:[...metadata],
    raw_semantic_output_modified:false,technical_identifiers_normalized:true}};
}
function shuffle(input){const result=[...input];for(let i=result.length-1;i>0;i--){const j=randomInt(i+1);[result[i],result[j]]=[result[j],result[i]];}return result;}
export async function writeTracePackets({records,directory,repositoryRoot}){
  const root=await realpath(repositoryRoot),destination=resolve(directory);
  await mkdir(destination,{mode:0o700,recursive:true});await chmod(destination,0o700);
  const actual=await realpath(destination);
  assert.ok(actual!==root&&!actual.startsWith(root+'/'),'private_trace_packet_required');
  const visible=[],bindings=[],excluded=[];
  for(const row of records){
    try{
      const normalized=neutralizeTrace(row),blindId=randomUUID();
      visible.push({blind_id:blindId,...normalized.visible});bindings.push({blind_id:blindId,...normalized.binding});
    }catch(error){excluded.push({case_id:row.case_id,arm:row.arm,status:'unknown',reason:error.message});}
  }
  for(const reviewer of ['reviewer-a','reviewer-b']){
    const path=join(destination,reviewer);await mkdir(path,{mode:0o700});
    await writeFile(join(path,'packet.json'),JSON.stringify({records:shuffle(visible),review_requirements:{independent_reviewers:2,
      third_on_disagreement:true,reviewer_model_version_required:true,scores:'not_assigned'}},null,2)+'\n',{flag:'wx',mode:0o600});
  }
  await writeFile(join(destination,'private-binding.json'),JSON.stringify({bindings,excluded},null,2)+'\n',{flag:'wx',mode:0o600});
  return {neutral_records:visible.length,excluded_records:excluded.length,ev_complete:visible.filter(r=>r.coverage_status==='ev_observed').length,
    independent_reviews_completed:0,semantic_quality_verified:false};
}
