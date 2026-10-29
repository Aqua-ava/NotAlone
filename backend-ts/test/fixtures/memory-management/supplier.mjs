import assert from 'node:assert/strict';
const semanticFields=['category','topic','scene_name','alternatives','interpretation_reason','valid_at','invalid_at','speech_act','assertion_status','figurative_type','event','conditions'];
const facet=(verdict='supported')=>({verdict,evidence_indices:[0]});
function fact(message){
 const subject=message.sender==='self'?'self':'contact';
 return {text:message.text.replace(/^我/,subject==='self'?'用户':'联系人'),subject,category:'common_fact',topic:'other',source_message_ids:[message.message_id],
  confidence:0.8,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],
  interpretation_reason:'保留合成原句明确陈述。',event:null,conditions:null};
}
export function supplier({negative=false}={}){
 const windows=[],sources=new Map(),purposes=[];
 const respond=async(request,input)=>{
  purposes.push({contactId:input.scope.contact_id,purpose:request.purpose});const payload=JSON.parse(request.user);let value;
  if(request.purpose==='extraction'){
   assert.equal(request.tool.name,'DirectMemoryExtractionOutput');
   windows.push({contactId:input.scope.contact_id,payload});
   for(const message of payload.messages)sources.set(message.message_id,{...message,contactId:input.scope.contact_id});
   value={scenes:[{scene_name:'合成长期资料',memories:payload.messages.map(fact)}]};
  }else{
   assert.equal(request.tool.name,'SourceVerificationOutput');
   value={request_fingerprint:payload.request_fingerprint,results:payload.candidates.map((candidate,candidate_index)=>{
    const message=sources.get(candidate.source_message_ids[0]);assert.equal(message.contactId,input.scope.contact_id);
    return {candidate_index,verdict:'supported',issues:[],evidence:[{message_id:message.message_id,quote:message.text}],
     claim_check:{version:2,field_checks:Object.fromEntries(semanticFields.map(field=>[field,facet()])),parts:[{
      candidate_span:{start:0,end:[...candidate.text].length},attribution:{...facet(),scope_subject:candidate.subject,actor_kind:candidate.subject,resolution:'explicit',
       subject_mentions:[{kind:'first_person',evidence_index:0,source_span:{start:0,end:1},candidate_span:{start:0,end:candidate.subject==='self'?2:3}}]},
      arguments_and_relation:facet(),temporal_and_modality:facet(negative?'uncertain':'supported'),
     }]}};
   })};
  }
  const blocks=[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify(value)}];
  await request.validateOutput(blocks);return {blocks};
 };
 return {respond,windows,sources,purposes};
}

