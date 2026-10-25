/** 无 oracle 的机械来源回显；只检验真正 SDK／业务合同，不判断语义质量。 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {hash} from './snapshot.mjs';
function payloadOf(body){const user=body.messages.find(m=>m.role==='user');const content=user?.content;const raw=typeof content==='string'?content:content?.find(b=>b.type==='text')?.text;return JSON.parse(raw??'{}');}
function textOf(m){return m.verbatim_text??m.text;}
function document(payload,lateText){const selected=payload.memories[0],ref={memory_id:selected.memory_id,revision:selected.revision};
  if(payload.layer==='l3'){const text=lateText??textOf(selected).split(/[，。]/u)[0];return {path:'profile.md',content:`# 长期背景\n\n<!-- ENTRY ${JSON.stringify({kind:'preference',section:'long_term_preferences',basis:'仅合成来源的机械回显，未做语义评分。',temporal_status:'uncertain',uncertainty:'当前状态未另行核实。',references:[ref]})} -->\n${text}`};}
  return {path:'synthetic-source.md',content:`<!-- META {"topic_key":"synthetic-source","title":"合成资料","hint":"逐字回显本次冻结来源"} -->\n\n${lateText??textOf(selected)}\n<!-- PERSONAL {"kind":"fact","section":"basic_information","basis":"仅回显本次来源","uncertainty":""} -->\n<!-- SOURCES ${JSON.stringify([ref])} -->`};
}
function legacyVerification(payload){const memories=new Map(payload.memories.map(m=>[m.memory_id,m]));const items=payload.proposal[payload.layer==='l3'?'entries':'scenarios'];
  return {items:items.map((item,index)=>({index,sha256:payload.verification_targets.find(t=>t.index===index).sha256,supported:true,contains_action_guidance:false,correction_respected:true,reasons:[],
    statements:(payload.layer==='l3'?[item]:item.paragraphs).map((statement,i)=>{const sources=statement.references.map(r=>({...r,quote:textOf(memories.get(r.memory_id))}));return {index:i,kind:statement.kind,support_type:['fact','preference'].includes(statement.kind)?'direct':statement.kind,supported:true,uncertainty_preserved:true,basis:'合成机械引用合同验证。',sources,
      temporal_basis:'current_unverified',temporal_references:[],claims:[{text:statement.text,sources,source_subjects:sources.map(r=>({memory_id:r.memory_id,revision:r.revision,subject_roles:['contact'],basis:'冻结文本的联系人前缀。'})),subject_role:'contact',subject_basis:'冻结文本明确为联系人自述。',supported:true,value_category:'enduring_fact_or_preference',relationship_impact:null,eligibility_basis:'合成文本中的长期偏好。'}]};})}))};
}
function reply(body,{lateText}={}){
  const payload=payloadOf(body),names=(body.tools??[]).map(t=>t.name??t.function?.name),isMessages=body.stream===true;
  let tool,args,text='{"synthetic":"complete"}';
  const assistant=body.messages.some(m=>m.role==='assistant');
  if(names.includes('write')||names.includes('read')){
    if(!assistant){tool='write';args=document(payload,lateText);}
    else if(names.includes('ProfileProposalComplete')){tool='ProfileProposalComplete';args={};}
  }else if(names.includes('ScenarioVerificationOutput')||names.includes('ProfileVerificationOutput')){
    tool=names.find(n=>n==='ScenarioVerificationOutput'||n==='ProfileVerificationOutput');const m=payload.memories[0],evidence=[{memory_id:m.memory_id,quote:textOf(m)}];
    args={results:tool==='ScenarioVerificationOutput'?[{scenario_index:0,paragraph_index:0,supported:true,evidence}]:[{entry_index:0,supported:true,evidence}]};
  }else if(payload.verification_targets)text=JSON.stringify(legacyVerification(payload));
  else if(payload.no_change_target)text=JSON.stringify({sha256:payload.no_change_target,supported:true,reasons:[]});
  else throw Error('synthetic_supplier_unrecognized_business_request');
  if(!isMessages)return {content_type:'application/json',raw_response:JSON.stringify({id:'synthetic-loopback',object:'chat.completion',model:'deepseek-flash',choices:[{index:0,finish_reason:tool?'tool_calls':'stop',message:{role:'assistant',content:tool?null:text,...(tool?{tool_calls:[{id:'synthetic-call',type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]}:{})}}],usage:{prompt_tokens:12,completion_tokens:9}}),tool,args};
  const events=[{type:'message_start',message:{id:'synthetic-loopback',type:'message',role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:12,output_tokens:0}}},
    ...(tool?[{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'synthetic-call',name:tool,input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}}]:
      [{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}]),
    {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn'},usage:{output_tokens:9}},{type:'message_stop'}];
  return {content_type:'text/event-stream',raw_response:events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),tool,args};
}
export async function startSyntheticSupplier({onRequest}){
  const requests=[];let current={};
  const server=createServer(async(req,res)=>{try{let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw),entry={path:req.url,raw_sha256:hash(raw),body,started_at:new Date().toISOString(),ordinal:requests.length+1,run_id:current.run?.run_id};requests.push(entry);
    if(current.mode==='http_failure'){await onRequest?.(entry);res.writeHead(503,{'content-type':'application/json'});res.end('{"error":{"message":"synthetic_503","type":"server_error"}}');entry.status=503;return;}
    const lateText=current.mode==='cancel'?current.run.material.input.events.find(e=>e.event==='synthetic_late_result')?.text:undefined;
    const response=reply(body,{lateText});if(current.mode==='cancel'&&requests.filter(r=>r.run_id===current.run.run_id).length===1){assert.equal(response.tool,'write');assert.ok(response.args.content.includes(lateText));await current.cancel();entry.cancel_committed_before_response=true;entry.late_mutating_payload_sha256=hash(response.args);}
    await onRequest?.(entry);entry.status=200;entry.response_sha256=hash(response.raw_response);res.writeHead(200,{'content-type':response.content_type});res.end(response.raw_response);
  }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"synthetic_reply_failed"}');requests.at(-1).error=String(error.stack??error);}});
  server.listen(0,'127.0.0.1');await once(server,'listening');return {origin:`http://127.0.0.1:${server.address().port}`,requests,setRun(run,mode,cancel){current={run,mode,cancel};},async close(){server.closeAllConnections();await new Promise(done=>server.close(done));}};
}
