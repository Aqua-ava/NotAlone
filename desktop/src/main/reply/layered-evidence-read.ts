import type { ReplyEvidenceState, ReplyLayeredContext, ReplyLayeredScenarioDocument, ReplyLayeredScenarioRead, ReplyLayeredStatus } from '../../shared/reply-evidence';
import { isUuid } from '../uuid';
import { readCurrentStatus } from '../memory/current-status';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 65_536;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown): value is string | null => value === null || (typeof value === 'string' && value.length <= 80 && Number.isFinite(Date.parse(value)));
const invalid = () => new Error('分层依据快照格式无效。');
const range = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2
  && integer(value[0]) && integer(value[1]) && value[1] > value[0];
const requestedRange = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2
  && value.every((part) => typeof part === 'number' && Number.isSafeInteger(part));

function scenarioReads(value: unknown, context: ReplyLayeredContext | null | undefined): ReplyLayeredScenarioRead[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 256) throw invalid();
  // 旧版历史只保留当时的背景；不能借展示兼容给旧协议补授正文工具权限。
  if (value.length && (context?.schemaVersion !== 2 || !context.scenarioReadBudget)) throw invalid();
  return value.map((entry: unknown): ReplyLayeredScenarioRead => {
    if (!record(entry) || entry.schema_version !== 1 || !text(entry.reason) || !entry.reason.trim()
      || !['succeeded', 'duplicate', 'out_of_range', 'not_in_directory', 'invalid_arguments', 'stale', 'budget_exceeded'].includes(entry.status as string)
      || !(entry.scenario_id === null || isUuid(entry.scenario_id))
      || !(entry.paragraph_range === null || requestedRange(entry.paragraph_range)) || !record(entry.budget)) throw invalid();
    const rawBudget = entry.budget;
    if (![rawBudget.call_limit, rawBudget.paragraph_limit, rawBudget.character_limit,
      rawBudget.used_calls, rawBudget.used_paragraphs, rawBudget.used_characters].every(integer)) throw invalid();
    const allowedBudget = context?.scenarioReadBudget;
    if (!allowedBudget || rawBudget.call_limit !== allowedBudget.callLimit
      || rawBudget.paragraph_limit !== allowedBudget.paragraphLimit || rawBudget.character_limit !== allowedBudget.characterLimit
      || (rawBudget.used_calls as number) > rawBudget.call_limit || (rawBudget.used_paragraphs as number) > rawBudget.paragraph_limit
      || (rawBudget.used_characters as number) > rawBudget.character_limit) throw invalid();
    const base = { schemaVersion: 1 as const, reason: entry.reason,
      scenarioId: entry.scenario_id === null ? null : entry.scenario_id.toLowerCase(),
      paragraphRange: entry.paragraph_range === null ? null : [...entry.paragraph_range] as [number, number],
      budget: { callLimit: rawBudget.call_limit as number, paragraphLimit: rawBudget.paragraph_limit as number,
        characterLimit: rawBudget.character_limit as number, usedCalls: rawBudget.used_calls as number,
        usedParagraphs: rawBudget.used_paragraphs as number, usedCharacters: rawBudget.used_characters as number } };
    if (entry.status !== 'succeeded') {
      if (entry.document !== undefined) throw invalid();
      return { ...base, status: entry.status as Exclude<ReplyLayeredScenarioRead['status'], 'succeeded'> };
    }
    const document = entry.document;
    const allowed = context?.directory.find((item) => item.scenarioId === base.scenarioId);
    if (!context || !allowed || !record(document) || !isUuid(document.scenario_id) || !isUuid(document.version_id)
      || document.scenario_id.toLowerCase() !== base.scenarioId || document.version_id.toLowerCase() !== allowed.versionId
      || document.organization_generation !== context.organizationGeneration || !text(document.title) || !text(document.hint)
      || document.title !== allowed.title || document.hint !== allowed.hint
      || document.system_generated !== true || !date(document.updated_at) || document.updated_at === null
      || !range(document.paragraph_range) || !base.paragraphRange
      || document.paragraph_range[0] !== base.paragraphRange[0] || document.paragraph_range[1] !== base.paragraphRange[1]
      || document.paragraph_range[1] > allowed.paragraphCount
      || !Array.isArray(document.paragraphs) || document.paragraphs.length > 256
      || document.paragraphs.length !== document.paragraph_range[1] - document.paragraph_range[0]) throw invalid();
    const paragraphs: ReplyLayeredScenarioDocument['paragraphs'] = document.paragraphs.map((paragraph: unknown) => {
      if (!record(paragraph) || !text(paragraph.text) || !paragraph.text.trim()
        || !Array.isArray(paragraph.references) || !paragraph.references.length || paragraph.references.length > 256) throw invalid();
      return { text: paragraph.text, references: paragraph.references.map((ref: unknown) => {
        if (!record(ref) || !isUuid(ref.memory_id) || !integer(ref.revision) || ref.revision < 1
          || (ref.provenance_kind !== undefined && !['manual_entry', 'source_supported'].includes(ref.provenance_kind as string))) throw invalid();
        const result: ReplyLayeredScenarioDocument['paragraphs'][number]['references'][number] = {
          memoryId: ref.memory_id.toLowerCase(), revision: ref.revision };
        if (ref.provenance_kind !== undefined) result.provenanceKind = ref.provenance_kind as 'manual_entry' | 'source_supported';
        if (ref.timing !== undefined) {
          if (!record(ref.timing) || !date(ref.timing.recorded_at) || !date(ref.timing.source_started_at)
            || !date(ref.timing.source_ended_at) || typeof ref.timing.source_time_complete !== 'boolean') throw invalid();
          result.timing = { recordedAt: ref.timing.recorded_at, sourceStartedAt: ref.timing.source_started_at,
            sourceEndedAt: ref.timing.source_ended_at, sourceTimeComplete: ref.timing.source_time_complete, ...readCurrentStatus(ref.timing) };
        }
        return result;
      }) };
    });
    return { ...base, status: 'succeeded', document: { scenarioId: document.scenario_id.toLowerCase(),
      versionId: document.version_id.toLowerCase(), title: document.title, hint: document.hint,
      organizationGeneration: document.organization_generation, paragraphRange: [...document.paragraph_range],
      systemGenerated: true, updatedAt: document.updated_at, paragraphs } };
  });
}

function withReads(value: Record<string, unknown>, result: Pick<ReplyEvidenceState, 'layeredContext' | 'layeredStatus'>) {
  const reads = scenarioReads(value.layered_scenario_reads, result.layeredContext);
  return { ...result, ...(reads === undefined ? {} : { layeredScenarioReads: reads }) };
}

// 白名单投影仅保留本次模型可见资料，完整参与依赖不得穿过展示边界。
export function readLayeredEvidence(value: Record<string, unknown>) {
  if (value.layered_status === undefined && value.layered_context === undefined) return withReads(value, {});
  if (!['loaded', 'not_allowed', 'unavailable', 'budget_omitted', 'quality_closed'].includes(value.layered_status as string)) throw invalid();
  const layeredStatus = value.layered_status as ReplyLayeredStatus;
  const context = value.layered_context;
  if (context === null || context === undefined) {
    if (layeredStatus === 'loaded') throw invalid();
    return withReads(value, { layeredStatus, layeredContext: null });
  }
  if (layeredStatus !== 'loaded' || !record(context)
    || !((context.schema_version === 1 && context.read_policy === 'synthetic-contact-layered-v1')
      || (context.schema_version === 2 && context.read_policy === 'synthetic-contact-layered-v2')) || context.scope_kind !== 'contact'
    || !integer(context.settings_generation) || !integer(context.organization_generation)
    || !(context.profile_version_id === null || isUuid(context.profile_version_id))
    || !record(context.budget)
    || !integer(context.budget.profile_entries) || !integer(context.budget.directory_entries) || !integer(context.budget.characters)
    || !Array.isArray(context.profile_entries) || context.profile_entries.length > 256
    || context.profile_entries.length > context.budget.profile_entries
    || !Array.isArray(context.directory) || context.directory.length > 256 || context.directory.length > context.budget.directory_entries
    || (context.profile_entries.length > 0 && context.profile_version_id === null)) throw invalid();
  let scenarioReadBudget: ReplyLayeredContext['scenarioReadBudget'];
  if (context.schema_version === 1) {
    if (context.scenario_read_budget !== undefined) throw invalid();
  } else if (context.scenario_read_budget === null) scenarioReadBudget = null;
  else {
    const limits = context.scenario_read_budget;
    if (!record(limits) || ![limits.call_limit, limits.paragraph_limit, limits.character_limit].every((part) => integer(part) && part > 0)) throw invalid();
    scenarioReadBudget = { callLimit: limits.call_limit as number, paragraphLimit: limits.paragraph_limit as number,
      characterLimit: limits.character_limit as number };
  }
  const profileEntries: ReplyLayeredContext['profileEntries'] = context.profile_entries.map((entry: unknown) => {
    if (!record(entry) || !text(entry.text) || !text(entry.uncertainty)
      || !['stable', 'historical', 'uncertain'].includes(entry.temporal_status as string)
      || (entry.temporal_status === 'uncertain' && !entry.uncertainty.trim())
      || !Array.isArray(entry.references) || !entry.references.length || entry.references.length > 256) throw invalid();
    const references = entry.references.map((ref: unknown) => {
      if (!record(ref) || !isUuid(ref.memory_id) || !integer(ref.revision) || ref.revision < 1
        || !['manual_entry', 'source_supported'].includes(ref.provenance_kind as string) || !record(ref.timing)
        || !date(ref.timing.recorded_at) || !date(ref.timing.source_started_at) || !date(ref.timing.source_ended_at)
        || typeof ref.timing.source_time_complete !== 'boolean') throw invalid();
      return { memoryId: ref.memory_id.toLowerCase(), revision: ref.revision,
        provenanceKind: ref.provenance_kind as 'manual_entry' | 'source_supported',
        timing: { recordedAt: ref.timing.recorded_at, sourceStartedAt: ref.timing.source_started_at,
          sourceEndedAt: ref.timing.source_ended_at, sourceTimeComplete: ref.timing.source_time_complete, ...readCurrentStatus(ref.timing) } };
    });
    return { text: entry.text, temporalStatus: entry.temporal_status as 'stable' | 'historical' | 'uncertain', uncertainty: entry.uncertainty, references };
  });
  const directory: ReplyLayeredContext['directory'] = context.directory.map((entry: unknown) => {
    if (!record(entry) || !isUuid(entry.scenario_id) || !isUuid(entry.version_id) || !text(entry.title) || !text(entry.hint)
      || !integer(entry.paragraph_count)
      || (context.schema_version === 2 && entry.paragraph_range === undefined)
      || (entry.paragraph_range !== undefined && (!range(entry.paragraph_range)
        || entry.paragraph_range[0] !== 0 || entry.paragraph_range[1] !== entry.paragraph_count))) throw invalid();
    return { scenarioId: entry.scenario_id.toLowerCase(), versionId: entry.version_id.toLowerCase(), title: entry.title,
      hint: entry.hint, paragraphCount: entry.paragraph_count,
      ...(entry.paragraph_range === undefined ? {} : { paragraphRange: [...entry.paragraph_range] as [number, number] }) };
  });
  return withReads(value, { layeredStatus, layeredContext: { schemaVersion: context.schema_version as 1 | 2, scopeKind: 'contact', settingsGeneration: context.settings_generation,
    organizationGeneration: context.organization_generation, profileVersionId: context.profile_version_id,
    profileEntries, directory, readPolicy: context.read_policy as ReplyLayeredContext['readPolicy'],
    ...(scenarioReadBudget === undefined ? {} : { scenarioReadBudget }),
    budget: { profileEntries: context.budget.profile_entries, directoryEntries: context.budget.directory_entries, characters: context.budget.characters } } });
}
