/** 外部模型桩使用现行完整命题合同，不绕过程序侧语义和来源核验。 */
export const verificationPolicy={id:'complete-claim-v1',rule_version:'a'.repeat(64)};
const fields=['category','topic','scene_name','alternatives','interpretation_reason','valid_at','invalid_at','speech_act','assertion_status','figurative_type','event','conditions'];
export function completeClaimRow(candidate,row,window){
 const refs=row.evidence??[],indices=refs.map((_,index)=>index);
 const facet={verdict:'supported',evidence_indices:indices};
 const actor=candidate.subject==='self'?'self':candidate.subject==='shared'?'shared':'contact';
 const label=actor==='self'?'用户':'联系人';
 const candidateStart=Array.from(candidate.text.slice(0,candidate.text.indexOf(label))).length;
 const mentions=[];
 if(candidate.text.includes(label))for(const [index,ref] of refs.entries()){
  const message=window.messages.find(message=>message.message_id===ref.message_id);
  for(const [word,kind] of [['我','first_person'],['你','second_person']]){
   const inferred=kind==='first_person'?message?.sender:message?.sender==='self'?'contact':'self';
   if(inferred!==actor||!ref.quote.includes(word))continue;
   const start=Array.from(ref.quote.slice(0,ref.quote.indexOf(word))).length;
   mentions.push({kind,evidence_index:index,source_span:{start,end:start+1},candidate_span:{start:candidateStart,end:candidateStart+Array.from(label).length}});
   break;
  }
  if(mentions.length)break;
 }
 return {...row,claim_check:{version:2,field_checks:Object.fromEntries(fields.map(field=>[field,facet])),parts:[{
  candidate_span:{start:0,end:Array.from(candidate.text).length},
  attribution:{...facet,scope_subject:actor==='self'?'self':'contact',actor_kind:actor,
   resolution:mentions.length?'explicit':'unique_context',subject_mentions:mentions},
  arguments_and_relation:facet,temporal_and_modality:facet,
 }]}};
}
