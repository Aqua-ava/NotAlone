/** 仅外部供应商替身：按实际正常E/V请求返回固定合成工具协议。 */
import assert from 'node:assert/strict';
const verificationFields=['category','topic','scene_name','alternatives','interpretation_reason','valid_at','invalid_at','speech_act','assertion_status','figurative_type','event','conditions'];
export function positiveSupplier(){
 const windows=[],verifications=[],messages=new Map(),errors=[];
 const fact=message=>{const subject=message.sender==='self'?'self':'contact';return {text:message.text.replace(/^我/,subject==='self'?'用户':'联系人'),subject,category:'common_fact',topic:'other',source_message_ids:[message.message_id],confidence:0.8,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'保留合成原句明确陈述。',event:null,conditions:null};};
 const handler=async(req,res)=>{
  try{
   let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
   if(req.url==='/beta/chat/completions'){
    assert.equal(req.headers.authorization,'Bearer synthetic-only');assert.equal(body.stream,false);
    assert.equal(body.tools[0].function.name,'SourceVerificationOutput');assert.equal(body.tools[0].function.strict,true);
    const payload=JSON.parse(body.messages.find(message=>message.role==='user').content);verifications.push({body,payload});
    const facet=()=>({verdict:'supported',evidence_indices:[0]});
    const output={request_fingerprint:payload.request_fingerprint,results:payload.candidates.map((candidate,candidate_index)=>{
     const message=messages.get(candidate.source_message_ids[0]);assert.ok(message);
     return {candidate_index,verdict:'supported',issues:[],evidence:[{message_id:message.message_id,quote:message.text}],claim_check:{version:2,field_checks:Object.fromEntries(verificationFields.map(field=>[field,facet()])),parts:[{candidate_span:{start:0,end:[...candidate.text].length},attribution:{...facet(),scope_subject:candidate.subject,actor_kind:candidate.subject,resolution:'explicit',subject_mentions:[{kind:'first_person',evidence_index:0,source_span:{start:0,end:1},candidate_span:{start:0,end:candidate.subject==='self'?2:3}}]},arguments_and_relation:facet(),temporal_and_modality:facet()}]}};
    })};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:`synthetic-v-${verifications.length}`,object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[{id:`synthetic-v-tool-${verifications.length}`,type:'function',function:{name:'SourceVerificationOutput',arguments:JSON.stringify(output)}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:5,completion_tokens:9,prompt_cache_hit_tokens:0}}));return;
   }
   assert.equal(req.headers['x-api-key'],'synthetic-only');assert.equal(body.tools[0].name,'DirectMemoryExtractionOutput');
   const user=body.messages.find(message=>message.role==='user').content.find(block=>block.type==='text').text;
   const payload=JSON.parse(user);windows.push({body,payload});for(const message of payload.messages)messages.set(message.message_id,message);
   const output={scenes:[{scene_name:'合成长期资料',memories:payload.messages.map(fact)}]};
   const events=[{type:'message_start',message:{id:`synthetic-e-${windows.length}`,type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:3,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'tool_use',id:`synthetic-e-tool-${windows.length}`,name:'DirectMemoryExtractionOutput',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(output)}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:7}},{type:'message_stop'}];
   res.setHeader('Content-Type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  }catch(error){errors.push(error instanceof Error?error.message:'synthetic_supplier_failed');res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'synthetic_supplier_contract_failed'}));}
 };
 return {handler,windows,verifications,errors};
}
