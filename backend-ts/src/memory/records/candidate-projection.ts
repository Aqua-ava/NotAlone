import type { Client } from 'pg';
import { candidateDigest, dimensionSourcesCurrent } from '../overview/evidence/dimensions.ts';
import { sha } from '../overview/evidence/sources.ts';
import { normalizeConditions, normalizeEvent, normalizeEvolution } from '../overview/projection/metadata.ts';
import { projectTiming, pythonISO } from '../overview/projection/time.ts';
import { protectCandidate, type MemoryRow } from './mutations/protection.ts';

const names = ['subject','time','truth_intent','paraphrase','reference','media','reported'];
const capabilities: Record<string,string> = {subject_binding:'subject',event_preservation:'paraphrase',reference_resolution:'reference',
  direct_attribution:'reported',reported_attribution:'reported',temporal_preservation:'time'};
const sameSet = (a: unknown[],b: unknown[]): boolean => [...new Set(a)].sort().join('|') === [...new Set(b)].sort().join('|');

/** 只投影已存依据；valid 不代表自动采纳许可或真实模型质量。 */
export function boundedDimensionStates(candidate: MemoryRow, sourceCurrent: boolean, now=Date.now()): MemoryRow {
  const evidence=candidate.dimension_evidence;
  if (!evidence) return Object.fromEntries(names.map(name=>[name,{required:true,state:'unknown',reason:'not_proven'}]));
  const required=new Set(['subject','truth_intent','paraphrase','reference','reported']);
  if(candidate.valid_at || candidate.invalid_at || candidate.category==='recent_state' || [2,3,4].includes(evidence.version)) required.add('time');
  if(evidence.messages.some((item:MemoryRow)=>candidate.source_ids.includes(item.message_id)&&(item.message_type!=='text'||item.text_representation!=='text'))
    || (evidence.media??[]).some((item:MemoryRow)=>item.representation!=='text')) required.add('media');
  const valid=new Set<string>();
  // 原 bounded_dimension_states 构造的 ExtractedFact 不含 event/conditions。
  const projectedFact={...candidate,event:null,conditions:null};
  const current=sourceCurrent && (evidence.version===4)===(candidate.source_dependency_mode==='all')
    && candidateDigest(projectedFact,evidence.version)===evidence.candidate_sha256 && evidence.pragmatics
    && (!candidate.invalid_at || Date.parse(candidate.invalid_at)>now);
  if(current) {
    const pragmatics=evidence.pragmatics, alternatives=candidate.alternatives??[], messages=new Map<string,MemoryRow>(evidence.messages.map((item:MemoryRow)=>[item.message_id,item]));
    if(pragmatics.speech_act==='assertion'&&pragmatics.assertion_status==='asserted'&&pragmatics.figurative_type==='literal'&&!alternatives.length) valid.add('truth_intent');
    if(evidence.version!==4&&candidate.invalid_at&&evidence.messages.filter((item:MemoryRow)=>candidate.source_ids.includes(item.message_id)).every((item:MemoryRow)=>item.occurred_at!==null)) valid.add('time');
    const alignments=evidence.paraphrase??[];
    if(alignments.length&&sameSet(alignments.map((item:MemoryRow)=>item.source.message_id),candidate.source_ids)
      &&alignments.every((item:MemoryRow)=>item.candidate.start===0&&item.candidate.end===[...candidate.text_content].length
        &&item.source.span.start===0&&item.source.span.end===messages.get(item.source.message_id)?.text_length
        &&item.candidate.sha256===item.source.span.sha256&&item.candidate.sha256===sha(candidate.text_content))) valid.add('paraphrase');
    const refs=evidence.reference??[], targets=new Set(refs.map((item:MemoryRow)=>`${item.target.message_id}/${item.target.span.start}/${item.target.span.end}`));
    const subjectMatches=candidate.subject==='shared'?sameSet(refs.map((item:MemoryRow)=>messages.get(item.target.message_id)?.sender),['self','contact'])
      :refs.every((item:MemoryRow)=>messages.get(item.target.message_id)?.sender===candidate.subject);
    if(evidence.version===1&&refs.length&&!alternatives.length&&refs.every((item:MemoryRow)=>item.subject===candidate.subject)
      &&subjectMatches&&targets.size===(candidate.subject==='shared'?2:1)) {valid.add('reference');valid.add('subject');}
    const reported=evidence.reported??[], relationship=pragmatics.speech_act==='report'||pragmatics.assertion_status==='reported'?'reported':'direct';
    if(evidence.version===1&&reported.length&&reported.every((item:MemoryRow)=>item.relationship===relationship)) valid.add('reported');
    if(evidence.version===2&&evidence.semantic_basis) {
      for(const name of ['paraphrase','reference','subject','reported']) valid.add(name);
      if(evidence.semantic_basis.qualifiers.some((item:MemoryRow)=>item.kind==='time')) valid.add('time');
    }
    if(evidence.version===3&&evidence.semantic_basis) {
      const mapping:Record<string,string>={author_binding:'subject',arrival_event_preservation:'paraphrase',author_self_reference:'reference',direct_attribution:'reported',recency_preservation:'time'};
      for(const capability of evidence.semantic_basis.capabilities) if(mapping[capability]) valid.add(mapping[capability]);
    }
    if(evidence.version===4&&evidence.semantic_basis&&!alternatives.length) for(const capability of evidence.semantic_basis.capabilities) if(capabilities[capability]) valid.add(capabilities[capability]);
    const media=evidence.media??[];
    if(sameSet(media.map((item:MemoryRow)=>item.message_id),candidate.source_ids)&&media.every((item:MemoryRow)=>
      item.representation===(item.message_type==='text'?'text':'processed_text')&&item.representation===messages.get(item.message_id)?.text_representation
      &&(evidence.version!==4||item.message_type==='text'&&item.representation==='text'))) valid.add('media');
  }
  return Object.fromEntries(names.map(name=>[name,{required:required.has(name),state:!sourceCurrent?'stale':valid.has(name)?'valid':'unknown',
    reason:!sourceCurrent?'source_changed_or_candidate_changed':valid.has(name)?null:'not_proven'}]));
}

export async function candidatePayload(client: Client, row: MemoryRow): Promise<MemoryRow> {
  const current=await dimensionSourcesCurrent(client,row);
  const protection=await protectCandidate(client,row,{validateGeneration:false});
  const candidate=protection.row, event=normalizeEvent(candidate.event), conditions=normalizeConditions(candidate.conditions), evolution=normalizeEvolution(candidate.evolution);
  if(event) {event.stage_verified=Boolean(event.stage_verified&&current);event.occurrence_verified=Boolean(event.occurrence_verified&&current);}
  if(conditions) conditions.items=conditions.items.map((item:MemoryRow)=>({...item,source_supported:Boolean(item.source_supported&&current)}));
  if(evolution) delete evolution.proof;
  const payload:MemoryRow={...(candidate.source_dependency_mode==='all'?{source_dependency_mode:'all'}:{}),
    candidate_id:candidate.id,text:candidate.text_content,category:candidate.category,topic:candidate.topic,subject:candidate.subject,
    status:candidate.status,source_ids:candidate.source_ids,confidence:candidate.confidence,risk_flags:candidate.risk_flags??[],
    failure_reason:candidate.failure_reason??null,timing:await projectTiming(client,candidate),event,conditions,evolution,
    valid_at:pythonISO(candidate.valid_at),invalid_at:pythonISO(candidate.invalid_at)};
  if(candidate.alternatives?.length) payload.alternatives=candidate.alternatives;
  if(protection.reviews.length) payload.correction_review=protection.reviews;
  if(candidate.interpretation_reason?.trim()) payload.interpretation_reason=candidate.interpretation_reason;
  if(candidate.dimension_evidence) {payload.dimension_evidence=candidate.dimension_evidence;payload.dimension_evidence_source_current=current;}
  if(candidate.source_dependency_mode==='all') payload.dimension_evidence_dimensions=boundedDimensionStates(candidate,current);
  return payload;
}

// 调用方提供只读 REPEATABLE READ 事务，防止同一次列表混合来源世代。
export async function listMemoryCandidates(client: Client, owner: string, contact: string): Promise<MemoryRow[]> {
  const rows=(await client.query("SELECT to_jsonb(c) AS value FROM public.memory_candidate c WHERE owner_id=$1 AND contact_id=$2 AND status='pending' ORDER BY created_at,id",[owner,contact])).rows;
  const result:MemoryRow[]=[];
  for(const row of rows) {const value=await candidatePayload(client,row.value);if(value.status==='pending') result.push(value);}
  return result;
}
