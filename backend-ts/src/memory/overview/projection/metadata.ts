import { pythonISO, epochMicros } from './time.ts';
type Value = Record<string, any>;
const invalid = () => { throw new Error('关系资料元数据不符合既有合同。'); };
function fields(value: any, names: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...names].sort().join('|')) invalid();
}
function identifier(value: any) { if (typeof value !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)) invalid(); return value.toLowerCase(); }
function evidence(items: any): Value[] {
  if (!Array.isArray(items) || items.length > 8) invalid();
  return items.map((item: Value) => {
    fields(item, ['message_id','char_start','char_end']);
    if (!Number.isInteger(item.char_start) || !Number.isInteger(item.char_end) || item.char_start < 0
      || item.char_start >= item.char_end || item.char_end > 100000) invalid();
    return { ...item, message_id: identifier(item.message_id) };
  });
}
export function normalizeEvent(value: any): Value | null {
  if (value == null) return null;
  const base = ['version','stage','stage_evidence','occurrence_start','occurrence_end','occurrence_evidence','stage_verified','occurrence_verified'];
  fields(value, value.version === 2 ? [...base,'occurrence_precision','occurrence_expression','anchor_message_id'] : base);
  if (![1,2].includes(value.version) || !['planned','agreed','rescheduled','cancelled','occurred','unknown'].includes(value.stage)
    || typeof value.stage_verified !== 'boolean' || typeof value.occurrence_verified !== 'boolean') invalid();
  const result = { ...value, stage_evidence: evidence(value.stage_evidence), occurrence_evidence: evidence(value.occurrence_evidence),
    occurrence_start: pythonISO(value.occurrence_start), occurrence_end: pythonISO(value.occurrence_end) };
  for (const key of ['occurrence_start','occurrence_end']) if (value[key] !== null && (typeof value[key] !== 'string'
    || !/(Z|[+-]\d\d:\d\d)$/.test(value[key]) || !Number.isFinite(Date.parse(value[key])))) invalid();
  if (result.occurrence_end && (!result.occurrence_start || epochMicros(result.occurrence_end) <= epochMicros(result.occurrence_start))) invalid();
  if (value.stage_verified && (value.stage === 'unknown' || !result.stage_evidence.length)) invalid();
  if (value.occurrence_verified && (!result.occurrence_start || !result.occurrence_evidence.length)) invalid();
  if (value.version === 2) {
    if (!['year','month','day','instant','unknown'].includes(value.occurrence_precision)
      || (value.occurrence_precision === 'unknown' && result.occurrence_start !== null)
      || (value.occurrence_expression !== null && (typeof value.occurrence_expression !== 'string'
        || !value.occurrence_expression.trim() || [...value.occurrence_expression.trim()].length > 256))) invalid();
    result.anchor_message_id = value.anchor_message_id === null ? null : identifier(value.anchor_message_id);
  }
  return result;
}
export function normalizeConditions(value: any): Value | null {
  if (value == null) return null;
  fields(value,['version','items']);
  if (value.version !== 1 || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 8) invalid();
  return { version: 1, items: value.items.map((item: Value) => {
    fields(item,['text','evidence','source_supported']);
    if (typeof item.text !== 'string' || !item.text.trim() || [...item.text].length > 1000 || typeof item.source_supported !== 'boolean') invalid();
    const refs = evidence(item.evidence);
    if (item.source_supported && !refs.length) invalid();
    return { text: item.text, evidence: refs, source_supported: item.source_supported };
  }) };
}
export function normalizeEvolution(value: any): Value | null {
  if (value == null) return null;
  const base = ['version','kind','explanation','related_versions','evidence_message_ids','source_supported','claim_changed','condition_changed'];
  fields(value, Object.hasOwn(value,'proof') ? [...base,'proof'] : base);
  if (value.version !== 1 || !['supplement','state_change','error_correction','historical_supplement','unresolved_conflict','independent'].includes(value.kind)
    || typeof value.explanation !== 'string' || !value.explanation.trim() || [...value.explanation.trim()].length > 1000
    || !Array.isArray(value.related_versions) || !value.related_versions.length || value.related_versions.length > 8
    || !Array.isArray(value.evidence_message_ids) || value.evidence_message_ids.length > 60
    || ['source_supported','claim_changed','condition_changed'].some(key => typeof value[key] !== 'boolean')) invalid();
  const related = value.related_versions.map((item: Value) => { fields(item,['memory_id','revision']); if (!Number.isInteger(item.revision) || item.revision < 1) invalid(); return {memory_id:identifier(item.memory_id),revision:item.revision}; });
  const ids = value.evidence_message_ids.map(identifier);
  if (new Set(ids).size !== ids.length || new Set(related.map((item: Value)=>item.memory_id)).size !== related.length || (value.source_supported && !ids.length)) invalid();
  return {...value, related_versions: related,evidence_message_ids:ids,proof:value.proof ?? null};
}
