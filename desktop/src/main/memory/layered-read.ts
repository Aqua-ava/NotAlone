import type { LayeredMemory, LayeredMemoryProfile, LayeredMemoryReference, LayeredMemoryScenario } from '../../shared/memory-bridge';
import { isUuid } from '../uuid';
import { readCurrentStatus } from './current-status';

const invalid = () => new Error('主题资料响应不可用。');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw invalid();
  return value;
}
function text(value: unknown, maximum = 16000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw invalid();
  return value;
}
function identifier(value: unknown): string { if (!isUuid(value)) throw invalid(); return value.toLowerCase(); }
function date(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw invalid();
  return value;
}
function list<T>(value: unknown, parse: (entry: unknown) => T, maximum = 1000): T[] {
  if (!Array.isArray(value) || value.length > maximum) throw invalid();
  return value.map(parse);
}
function enumeration<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalid();
  return value as T;
}
function reference(value: unknown): LayeredMemoryReference {
  const entry = record(value), timing = record(entry.timing);
  const sourceStartedAt = date(timing.source_started_at), sourceEndedAt = date(timing.source_ended_at);
  if (typeof timing.source_time_complete !== 'boolean' || (sourceStartedAt === null) !== (sourceEndedAt === null)
    || (timing.source_time_complete && sourceStartedAt === null)
    || (sourceStartedAt && sourceEndedAt && Date.parse(sourceStartedAt) > Date.parse(sourceEndedAt))) throw invalid();
  return { memoryId: identifier(entry.memory_id), revision: integer(entry.revision, 1),
    provenanceKind: enumeration(entry.provenance_kind, ['manual_entry', 'source_supported']),
    timing: { recordedAt: date(timing.recorded_at), sourceStartedAt, sourceEndedAt,
      sourceTimeComplete: timing.source_time_complete, ...readCurrentStatus(timing) } };
}
function scenario(value: unknown): LayeredMemoryScenario {
  const entry = record(value), updatedAt = date(entry.updated_at);
  if (entry.system_generated !== true || updatedAt === null) throw invalid();
  const paragraphs = list(entry.paragraphs, (value) => {
    const paragraph = record(value), references = list(paragraph.references, reference);
    if (!references.length) throw invalid();
    return { text: text(paragraph.text), references };
  });
  if (!paragraphs.length) throw invalid();
  return { scenarioId: identifier(entry.scenario_id), versionId: identifier(entry.version_id), title: text(entry.title, 200),
    hint: text(entry.hint, 500), systemGenerated: true, updatedAt, paragraphs };
}
function profile(value: unknown): LayeredMemoryProfile | null {
  if (value === null) return null;
  const entry = record(value), updatedAt = date(entry.updated_at);
  if (entry.system_generated !== true || updatedAt === null) throw invalid();
  const entries = list(entry.entries, (value) => {
    const item = record(value), references = list(item.references, reference);
    if (!references.length || typeof item.uncertainty !== 'string' || item.uncertainty.length > 240
      || (item.temporal_status === 'uncertain' && !item.uncertainty.trim())) throw invalid();
    return { text: text(item.text), temporalStatus: enumeration(item.temporal_status, ['stable', 'historical', 'uncertain']),
      uncertainty: item.uncertainty, references };
  }, 100);
  if (!entries.length) throw invalid();
  return { versionId: identifier(entry.version_id), systemGenerated: true, updatedAt, entries };
}
export function layeredMemory(value: unknown, contactId: string): LayeredMemory {
  const entry = record(record(value).layered_memory), budget = record(entry.budget);
  if (entry.schema_version !== 2 || entry.scope_kind !== 'contact' || identifier(entry.contact_id) !== contactId
    || typeof entry.enabled !== 'boolean') throw invalid();
  const maxModelCalls = integer(budget.max_model_calls), modelCallsUsed = integer(budget.model_calls_used),
    modelCallsRemaining = integer(budget.model_calls_remaining);
  if (modelCallsUsed > maxModelCalls || modelCallsRemaining !== maxModelCalls - modelCallsUsed) throw invalid();
  const qualityStatus = enumeration(entry.quality_status, ['unknown', 'synthetic']);
  const scenarios = list(entry.scenarios, scenario, 100), currentProfile = profile(entry.profile);
  if ((qualityStatus === 'unknown' && (scenarios.length > 0 || currentProfile !== null)) || new Set(scenarios.map((item) => item.scenarioId)).size !== scenarios.length) throw invalid();
  const eligibleCount = integer(entry.eligible_count), coveredCount = integer(entry.covered_count), remainingCount = integer(entry.remaining_count);
  if (coveredCount > eligibleCount || remainingCount > eligibleCount) throw invalid();
  const workId = entry.work_id === null ? null : identifier(entry.work_id), workRevision = integer(entry.work_revision),
    currentBatch = integer(entry.current_batch), modelCallLimit = integer(entry.model_call_limit);
  if (integer(entry.model_calls_used) !== modelCallsUsed || modelCallLimit !== maxModelCalls
    || (workId === null && (workRevision !== 0 || currentBatch !== 0 || modelCallsUsed !== 0))
    || (workId !== null && workRevision === 0)) throw invalid();
  return { schemaVersion: 2, scopeKind: 'contact', contactId, settingsGeneration: integer(entry.settings_generation), enabled: entry.enabled,
    qualityStatus, status: enumeration(entry.status, ['disabled', 'ready', 'empty', 'failed', 'updating', 'stale', 'blocked', 'paused']),
    workId, workRevision, currentBatch, modelCallsUsed, modelCallLimit,
    eligibleCount, coveredCount, remainingCount, organizationGeneration: integer(entry.organization_generation), updatedAt: date(entry.updated_at),
    errorCode: entry.error_code === null ? null : text(entry.error_code, 200), purpose: text(entry.purpose, 2000),
    budget: { maxMemories: integer(budget.max_memories), maxScenarios: integer(budget.max_scenarios), maxParagraphs: integer(budget.max_paragraphs),
      maxCharacters: integer(budget.max_characters), maxModelCalls, modelCallsUsed, modelCallsRemaining,
      ...(budget.max_profile_entries === undefined ? {} : { maxProfileEntries: integer(budget.max_profile_entries) }) },
    scenarios, profile: currentProfile };
}
