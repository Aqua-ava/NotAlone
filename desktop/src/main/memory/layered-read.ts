import { readPersonalBackground } from '../personal-background';
import type { LayeredMemory, LayeredMemoryProfile, LayeredMemoryQuality, LayeredMemoryQualityStage, LayeredMemoryReference, LayeredMemoryScenario } from '../../shared/memory-bridge';
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
    return { ...readPersonalBackground(paragraph), text: text(paragraph.text), references };
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
    return { ...readPersonalBackground(item, true), text: text(item.text), temporalStatus: enumeration(item.temporal_status, ['stable', 'historical', 'uncertain']),
      uncertainty: item.uncertainty, references };
  }, 100);
  if (!entries.length) throw invalid();
  return { versionId: identifier(entry.version_id), systemGenerated: true, updatedAt, entries };
}
function qualityStage(value: unknown): LayeredMemoryQualityStage {
  const entry = record(value), status = enumeration(entry.status, ['unknown', 'failed', 'verified']);
  if (Object.keys(entry).some((key) => !['status', 'reasons', 'contract_id', 'report_id'].includes(key))) throw invalid();
  const reasons = list(entry.reasons, (value) => text(value, 1000), 100);
  const contractId = entry.contract_id === null ? null : text(entry.contract_id, 200);
  const reportId = entry.report_id === null ? null : text(entry.report_id, 200);
  if (status === 'verified' && (contractId === null || reportId === null || reasons.length)) throw invalid();
  return { status, reasons, contractId, reportId };
}
function quality(value: unknown, qualityStatus: LayeredMemory['qualityStatus']): LayeredMemoryQuality {
  if (value === undefined) {
    if (qualityStatus !== 'unknown' && qualityStatus !== 'synthetic') throw invalid();
    return { organization: { status: 'unknown', reasons: [], contractId: null, reportId: null },
      reply: { status: 'unknown', reasons: [], contractId: null, reportId: null },
      automaticUseAllowed: false, synthetic: qualityStatus === 'synthetic' };
  }
  const entry = record(value), organization = qualityStage(entry.organization), reply = qualityStage(entry.reply);
  if (Object.keys(entry).some((key) => !['organization', 'reply', 'automatic_use_allowed', 'synthetic'].includes(key))
    || typeof entry.automatic_use_allowed !== 'boolean' || typeof entry.synthetic !== 'boolean'
    || (qualityStatus === 'synthetic') !== entry.synthetic
    || (!entry.synthetic && qualityStatus !== organization.status)
    || (entry.synthetic && (organization.status === 'verified' || reply.status === 'verified'))
    || (entry.automatic_use_allowed && (entry.synthetic || organization.status !== 'verified' || reply.status !== 'verified'))) throw invalid();
  return { organization, reply, automaticUseAllowed: entry.automatic_use_allowed, synthetic: entry.synthetic };
}
export function layeredMemory(value: unknown, contactId: string | null): LayeredMemory {
  const entry = record(record(value).layered_memory), budget = record(entry.budget);
  if (entry.schema_version !== 2 || entry.scope_kind !== (contactId === null ? 'owner' : 'contact') || (contactId === null ? entry.contact_id !== null : identifier(entry.contact_id) !== contactId)
    || typeof entry.enabled !== 'boolean' || typeof entry.maintenance_pending !== 'boolean') throw invalid();
  const maxModelCalls = integer(budget.max_model_calls), modelCallsUsed = integer(budget.model_calls_used),
    modelCallsRemaining = integer(budget.model_calls_remaining);
  if (modelCallsUsed > maxModelCalls || modelCallsRemaining !== maxModelCalls - modelCallsUsed) throw invalid();
  const qualityStatus = enumeration(entry.quality_status, ['unknown', 'failed', 'verified', 'synthetic']);
  const currentQuality = quality(entry.quality, qualityStatus);
  const scenarios = list(entry.scenarios, scenario, 100), currentProfile = profile(entry.profile);
  if (new Set(scenarios.map((item) => item.scenarioId)).size !== scenarios.length) throw invalid();
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
  const workId = entry.work_id === null ? null : identifier(entry.work_id), workRevision = integer(entry.work_revision),
    currentBatch = integer(entry.current_batch), modelCallLimit = integer(entry.model_call_limit);
  if (integer(entry.model_calls_used) !== modelCallsUsed || modelCallLimit !== maxModelCalls
    || (workId === null && (workRevision !== 0 || currentBatch !== 0 || modelCallsUsed !== 0))
    || (workId !== null && workRevision === 0)) throw invalid();
  return { schemaVersion: 2, scopeKind: contactId === null ? 'owner' : 'contact', contactId, settingsGeneration: integer(entry.settings_generation), enabled: entry.enabled,
    mappingCursor, mappingNextCursor, maintenancePending: entry.maintenance_pending, scenarioMappings,
    runtimePolicy: entry.runtime_policy === undefined ? 'qualification' : enumeration(entry.runtime_policy, ['qualification', 'verified_items']),
    qualityStatus, quality: currentQuality, status: enumeration(entry.status, ['disabled', 'ready', 'empty', 'failed', 'updating', 'stale', 'blocked', 'paused']),
    workId, workRevision, currentBatch, modelCallsUsed, modelCallLimit,
    eligibleCount, coveredCount, remainingCount, organizationGeneration: integer(entry.organization_generation), updatedAt: date(entry.updated_at),
    errorCode: entry.error_code === null ? null : text(entry.error_code, 200), purpose: text(entry.purpose, 2000),
    budget: { maxMemories: integer(budget.max_memories),
      ...(budget.max_batch_memories === undefined ? {} : { maxBatchMemories: integer(budget.max_batch_memories) }), maxScenarios: integer(budget.max_scenarios), maxParagraphs: integer(budget.max_paragraphs),
      maxCharacters: integer(budget.max_characters), maxModelCalls, modelCallsUsed, modelCallsRemaining,
      ...(budget.max_profile_entries === undefined ? {} : { maxProfileEntries: integer(budget.max_profile_entries) }) },
    correctionRevision: entry.correction_revision === undefined ? 0 : integer(entry.correction_revision),
    protectedCount: entry.protected_count === undefined ? 0 : integer(entry.protected_count),
    pendingFactCount: entry.pending_fact_count === undefined ? 0 : integer(entry.pending_fact_count),
    correctionTarget: entry.correction_target === undefined ? null : {
      memoryId: identifier(record(entry.correction_target).memory_id), revision: integer(record(entry.correction_target).revision, 1) },
    feedback: entry.feedback === undefined ? [] : list(entry.feedback, value => {
      const feedback = record(value);
      const state = enumeration(feedback.state, ['active', 'erased_guard']);
      if (state === 'active' ? feedback.reason === null || feedback.version_id === null : feedback.reason !== null || feedback.version_id !== null) throw invalid();
      if (state === 'erased_guard' && feedback.target_text !== null) throw invalid();
      return { id: identifier(feedback.id), targetKind: enumeration(feedback.target_kind, ['scenario', 'profile']),
        versionId: feedback.version_id === null ? null : identifier(feedback.version_id), itemIndex: integer(feedback.item_index),
        reason: feedback.reason === null ? null : text(feedback.reason, 500), state,
        targetText: feedback.target_text === null ? null : text(feedback.target_text),
        basis: list(feedback.basis, value => {
          const basis = record(value);
          if (Object.keys(basis).some(key => !['memory_id', 'revision'].includes(key))) throw invalid();
          return { memoryId: identifier(basis.memory_id), revision: integer(basis.revision, 1) };
        }) };
    }),
    scenarios, profile: currentProfile };
}
