import type { Client } from 'pg';
import { projectEvolution, projectVersionEvidence } from './contact-overview-versions.ts';
import { normalizeEvent, normalizeConditions } from './contact-overview-metadata.ts';
import { canonicalJSON, sha, validateFrozen, decisionAvailable } from './contact-overview-evidence.ts';

type Row = Record<string, any>;
// PostgreSQL JSON 时间保留微秒；不经过会截掉微秒的 JS Date 再序列化。
export { pythonISO } from './contact-overview-time.ts';
import { pythonISO, projectTiming } from './contact-overview-time.ts';
export function overviewRecordDigest(row: Row, evolution: Row | null = row.evolution ?? null,
  revision = row.revision, invalidAt = row.invalid_at): string {
  const body: Row = { memory_id: row.id, owner_id: row.owner_id, contact_id: row.contact_id ?? null,
    text_sha256: sha(row.text_content), category: row.category, topic: row.topic,
    source_ids: [...row.source_ids].sort(), source_candidate_id: row.source_candidate_id ?? null,
    adoption_method: row.adoption_method, revision, valid_at: pythonISO(row.valid_at), invalid_at: pythonISO(invalidAt),
    confidence: row.confidence, risk_flags: row.risk_flags, supersedes_memory_id: row.supersedes_memory_id ?? null,
    event: normalizeEvent(row.event) };
  if (evolution) body.evolution = { ...evolution, proof: evolution.proof ?? null };
  if (row.conditions) body.conditions = normalizeConditions(row.conditions);
  if (row.requires_all_sources) body.requires_all_sources = true;
  if (row.source_dependency_mode === 'all') body.source_dependency_mode = 'all';
  // Python confidence 是 float；整数值也需保留 .0 才能对齐旧版本绑定摘要。
  const confidence = Number(row.confidence);
  const floating = Number.isInteger(confidence) ? `${confidence}.0` : confidence !== 0 && Math.abs(confidence) < 0.0001
    ? confidence.toExponential().replace(/e([+-])(\d)$/, (_match, sign: string, digit: string) => `e${sign}0${digit}`) : String(confidence);
  const serialized = canonicalJSON(body, false, true).replace(/"confidence":-?[\d.eE+-]+(?=[,}])/, `"confidence":${floating}`);
  return sha(serialized);
}
export async function projectOverviewMemory(client: Client, row: Row): Promise<{
  payload: Row; recordDigest: string; timing: Row; eventCurrent: Row | null; versionEvidence: Row | null;
}> {
  const event = normalizeEvent(row.event), conditions = normalizeConditions(row.conditions);
  row = { ...row, event, conditions };
  const timing = await projectTiming(client, row);
  let eventBound = false, conditionsBound = false;
  if ((event || conditions) && row.source_candidate_id) {
    const candidate = (await client.query('SELECT to_jsonb(candidate) AS value FROM public.memory_candidate candidate WHERE owner_id=$1 AND contact_id=$2 AND id=$3', [row.owner_id,row.contact_id,row.source_candidate_id])).rows[0]?.value;
    if (candidate?.correction_evidence) {
      try {
        const { dimensionSourcesCurrent } = await import('./contact-overview-dimensions.ts');
        await validateFrozen(client,row.owner_id,candidate.correction_evidence);
        if (await dimensionSourcesCurrent(client,candidate) && await decisionAvailable(client,row.owner_id,candidate.correction_evidence)) {
          eventBound = canonicalJSON(normalizeEvent(candidate.event)) === canonicalJSON(event);
          conditionsBound = candidate.text_content === row.text_content && canonicalJSON(normalizeConditions(candidate.conditions)) === canonicalJSON(conditions);
        }
      } catch (error) { if (error && typeof error === 'object' && 'code' in error) throw error; }
    }
  }
  const eventCurrent = event ? { ...event, stage_verified: event.stage_verified && eventBound,
    occurrence_verified: event.occurrence_verified && eventBound } : null;
  const currentConditions = conditions ? { ...conditions, items: conditions.items.map((item: Row) => ({...item,source_supported:item.source_supported && conditionsBound})) } : null;
  const evolution = await projectEvolution(client,row);
  const version = await projectVersionEvidence(client,row,evolution.stored);
  const visibleEvolution = evolution.current ? Object.fromEntries(Object.entries(evolution.current).filter(([key])=>key!=='proof')) : null;
  const payload: Row = { ...(row.source_dependency_mode === 'all' ? { source_dependency_mode: 'all' } : {}),
    memory_id: row.id, level: 'contact', contact_id: row.contact_id, text: row.text_content,
    category: row.category, topic: row.topic, adoption_method: row.adoption_method, status: row.status,
    revision: row.revision, retirement_reason: row.retirement_reason, retired_at: pythonISO(row.retired_at),
    source_ids: row.source_ids, source_candidate_id: row.source_candidate_id ?? null, confidence: row.confidence,
    risk_flags: row.risk_flags, supersedes_memory_id: row.supersedes_memory_id ?? null,
    timing, event: eventCurrent, conditions: currentConditions, evolution: visibleEvolution, version_evidence: version.evidence,
    version_evidence_source_current: version.current, can_revert_auto_update: version.canRevert,
    valid_at: pythonISO(row.valid_at), invalid_at: pythonISO(row.invalid_at) };
  return { payload, recordDigest: overviewRecordDigest(row,evolution.current), timing, eventCurrent, versionEvidence: version.evidence };
}
