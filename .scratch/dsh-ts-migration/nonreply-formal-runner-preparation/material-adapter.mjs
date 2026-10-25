/** 不改冻结材料；主体与说话人分别适配，歧义保留 unknown。 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const stableId=value=>{const h=digest(`nonreply-formal-v1:${value}`);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export function adaptMaterial(run){
  const input=run.material.input;
  if(!input)return {as_of:null,extraction_messages:run.material.messages,existing_projection:null,existing_skill:null,sources:[],events:[]};
  assert.equal(input.synthetic_only,true,'synthetic_material_required');
  const sources=input.sources.map((s,index)=>{
    const speaker=/^(?:用户|另一条用户)/u.test(s.text)?'user':/^(?:联系人|另一条联系人)/u.test(s.text)?'contact':'unknown';
    const scoped=s.owner_id===input.scope.owner_id&&s.contact_id===input.scope.contact_id;
    return {...s,storage_id:stableId(`${run.case_id}:${run.repeat}:${s.source_id}`),
      memory_id:stableId(`${run.case_id}:${run.repeat}:${s.source_id}:memory`),
      message_id:stableId(`${run.case_id}:${run.repeat}:${s.source_id}:message`),
      speaker,speaker_evidence:'frozen_literal_author_prefix',speaker_evidence_sha256:digest(s.text),
      user_feedback:speaker==='user'&&/反馈方法|再次确认|修正方法/u.test(s.text),
      scoped,outbound_allowed:scoped&&s.state==='active',
      corrects_source_ids:/明确更正|明确修正/u.test(s.text)?input.sources.slice(0,index).map(s=>s.source_id):[]};
  });
  // 本冻结材料的 L2/L3 既有投影全部为 null；不凭空种入旧版本。
  const projection=input.existing_projection===null?null:structuredClone(input.existing_projection);
  const skill=input.existing_skill?{...structuredClone(input.existing_skill),
    storage_skill_id:stableId(input.existing_skill.skill_id),
    storage_version_id:stableId(`${input.existing_skill.skill_id}:v${input.existing_skill.version}`)}:null;
  return {schema_version:'nonreply-material-adaptation-v1',case_id:run.case_id,case_sha256:run.case_sha256,
    as_of:new Date(input.as_of).toISOString(),sources,existing_projection:projection,existing_skill:skill,
    events:structuredClone(input.events),original_material_sha256:digest(run.material),
    correction_semantics_review:'not_reviewed',speaker_ambiguities:sources.filter(s=>s.speaker==='unknown').map(s=>s.source_id)};
}
