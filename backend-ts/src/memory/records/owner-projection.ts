/** 本人资料沿owner来源投影，联系人仅用于管理视图过滤。 */
import type {Client} from 'pg';
import {normalizeEvent,normalizeConditions} from '../overview/projection/metadata.ts';
import {projectTiming,pythonISO} from '../overview/projection/time.ts';
import {projectEvolution,projectVersionEvidence} from '../overview/projection/versions.ts';
import {canonicalJSON,validateFrozen,decisionAvailable} from '../overview/evidence/sources.ts';
import {dimensionSourcesCurrent} from '../overview/evidence/dimensions.ts';
type Row=Record<string,any>;
export async function ownerMemoryPayload(client:Client,row:Row):Promise<Row> {
  const event=normalizeEvent(row.event),conditions=normalizeConditions(row.conditions);
  row={...row,event,conditions};
  let eventBound=false,conditionsBound=false;
  if((event||conditions)&&row.source_candidate_id) {
    const candidate=(await client.query('SELECT to_jsonb(c) AS value FROM public.memory_candidate c WHERE owner_id=$1 AND id=$2',[row.owner_id,row.source_candidate_id])).rows[0]?.value;
    if(candidate?.correction_evidence) {
      try {
        await validateFrozen(client,row.owner_id,candidate.correction_evidence);
        if(await dimensionSourcesCurrent(client,candidate)&&await decisionAvailable(client,row.owner_id,candidate.correction_evidence)) {
          eventBound=canonicalJSON(normalizeEvent(candidate.event))===canonicalJSON(event);
          conditionsBound=candidate.text_content===row.text_content&&canonicalJSON(normalizeConditions(candidate.conditions))===canonicalJSON(conditions);
        }
      } catch(error){if(error&&typeof error==='object'&&'code' in error)throw error;}
    }
  }
  const evolution=await projectEvolution(client,row);
  const version=await projectVersionEvidence(client,row,evolution.stored,'owner');
  return {...(row.source_dependency_mode==='all'?{source_dependency_mode:'all'}:{}),
    memory_id:row.id,level:'owner',text:row.text_content,category:row.category,topic:row.topic,
    adoption_method:row.adoption_method,status:row.status,revision:row.revision,
    retirement_reason:row.retirement_reason,retired_at:pythonISO(row.retired_at),supersedes_memory_id:row.supersedes_memory_id??null,
    source_ids:row.source_ids,source_candidate_id:row.source_candidate_id??null,confidence:row.confidence,risk_flags:row.risk_flags,
    timing:await projectTiming(client,row,'owner'),
    event:event?{...event,stage_verified:event.stage_verified&&eventBound,occurrence_verified:event.occurrence_verified&&eventBound}:null,
    conditions:conditions?{...conditions,items:conditions.items.map((item:Row)=>({...item,source_supported:item.source_supported&&conditionsBound}))}:null,
    evolution:evolution.current?Object.fromEntries(Object.entries(evolution.current).filter(([key])=>key!=='proof')):null,
    version_evidence:version.evidence,version_evidence_source_current:version.current,can_revert_auto_update:version.canRevert,
    valid_at:pythonISO(row.valid_at),invalid_at:pythonISO(row.invalid_at)};
}
