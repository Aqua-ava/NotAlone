/** 审阅绑定实际输入/输出摘要，Agent 审阅不能升级为人工确认。 */
import {qualityConflict,qualityDigest,qualityInvalid,qualityKeys,SEMANTIC_DIMENSIONS,type QualityRow} from './organization-quality-contract.ts';

export function qualityReviewer(value:unknown):void {
  if(!qualityKeys(value,['kind','name'])||!['human','agent'].includes(value.kind)||typeof value.name!=='string'
    ||value.name.trim().length<1||[...value.name.trim()].length>120)qualityInvalid();
}
export function qualityDecision(value:unknown):void {if(value!=='approved'&&value!=='rejected')qualityInvalid();}
export function qualityHumanApproved(value:QualityRow|null|undefined):boolean {
  return Boolean(value?.reviewer?.kind==='human'&&typeof value.reviewer.name==='string'&&value.reviewer.name.trim()&&value.decision==='approved');
}
function references(value:unknown,row:QualityRow):void {
  if(!Array.isArray(value)||!value.length||value.some(ref=>!qualityKeys(ref,['memory_id','revision'])
    ||!Number.isSafeInteger(ref.revision)||!row.model_input.memories.some((memory:QualityRow)=>memory.memory_id===ref.memory_id&&memory.revision===ref.revision)))qualityInvalid();
}
export function qualityOutputItems(output:QualityRow|null):QualityRow[] {
  if(!output)return [];
  const items:QualityRow[]=[];
  for(const [index,scenario] of (output.l2?.scenarios??[]).entries()){
    const refs=scenario.paragraphs.flatMap((paragraph:QualityRow)=>paragraph.references);
    for(const name of ['title','hint'])items.push({path:`/l2/scenarios/${index}/${name}`,text:scenario[name],references:refs});
    for(const [paragraphIndex,paragraph] of scenario.paragraphs.entries())items.push({path:`/l2/scenarios/${index}/paragraphs/${paragraphIndex}`,...paragraph});
  }
  for(const [index,entry] of (output.l3?.entries??[]).entries())items.push({path:`/l3/entries/${index}`,...entry});
  return items;
}
export function qualityAnnotations(value:unknown,row:QualityRow):QualityRow {
  if(!qualityKeys(value,['input_sha256','reviewer','dimension','scenario_key','decision','supported_claims','prohibited_claims',
    'independence_notes','empty_support_policy','verifier_challenges']))qualityInvalid();
  if(value.input_sha256!==row.input_sha256)qualityConflict();
  qualityReviewer(value.reviewer);qualityDecision(value.decision);
  if(!SEMANTIC_DIMENSIONS.includes(value.dimension)||typeof value.scenario_key!=='string'||[...value.scenario_key].length<1
    ||[...value.scenario_key].length>160||typeof value.independence_notes!=='string'||!value.independence_notes.trim()
    ||[...value.independence_notes].length>2000||!['normal','reject','uncertain_summary_allowed'].includes(value.empty_support_policy))qualityInvalid();
  for(const name of ['supported_claims','prohibited_claims']){
    const claims=value[name];
    if(!Array.isArray(claims)||claims.length>80)qualityInvalid();
    for(const claim of claims){
      if(!qualityKeys(claim,name==='supported_claims'?['claim_id','text','references','allowed_layers','required_qualifiers']:['claim_id','text','reason'])
        ||['claim_id','text'].some(key=>typeof claim[key]!=='string'||!claim[key].trim()||[...claim[key]].length>4000))qualityInvalid();
      if(name==='supported_claims'){
        references(claim.references,row);
        if(!Array.isArray(claim.allowed_layers)||!claim.allowed_layers.length||claim.allowed_layers.some((layer:unknown)=>!['l2','l3'].includes(String(layer)))
          ||!Array.isArray(claim.required_qualifiers)||claim.required_qualifiers.some((item:unknown)=>typeof item!=='string'||[...item].length>1000))qualityInvalid();
      }else if(typeof claim.reason!=='string'||!claim.reason.trim())qualityInvalid();
    }
  }
  if(!value.verifier_challenges||typeof value.verifier_challenges!=='object'||Array.isArray(value.verifier_challenges)
    ||Object.keys(value.verifier_challenges).some(key=>key!=='l2'&&key!=='l3'))qualityInvalid();
  for(const challenge of Object.values(value.verifier_challenges))if(!qualityKeys(challenge,['proposal','expected_supported'])||challenge.expected_supported!==false)qualityInvalid();
  return structuredClone(value);
}
export function qualityOutputReview(value:unknown,row:QualityRow):QualityRow {
  if(!qualityKeys(value,['output_sha256','reviewer','decision','claims','projection_passed','verifier_challenges_reviewed'])||!row.output_payload)qualityInvalid();
  if(value.output_sha256!==qualityDigest(row.output_payload))qualityConflict();
  qualityReviewer(value.reviewer);qualityDecision(value.decision);
  const paths=new Set(qualityOutputItems(row.output_payload).map(item=>item.path));
  if(!Array.isArray(value.claims)||value.claims.length!==paths.size
    ||new Set(value.claims.map((claim:QualityRow)=>claim?.path)).size!==paths.size
    ||value.claims.some((claim:QualityRow)=>!paths.has(claim?.path))||typeof value.projection_passed!=='boolean'
    ||typeof value.verifier_challenges_reviewed!=='boolean')qualityInvalid();
  for(const claim of value.claims){
    if(!qualityKeys(claim,['path','supported','references','critical_errors','notes'])||typeof claim.supported!=='boolean'
      ||typeof claim.notes!=='string'||[...claim.notes].length>2000||!Array.isArray(claim.critical_errors)
      ||claim.critical_errors.some((error:unknown)=>![...SEMANTIC_DIMENSIONS,'scope','unsupported'].includes(String(error))))qualityInvalid();
    references(claim.references,row);
  }
  return structuredClone(value);
}
