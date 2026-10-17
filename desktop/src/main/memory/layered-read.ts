import type { LayeredMemory, LayeredMemoryReference, LayeredMemoryScenario } from '../../shared/memory-bridge';
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
export function layeredMemory(value: unknown, contactId: string): LayeredMemory {
  const entry = record(record(value).layered_memory), budget = record(entry.budget);
  if (entry.schema_version !== 1 || entry.scope_kind !== 'contact' || identifier(entry.contact_id) !== contactId
    || typeof entry.enabled !== 'boolean' || typeof entry.maintenance_pending !== 'boolean') throw invalid();
  const qualityStatus = enumeration(entry.quality_status, ['unknown', 'synthetic']);
  const scenarios = list(entry.scenarios, scenario, 100);
  if ((qualityStatus === 'unknown' && scenarios.length > 0) || new Set(scenarios.map((item) => item.scenarioId)).size !== scenarios.length) throw invalid();
  const cursor = (value: unknown): string | null => {
    if (value === null) return null;
    if (typeof value !== 'string' || !/^[0-9]{1,18}:[0-9]{1,10}$/.test(value)) throw invalid();
    return value;
  };
  const mappingCursor = cursor(entry.mapping_cursor), mappingNextCursor = cursor(entry.mapping_next_cursor);
  const scenarioMappings = list(entry.scenario_mappings, (value) => {
    const mapping = record(value);
    const targets = list(mapping.targets, (value) => {
      const target = record(value), scenarioId = identifier(target.scenario_id), versionId = identifier(target.version_id);
      if (!scenarios.some((item) => item.scenarioId === scenarioId && item.versionId === versionId)) throw invalid();
      return { scenarioId, versionId };
    }, 100);
    if (!targets.length || new Set(targets.map((item) => item.versionId)).size !== targets.length) throw invalid();
    return { sourceScenarioId: identifier(mapping.source_scenario_id), sourceVersionId: identifier(mapping.source_version_id), targets };
  }, 100);
  if (scenarioMappings.reduce((count, item) => count + item.targets.length, 0) > 100) throw invalid();
  const eligibleCount = integer(entry.eligible_count), coveredCount = integer(entry.covered_count), remainingCount = integer(entry.remaining_count);
  if (coveredCount > eligibleCount || remainingCount > eligibleCount) throw invalid();
  const workId = entry.work_id === null ? null : identifier(entry.work_id), workRevision = integer(entry.work_revision), currentBatch = integer(entry.current_batch);
  const modelCallsUsed = integer(entry.model_calls_used), modelCallLimit = integer(entry.model_call_limit);
  if ((workId === null && (workRevision !== 0 || currentBatch !== 0 || modelCallsUsed !== 0 || modelCallLimit !== 0))
    || (workId !== null && workRevision === 0) || modelCallsUsed > modelCallLimit) throw invalid();
  return { schemaVersion: 1, scopeKind: 'contact', contactId, settingsGeneration: integer(entry.settings_generation), enabled: entry.enabled,
    qualityStatus, status: enumeration(entry.status, ['disabled', 'ready', 'empty', 'failed', 'updating', 'paused', 'stale', 'blocked']),
    mappingCursor, mappingNextCursor, maintenancePending: entry.maintenance_pending, scenarioMappings,
    workId, workRevision, currentBatch, modelCallsUsed, modelCallLimit,
    eligibleCount, coveredCount, remainingCount, organizationGeneration: integer(entry.organization_generation), updatedAt: date(entry.updated_at),
    errorCode: entry.error_code === null ? null : text(entry.error_code, 200), purpose: text(entry.purpose, 2000),
    budget: { maxMemories: integer(budget.max_memories), maxScenarios: integer(budget.max_scenarios), maxParagraphs: integer(budget.max_paragraphs),
      maxCharacters: integer(budget.max_characters), maxModelCalls: integer(budget.max_model_calls) }, scenarios };
}
