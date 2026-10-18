import { isUuid } from '../uuid';
import type { ActiveMemory, MemoryContent, MemoryCorrectionReview, MemoryEvent, MemoryEventEvidence, MemorySource, MemoryVersion, PendingMemoryCandidate } from '../../shared/memory-bridge';
import { readCurrentStatus } from './current-status';

const categories = ['common_fact', 'preference', 'taboo', 'recent_state', 'relationship_note'] as const;
const topics = ['health', 'work', 'family', 'travel', 'finance', 'study', 'emotion', 'other'] as const;
const invalid = () => new Error('资料响应不可用。');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function identifier(value: unknown): string {
  if (!isUuid(value)) throw invalid();
  return value.toLowerCase();
}
function optionalIdentifier(value: unknown): string | null { return value == null ? null : identifier(value); }
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw invalid();
  return value;
}
function enumeration<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalid();
  return value as T;
}
function date(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw invalid();
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw invalid();
  return value;
}
function versionAvailability(entry: Record<string, unknown>) {
  for (const key of ['can_revert_auto_update', 'version_evidence_source_current']) {
    if (entry[key] !== undefined && typeof entry[key] !== 'boolean') throw invalid();
  }
  return { retirementReason: enumeration(entry.retirement_reason === undefined ? 'unknown' : entry.retirement_reason,
      ['unknown', 'error_correction', 'state_changed'] as const),
    retiredAt: date(entry.retired_at === undefined ? null : entry.retired_at),
    canRevertAutoUpdate: entry.can_revert_auto_update === true,
    versionEvidenceSourceCurrent: entry.version_evidence_source_current === true };
}
function eventEvidence(value: unknown): MemoryEventEvidence[] {
  if (!Array.isArray(value)) throw invalid();
  return value.map((entry) => {
    if (!record(entry) || Object.keys(entry).length !== 3
      || !Object.keys(entry).every((key) => ['message_id', 'char_start', 'char_end'].includes(key))) throw invalid();
    const charStart = integer(entry.char_start), charEnd = integer(entry.char_end, 1);
    if (charEnd <= charStart) throw invalid();
    return { messageId: identifier(entry.message_id), charStart, charEnd };
  });
}
function memoryEvent(value: unknown): MemoryEvent | null {
  if (value == null) return null;
  const keys = ['version', 'stage', 'stage_verified', 'stage_evidence', 'occurrence_start', 'occurrence_end',
    'occurrence_verified', 'occurrence_evidence'];
  if (!record(value) || Object.keys(value).length !== keys.length || !Object.keys(value).every((key) => keys.includes(key))
    || value.version !== 1 || typeof value.stage_verified !== 'boolean' || typeof value.occurrence_verified !== 'boolean') throw invalid();
  const stage = enumeration(value.stage, ['planned', 'agreed', 'rescheduled', 'cancelled', 'occurred', 'unknown'] as const);
  const stageEvidence = eventEvidence(value.stage_evidence), occurrenceEvidence = eventEvidence(value.occurrence_evidence);
  const occurrenceStart = date(value.occurrence_start), occurrenceEnd = date(value.occurrence_end);
  if ((occurrenceStart === null && occurrenceEnd !== null)
    || (occurrenceStart && occurrenceEnd && Date.parse(occurrenceEnd) < Date.parse(occurrenceStart))
    || (value.stage_verified && (stage === 'unknown' || stageEvidence.length === 0))
    || (value.occurrence_verified && (occurrenceStart === null || occurrenceEvidence.length === 0))) throw invalid();
  return { version: 1, stage, stageVerified: value.stage_verified, stageEvidence, occurrenceStart, occurrenceEnd,
    occurrenceVerified: value.occurrence_verified, occurrenceEvidence };
}
function content(entry: Record<string, unknown>): MemoryContent {
  const timing = entry.timing;
  if (!record(timing) || typeof timing.source_time_complete !== 'boolean'
    || !Array.isArray(entry.source_ids) || entry.source_ids.length === 0
    || !Array.isArray(entry.risk_flags) || typeof entry.confidence !== 'number'
    || !Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) throw invalid();
  const sourceStartedAt = date(timing.source_started_at);
  const sourceEndedAt = date(timing.source_ended_at);
  if ((sourceStartedAt === null) !== (sourceEndedAt === null)
    || (timing.source_time_complete && sourceStartedAt === null)
    || (sourceStartedAt && sourceEndedAt && Date.parse(sourceEndedAt) < Date.parse(sourceStartedAt))) throw invalid();
  return {
    text: text(entry.text), category: enumeration(entry.category, categories), topic: enumeration(entry.topic, topics),
    sourceIds: entry.source_ids.map(identifier), confidence: entry.confidence, riskFlags: entry.risk_flags.map(text),
    timing: { recordedAt: date(timing.recorded_at), sourceStartedAt, sourceEndedAt, sourceTimeComplete: timing.source_time_complete,
      ...readCurrentStatus(timing) },
    validAt: date(entry.valid_at), invalidAt: date(entry.invalid_at),
    event: memoryEvent(entry.event),
  };
}
function entries(value: unknown, key: string): Record<string, unknown>[] {
  if (!record(value) || !Array.isArray(value[key])) throw invalid();
  const list = value[key] as unknown[];
  if (!list.every(record)) throw invalid();
  return list;
}
function distinct<T>(items: T[], id: (item: T) => string): T[] {
  if (new Set(items.map(id)).size !== items.length) throw invalid();
  return items;
}

// 当前列表与主动打开的历史分别读取；来源 UUID 不解释为文件路径。
export function activeMemories(value: unknown, level: 'contact' | 'owner', contactId: string | null): ActiveMemory[] {
  return distinct(entries(value, 'memories').map((entry) => {
    if (entry.level !== level || entry.status !== 'active'
      || (level === 'contact' && identifier(entry.contact_id) !== contactId)) throw invalid();
    return {
      ...content(entry), memoryId: identifier(entry.memory_id), level, status: 'active' as const,
      adoptionMethod: enumeration(entry.adoption_method, ['auto', 'manual'] as const), revision: integer(entry.revision, 1),
      supersedesMemoryId: optionalIdentifier(entry.supersedes_memory_id),
      sourceCandidateId: optionalIdentifier(entry.source_candidate_id),
      ...versionAvailability(entry),
    };
  }), (entry) => entry.memoryId);
}
export function pendingCandidates(value: unknown): PendingMemoryCandidate[] {
  return distinct(entries(value, 'candidates').map((entry) => {
    if (entry.status !== 'pending') throw invalid();
    return { ...content(entry), candidateId: identifier(entry.candidate_id), status: 'pending' as const,
      subject: enumeration(entry.subject, ['self', 'contact', 'shared'] as const),
      ...(entry.correction_review === undefined ? {} : { correctionReview: correctionReviews(entry.correction_review) }) };
  }), (entry) => entry.candidateId);
}
export function memoryVersions(value: unknown, level: 'contact' | 'owner', contactId: string): MemoryVersion[] {
  const versions = distinct(entries(value, 'versions').map((entry) => {
    if (entry.level !== level || (level === 'contact' && identifier(entry.contact_id) !== contactId)) throw invalid();
    return { ...content(entry), memoryId: identifier(entry.memory_id), level,
      status: enumeration(entry.status, ['active', 'invalidated'] as const),
      adoptionMethod: enumeration(entry.adoption_method, ['auto', 'manual'] as const), revision: integer(entry.revision, 1),
      supersedesMemoryId: optionalIdentifier(entry.supersedes_memory_id), sourceCandidateId: optionalIdentifier(entry.source_candidate_id),
      ...versionAvailability(entry) };
  }), (entry) => entry.memoryId);
  for (let index = 1; index < versions.length; index++) {
    if (versions[index].status !== 'invalidated' || versions[index - 1].supersedesMemoryId !== versions[index].memoryId) throw invalid();
  }
  return versions;
}
function correctionReviews(value: unknown): MemoryCorrectionReview[] {
  if (!Array.isArray(value) || value.length === 0) throw invalid();
  return distinct(value.map((entry) => {
    if (!record(entry) || !Array.isArray(entry.new_message_ids) || entry.new_message_ids.length === 0
      || !Array.isArray(entry.new_source_ids) || entry.new_source_ids.length === 0) throw invalid();
    const decision = enumeration(entry.decision, ['corrected', 'rejected'] as const);
    const correctedText = entry.corrected_text === null ? null : text(entry.corrected_text);
    if ((decision === 'corrected') !== (correctedText !== null)) throw invalid();
    return { decisionId: identifier(entry.decision_id), decision, previousText: text(entry.previous_text), correctedText,
      newMessageIds: entry.new_message_ids.map(identifier), newSourceIds: entry.new_source_ids.map(identifier),
      semanticRelation: enumeration(entry.semantic_relation, ['same', 'uncertain'] as const), reason: text(entry.reason) };
  }), (entry) => entry.decisionId);
}
export function memorySources(value: unknown): MemorySource[] {
  return distinct(entries(value, 'sources').map((entry) => {
    if (entry.file_name !== null && typeof entry.file_name !== 'string') throw invalid();
    return { sourceId: identifier(entry.source_id), fileName: entry.file_name, recordCount: integer(entry.record_count),
      status: enumeration(entry.status, ['active', 'delete_requested', 'deleting', 'delete_failed', 'deleted'] as const) };
  }), (entry) => entry.sourceId);
}
