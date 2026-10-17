import type { ReplyEvidenceItem, ReplyEvidenceNavigation, ReplyMemoryRetrievalBudget, ReplyOverviewRevision, ReplyRetrievalQuery, ReplyRetrievalReceipt } from '../../shared/reply-evidence';
import { isUuid } from '../uuid';

const invalid = () => new Error('检索回执格式无效。');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const revision = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) throw invalid();
  return value;
}

export function readEvidenceNavigation(value: unknown, evidenceId: string, kind: ReplyEvidenceItem['kind']): ReplyEvidenceNavigation | undefined {
  if (value === undefined || value === null) return undefined;
  const item = fields(value, ['scope_kind', 'projection_revision', 'memory_id', 'memory_revision', 'provenance_kind']);
  if (!(kind === 'confirmed_memory' && item.scope_kind === 'contact' || kind === 'owner_memory' && item.scope_kind === 'owner')
    || !revision(item.projection_revision) || !isUuid(item.memory_id) || item.memory_id.toLowerCase() !== evidenceId
    || !integer(item.memory_revision, 1) || !['manual_entry', 'source_supported'].includes(item.provenance_kind as string)) throw invalid();
  return { scopeKind: item.scope_kind as ReplyEvidenceNavigation['scopeKind'], projectionRevision: item.projection_revision,
    memoryId: evidenceId, memoryRevision: item.memory_revision, provenanceKind: item.provenance_kind as ReplyEvidenceNavigation['provenanceKind'] };
}
function overview(value: unknown): ReplyOverviewRevision | null {
  if (value === null) return null;
  const item = fields(value, ['projection_revision', 'memory_revision']);
  if (!revision(item.projection_revision) || !integer(item.memory_revision)) throw invalid();
  return { projectionRevision: item.projection_revision, memoryRevision: item.memory_revision };
}
function memoryBudget(value: unknown, limit: number, charLimit: number, evidence: ReplyEvidenceItem[], kind: ReplyEvidenceItem['kind']): ReplyMemoryRetrievalBudget {
  const item = fields(value, ['limit', 'char_limit', 'used_count', 'used_chars', 'exhausted']);
  const used = evidence.filter((entry) => entry.kind === kind);
  if (item.limit !== limit || item.char_limit !== charLimit || !integer(item.used_count) || item.used_count > limit
    || !integer(item.used_chars) || item.used_chars > charLimit || typeof item.exhausted !== 'boolean'
    || item.used_count !== used.length || item.used_chars !== used.reduce((total, entry) => total + Array.from(entry.text).length, 0)) throw invalid();
  return { limit, charLimit, usedCount: item.used_count, usedChars: item.used_chars, exhausted: item.exhausted };
}

// 回执只描述本次实际使用的底层证据；缺失的旧过程不从当前概览或其他联系人补填。
export function readReplyRetrieval(value: unknown, evidence: ReplyEvidenceItem[]): ReplyRetrievalReceipt | null {
  if (value === undefined || value === null) {
    if (evidence.some((item) => item.navigation)) throw invalid();
    return null;
  }
  const item = fields(value, ['version', 'retriever_version', 'status', 'overview_revisions', 'queries', 'budgets']);
  if (item.version !== 1 || item.retriever_version !== 'lexical-v1'
    || !['succeeded', 'empty', 'budget_exhausted', 'unavailable'].includes(item.status as string)
    || !Array.isArray(item.queries) || item.queries.length > 64) throw invalid();
  const revisions = fields(item.overview_revisions, ['contact', 'owner']);
  const overviewRevisions = { contact: overview(revisions.contact), owner: overview(revisions.owner) };
  for (const entry of evidence) {
    if (entry.navigation && entry.navigation.projectionRevision !== overviewRevisions[entry.navigation.scopeKind]?.projectionRevision) throw invalid();
  }
  const queries: ReplyRetrievalQuery[] = item.queries.map((value: unknown) => {
    const query = fields(value, ['kind', 'purpose', 'status', 'evidence_ids', 'limit']);
    if (!['confirmed_memory', 'owner_memory', 'pending_candidate', 'message'].includes(query.kind as string)
      || !['recall', 'source_window'].includes(query.purpose as string)
      || (query.purpose === 'source_window' && query.kind !== 'message')
      || !['succeeded', 'empty', 'budget_exceeded', 'failed'].includes(query.status as string)
      || !integer(query.limit, 1) || query.limit > 20 || !Array.isArray(query.evidence_ids)
      || query.evidence_ids.length > query.limit || !query.evidence_ids.every(isUuid)
      || (query.status !== 'succeeded' && query.evidence_ids.length > 0)) throw invalid();
    const evidenceIds = query.evidence_ids.map((id: string) => id.toLowerCase());
    if (new Set(evidenceIds).size !== evidenceIds.length
      || evidenceIds.some((id) => !evidence.some((entry) => entry.evidenceId === id && entry.kind === query.kind))) throw invalid();
    return { kind: query.kind as ReplyRetrievalQuery['kind'], purpose: query.purpose as ReplyRetrievalQuery['purpose'],
      status: query.status as ReplyRetrievalQuery['status'], evidenceIds, limit: query.limit };
  });
  const budgets = fields(item.budgets, ['contact_memory', 'owner_memory', 'pending_candidate', 'source_messages']);
  const source = fields(budgets.source_messages, ['call_limit', 'item_limit', 'token_limit', 'used_calls', 'used_count', 'used_tokens', 'exhausted']);
  if (source.call_limit !== 3 || source.item_limit !== 16 || source.token_limit !== 2048
    || !integer(source.used_calls) || source.used_calls > source.call_limit
    || !integer(source.used_count) || source.used_count > source.item_limit
    || !integer(source.used_tokens) || source.used_tokens > source.token_limit
    || typeof source.exhausted !== 'boolean') throw invalid();
  return { version: 1, retrieverVersion: 'lexical-v1', status: item.status as ReplyRetrievalReceipt['status'],
    overviewRevisions, queries, budgets: {
      contactMemory: memoryBudget(budgets.contact_memory, 5, 600, evidence, 'confirmed_memory'),
      ownerMemory: memoryBudget(budgets.owner_memory, 3, 240, evidence, 'owner_memory'),
      pendingCandidate: memoryBudget(budgets.pending_candidate, 3, 300, evidence, 'pending_candidate'), sourceMessages: {
        callLimit: 3, itemLimit: 16, tokenLimit: 2048, usedCalls: source.used_calls,
        usedCount: source.used_count, usedTokens: source.used_tokens, exhausted: source.exhausted } } };
}
