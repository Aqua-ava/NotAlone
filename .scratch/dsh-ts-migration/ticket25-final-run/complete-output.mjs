/** 原结果JSON全部保留；PG复读只核实际可验证的候选／范围／技能字段。 */
import assert from 'node:assert/strict';
export const completeOutput=result=>structuredClone(result);
const skillFields=['skill_id','skill_version_id','skill_name','skill_selection_method','skill_selection_reason','skill_load_state','skill_loaded_resources'];

export function verifyPersistedOutput(result,candidateSnapshot,requestSnapshot,scope){
 assert.equal(result.reply_request_id,requestSnapshot.id);
 for(const key of ['owner_id','contact_id','conversation_binding_id'])assert.equal(requestSnapshot[key],scope[key],'请求PG范围不一致');
 const candidates=candidateSnapshot.map(candidate=>{
  assert.equal(candidate.reply_request_id,result.reply_request_id);
  for(const key of ['owner_id','contact_id','conversation_binding_id'])assert.equal(candidate[key],scope[key],'候选PG范围不一致');
  return {candidate_id:candidate.candidate_id,text:candidate.text,basis:candidate.basis,citation_ids:candidate.citation_ids,risk_notes:candidate.risk_notes,messages:candidate.messages};
 });
 assert.deepEqual(candidates,result.candidates,'完整候选与PG复读不一致');
 // 当前固定材料明示skill_disabled；未来带Skill必须另接真实完整Skill复读，不能猜造。
 assert.ok(Object.hasOwn(result,'used_skill')&&result.used_skill===null,'本先导只支持实际禁用Skill的完整结果');
 for(const key of skillFields)assert.ok(Object.hasOwn(requestSnapshot,key)&&requestSnapshot[key]===null,'禁用Skill的PG字段不是实际null：'+key);
 return completeOutput(result);
}
