import { isUuid } from '../uuid';
import type { ContactRelationshipOverview, OwnerFactsPreferencesOverview, OverviewSourceReference } from '../../shared/memory-bridge';
import { memoryVersions } from './read';

const invalid = () => new Error('联系人概览响应不可用。');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function identifier(value: unknown): string {
  if (!isUuid(value)) throw invalid();
  return value.toLowerCase();
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw invalid();
  return value;
}
function reference(value: unknown, owner = false): OverviewSourceReference {
  if (!record(value) || !['source_document', 'local_wechat_observation', 'manual'].includes(value.source_kind as string)
    || (value.locator !== null && typeof value.locator !== 'string')) throw invalid();
  if (owner && (value.locator !== null || (value.source_kind === 'manual' && value.contact_id !== null)
    || (value.source_kind !== 'manual' && value.contact_id === null))) throw invalid();
  return { sourceId: identifier(value.source_id), sourceKind: value.source_kind as OverviewSourceReference['sourceKind'],
    messageId: value.message_id === null ? null : identifier(value.message_id),
    sourceRefId: value.source_ref_id === null ? null : identifier(value.source_ref_id), locator: value.locator as string | null,
    ...(owner ? { contactId: value.contact_id === null ? null : identifier(value.contact_id) } : {}) };
}

// 只读取服务端的合法底层投影；来源定位是显示文字，不是文件或网络读取入口。
function readOverview(value: unknown, level: 'contact' | 'owner', contactId: string | null) {
  const data = record(value) ? value.overview : undefined;
  if (!record(data) || data.version !== 1 || data.scope_kind !== level
    || (level === 'owner' ? data.contact_id !== null : identifier(data.contact_id) !== contactId)
    || typeof data.projection_revision !== 'string' || !/^[0-9a-f]{64}$/.test(data.projection_revision)
    || typeof data.built_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(data.built_at)
    || !Number.isFinite(Date.parse(data.built_at)) || !Array.isArray(data.entries)) throw invalid();
  const entries = data.entries.map((entry) => {
    if (!record(entry) || typeof entry.is_latest !== 'boolean' || !record(entry.provenance)
      || !['manual_entry', 'source_supported', 'unknown'].includes(entry.provenance.kind as string)
      || !Array.isArray(entry.provenance.references)) throw invalid();
    if (level === 'owner' && (!record(entry.memory) || entry.memory.contact_id !== undefined
      || !['common_fact', 'preference', 'taboo'].includes(entry.memory.category as string))) throw invalid();
    const memory = memoryVersions({ versions: [entry.memory] }, level, contactId ?? '')[0];
    const leaf = entry.current_leaf;
    if (leaf !== null && !record(leaf)) throw invalid();
    const currentLeaf = leaf === null ? null : { memoryId: identifier(leaf.memory_id), revision: integer(leaf.revision, 1) };
    const isLatest = currentLeaf?.memoryId === memory.memoryId;
    if (entry.is_latest !== isLatest || (isLatest && (memory.status !== 'active' || currentLeaf!.revision !== memory.revision))) throw invalid();
    const references = entry.provenance.references.map((item) => reference(item, level === 'owner'));
    if (entry.provenance.kind === 'manual_entry' && !references.some((item) => item.sourceKind === 'manual')) throw invalid();
    if (entry.provenance.kind === 'source_supported' && !references.some((item) => item.sourceKind !== 'manual')) throw invalid();
    return { memory, isLatest, currentLeaf, provenance: {
      kind: entry.provenance.kind as 'manual_entry' | 'source_supported' | 'unknown', references } };
  });
  if (new Set(entries.map((entry) => entry.memory.memoryId)).size !== entries.length) throw invalid();
  return { version: 1 as const, projectionRevision: data.projection_revision,
    memoryRevision: integer(data.memory_revision), builtAt: data.built_at, entries };
}
export function contactRelationshipOverview(value: unknown, contactId: string): ContactRelationshipOverview {
  return { ...readOverview(value, 'contact', contactId), scopeKind: 'contact', contactId };
}
export function ownerFactsPreferencesOverview(value: unknown): OwnerFactsPreferencesOverview {
  return { ...readOverview(value, 'owner', null), scopeKind: 'owner', contactId: null };
}
