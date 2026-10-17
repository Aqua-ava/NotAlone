import type { ReplyLayeredContext, ReplyLayeredStatus } from '../../shared/reply-evidence';
import { isUuid } from '../uuid';
import { readCurrentStatus } from '../memory/current-status';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 65_536;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown): value is string | null => value === null || (typeof value === 'string' && value.length <= 80 && Number.isFinite(Date.parse(value)));
const invalid = () => new Error('分层依据快照格式无效。');

// 白名单投影仅保留本次模型可见资料，完整参与依赖不得穿过展示边界。
export function readLayeredEvidence(value: Record<string, unknown>): { layeredContext?: ReplyLayeredContext | null; layeredStatus?: ReplyLayeredStatus } {
  if (value.layered_status === undefined && value.layered_context === undefined) return {};
  if (!['loaded', 'not_allowed', 'unavailable', 'budget_omitted', 'quality_closed'].includes(value.layered_status as string)) throw invalid();
  const layeredStatus = value.layered_status as ReplyLayeredStatus;
  const context = value.layered_context;
  if (context === null || context === undefined) {
    if (layeredStatus === 'loaded') throw invalid();
    return { layeredStatus, layeredContext: null };
  }
  if (layeredStatus !== 'loaded' || !record(context) || context.schema_version !== 1 || context.scope_kind !== 'contact'
    || !integer(context.settings_generation) || !integer(context.organization_generation)
    || !(context.profile_version_id === null || isUuid(context.profile_version_id))
    || context.read_policy !== 'synthetic-contact-layered-v1' || !record(context.budget)
    || !integer(context.budget.profile_entries) || !integer(context.budget.directory_entries) || !integer(context.budget.characters)
    || !Array.isArray(context.profile_entries) || context.profile_entries.length > 256
    || context.profile_entries.length > context.budget.profile_entries
    || !Array.isArray(context.directory) || context.directory.length > 256 || context.directory.length > context.budget.directory_entries
    || (context.profile_entries.length > 0 && context.profile_version_id === null)) throw invalid();
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
      || !integer(entry.paragraph_count)) throw invalid();
    return { scenarioId: entry.scenario_id.toLowerCase(), versionId: entry.version_id.toLowerCase(), title: entry.title,
      hint: entry.hint, paragraphCount: entry.paragraph_count };
  });
  return { layeredStatus, layeredContext: { schemaVersion: 1, scopeKind: 'contact', settingsGeneration: context.settings_generation,
    organizationGeneration: context.organization_generation, profileVersionId: context.profile_version_id,
    profileEntries, directory, readPolicy: context.read_policy,
    budget: { profileEntries: context.budget.profile_entries, directoryEntries: context.budget.directory_entries, characters: context.budget.characters } } };
}
