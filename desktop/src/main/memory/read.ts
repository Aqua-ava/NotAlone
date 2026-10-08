import type { ActiveMemory, MemoryContent, MemorySource, PendingMemoryCandidate } from '../../shared/memory-bridge';

const categories = ['common_fact', 'preference', 'taboo', 'recent_state', 'relationship_note'] as const;
const topics = ['health', 'work', 'family', 'travel', 'finance', 'study', 'emotion', 'other'] as const;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const invalid = () => new Error('资料响应不可用。');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw invalid();
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
    timing: { recordedAt: date(timing.recorded_at), sourceStartedAt, sourceEndedAt, sourceTimeComplete: timing.source_time_complete },
    validAt: date(entry.valid_at), invalidAt: date(entry.invalid_at),
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

// 列表就是当前有效投影；不请求历史正文，不把混合来源 UUID 解释为文件路径。
export function activeMemories(value: unknown, level: 'contact' | 'owner', contactId: string): ActiveMemory[] {
  return distinct(entries(value, 'memories').map((entry) => {
    if (entry.level !== level || entry.status !== 'active'
      || (level === 'contact' && identifier(entry.contact_id) !== contactId)) throw invalid();
    return {
      ...content(entry), memoryId: identifier(entry.memory_id), level, status: 'active' as const,
      adoptionMethod: enumeration(entry.adoption_method, ['auto', 'manual'] as const), revision: integer(entry.revision, 1),
      supersedesMemoryId: optionalIdentifier(entry.supersedes_memory_id),
      sourceCandidateId: optionalIdentifier(entry.source_candidate_id),
    };
  }), (entry) => entry.memoryId);
}
export function pendingCandidates(value: unknown): PendingMemoryCandidate[] {
  return distinct(entries(value, 'candidates').map((entry) => {
    if (entry.status !== 'pending') throw invalid();
    return { ...content(entry), candidateId: identifier(entry.candidate_id), status: 'pending' as const,
      subject: enumeration(entry.subject, ['self', 'contact', 'shared'] as const) };
  }), (entry) => entry.candidateId);
}
export function memorySources(value: unknown): MemorySource[] {
  return distinct(entries(value, 'sources').map((entry) => {
    if (entry.file_name !== null && typeof entry.file_name !== 'string') throw invalid();
    return { sourceId: identifier(entry.source_id), fileName: entry.file_name, recordCount: integer(entry.record_count),
      status: enumeration(entry.status, ['active', 'delete_requested', 'deleting', 'delete_failed', 'deleted'] as const) };
  }), (entry) => entry.sourceId);
}
