import type { HistoryCoverage, HistoryCoveragePhase, HistoryIncrementalPhase, BackgroundIncrementalPhase, BackgroundSyncPhase, ForegroundReportPhase, HistoryAuthorizationDecision, HistoryAuthorizationState, SyncBackfillPhase, SyncBackfillReport, SyncStatusReport, SyncScope } from '../../shared/sync-control-bridge';
import type { BackendHost } from '../backend/host';
import { isUuid } from '../uuid';

const backgroundPhases: BackgroundSyncPhase[] = ['disabled', 'waiting_bindings', 'active', 'degraded'];
const foregroundPhases: ForegroundReportPhase[] = ['sync_disabled', 'waiting_foreground', 'unavailable', 'active', 'failed'];
const backfillPhases: SyncBackfillPhase[] = ['not_required', 'gap_detected', 'backfilling', 'complete', 'failed', 'incomplete', 'paused'];
const historyAuthorizationStates: HistoryAuthorizationState[] = ['required', 'accepted', 'declined', 'unknown'];
const historyIncrementalPhases: HistoryIncrementalPhase[] = ['not_started', 'ready', 'syncing', 'incomplete', 'blocked', 'invalidated', 'unavailable', 'stopped'];
const backgroundIncrementalPhases: BackgroundIncrementalPhase[] = ['idle', 'active', 'incomplete', 'unavailable', 'closed', 'disabled'];
// 旧后台没有授权版本字段；默认版本只用于把缺失报告标为未确认。
const DEFAULT_HISTORY_AUTHORIZATION_VERSION = 1;
// 全部私聊覆盖报告有界读取，超过预算整份失败，不截断为完整状态。
const SYNC_REPORT_MAX_BYTES = 4_194_304;
const MAX_NON_TEXT_TYPES = 32;
const MESSAGE_TYPE_IDENTIFIER = /^[a-z][a-z0-9_]{0,31}$/;

function failureCode(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(value)) throw new Error('同步报告不可用。');
  return value;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('同步报告不可用。');
  return value;
}
function nonTextTypes(value: unknown, nonTextCount: number): HistoryCoverage['nonTextTypes'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_NON_TEXT_TYPES) throw new Error('同步报告不可用。');
  const seen = new Set<string>();
  let total = 0;
  const types = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('同步报告不可用。');
    const fields = item as Record<string, unknown>;
    const messageType = fields.message_type;
    const label = fields.label;
    const amount = fields.count;
    if (typeof messageType !== 'string' || !MESSAGE_TYPE_IDENTIFIER.test(messageType) || messageType === 'text'
      || seen.has(messageType) || typeof label !== 'string' || !label.trim() || [...label].length > 64) {
      throw new Error('同步报告不可用。');
    }
    const typeCount = count(amount);
    if (typeCount <= 0 || !Number.isSafeInteger(total + typeCount)) throw new Error('同步报告不可用。');
    seen.add(messageType);
    total += typeCount;
    return { messageType, label, count: typeCount };
  });
  if (total !== nonTextCount) throw new Error('同步报告不可用。');
  return types;
}
function backfillReport(fields: Record<string, unknown>): SyncBackfillReport {
  if (!backfillPhases.includes(fields.cli_backfill_phase as SyncBackfillPhase)) throw new Error('同步报告不可用。');
  return { phase: fields.cli_backfill_phase as SyncBackfillPhase, failureCode: failureCode(fields.cli_backfill_failure_code),
    totalContacts: count(fields.cli_backfill_total_contacts), completedContacts: count(fields.cli_backfill_completed_contacts),
    succeededContacts: count(fields.cli_backfill_succeeded_contacts), skippedContacts: count(fields.cli_backfill_skipped_contacts),
    failedContacts: count(fields.cli_backfill_failed_contacts), incompleteContacts: count(fields.cli_backfill_incomplete_contacts),
    pendingContacts: count(fields.cli_backfill_pending_contacts), messageCount: count(fields.cli_backfill_total_message_count),
    nonTextCount: count(fields.cli_backfill_total_non_text_count) };
}
/** 可选增量字段：后端未报告时不推断为已同步，报告了非法值则整份失败。 */
function optionalIncrementalPhase(value: unknown): HistoryIncrementalPhase | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !historyIncrementalPhases.includes(value as HistoryIncrementalPhase)) throw new Error('同步报告不可用。');
  return value as HistoryIncrementalPhase;
}
function optionalBackgroundIncrementalPhase(value: unknown): BackgroundIncrementalPhase | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !backgroundIncrementalPhases.includes(value as BackgroundIncrementalPhase)) throw new Error('同步报告不可用。');
  return value as BackgroundIncrementalPhase;
}
function positiveVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('同步报告不可用。');
  return value;
}
function historyAuthorization(fields: Record<string, unknown>) {
  // 旧后台没有历史授权字段；不把未报告的状态当成已同意或已拒绝。
  if (!('cli_history_authorization_state' in fields)) {
    return { historyAuthorizationState: 'unknown' as const, historyAuthorizationVersion: null,
      historyAuthorizationCurrentVersion: DEFAULT_HISTORY_AUTHORIZATION_VERSION };
  }
  const state = fields.cli_history_authorization_state;
  if (!historyAuthorizationStates.includes(state as HistoryAuthorizationState)) throw new Error('同步报告不可用。');
  const version = fields.cli_history_authorization_version;
  if (state === 'unknown' && version !== null && version !== undefined) throw new Error('同步报告不可用。');
  if (version !== null && version !== undefined) positiveVersion(version);
  return {
    historyAuthorizationState: state as HistoryAuthorizationState,
    historyAuthorizationVersion: version === undefined ? null : version as number | null,
    historyAuthorizationCurrentVersion: positiveVersion(fields.cli_history_authorization_current_version),
  };
}
function historyCoverages(value: unknown): HistoryCoverage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('同步报告不可用。');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || !isUuid(item.binding_id) || !isUuid(item.contact_id)
      || !['not_started', 'syncing', 'complete', 'incomplete'].includes(item.phase)) throw new Error('同步报告不可用。');
    const incrementalPhase = optionalIncrementalPhase(item.incremental_phase);
    const incrementalFailureCode = item.incremental_failure_code === undefined ? undefined : failureCode(item.incremental_failure_code);
    if(item.incremental_waiting_for_messages!==undefined&&typeof item.incremental_waiting_for_messages!=='boolean')throw new Error('同步报告不可用。');
    const incrementalAwaitingMessages=item.incremental_waiting_for_messages as boolean|undefined;
    if(item.saved_history_complete!==undefined&&typeof item.saved_history_complete!=='boolean')throw new Error('同步报告不可用。');
    const savedHistoryComplete=item.saved_history_complete as boolean|undefined;
    const incrementalLastAcceptedAt = item.incremental_last_accepted_at === undefined || item.incremental_last_accepted_at === null ? null : count(item.incremental_last_accepted_at);
    const incrementalPages = item.incremental_pages === undefined ? undefined : count(item.incremental_pages);
    const messageCount = count(item.message_count);
    const nonTextCount = count(item.non_text_count);
    const parsedNonTextTypes = nonTextTypes(item.non_text_types, nonTextCount);
    return { bindingId: item.binding_id.toLowerCase(), contactId: item.contact_id.toLowerCase(),
      phase: item.phase as HistoryCoveragePhase, failureCode: failureCode(item.failure_code),
      ...(savedHistoryComplete === undefined ? {} : { savedHistoryComplete }),
      messageCount, nonTextCount, pageCount: count(item.page_count),
      ...(parsedNonTextTypes === undefined ? {} : { nonTextTypes: parsedNonTextTypes }),
      ...(item.metadata_only_count === undefined ? {} : { metadataOnlyCount: count(item.metadata_only_count) }),
      ...(incrementalPhase === undefined ? {} : { incrementalPhase }),
      ...(incrementalFailureCode === undefined ? {} : { incrementalFailureCode }),
      ...(incrementalAwaitingMessages === undefined ? {} : { incrementalAwaitingMessages }),
      ...(item.incremental_last_accepted_at === undefined ? {} : { incrementalLastAcceptedAt }),
      ...(incrementalPages === undefined ? {} : { incrementalPages }) };
  });
}
export function parseSyncReport(value: unknown): SyncStatusReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('同步报告不可用。');
  const fields = value as Record<string, unknown>;
  if (fields.sync_mode !== 'cli_background' || typeof fields.sync_enabled !== 'boolean'
    || typeof fields.cli_available !== 'boolean' || typeof fields.probe_available !== 'boolean'
    || typeof fields.wechat_in_front !== 'boolean'
    || !backgroundPhases.includes(fields.cli_sync_phase as BackgroundSyncPhase)
    || !foregroundPhases.includes(fields.foreground_phase as ForegroundReportPhase)
    || typeof fields.cli_bound_count !== 'number' || !Number.isSafeInteger(fields.cli_bound_count)
    || fields.cli_bound_count < 0) throw new Error('同步报告不可用。');
  if ('sync_scope' in fields && fields.sync_scope !== 'all_private' && fields.sync_scope !== 'selected') throw new Error('同步报告不可用。');
  if ('contact_avatar_revision' in fields && (typeof fields.contact_avatar_revision !== 'string'
    || fields.contact_avatar_revision.length > 128)) throw new Error('同步报告不可用。');
  return { ...(fields.identity_protocol === 'sqlite-selected-v1' ? { selectionOnly: true, bodyAvailable: fields.body_available === true } : {}), syncScope: (fields.sync_scope ?? 'selected') as SyncScope,
    syncScopeFailureCode: 'sync_scope_failure_code' in fields ? failureCode(fields.sync_scope_failure_code) : null,
    ...historyAuthorization(fields),
    historyCoverages: historyCoverages(fields.cli_history_coverages),
    enabled: fields.sync_enabled, backgroundPhase: fields.cli_sync_phase as BackgroundSyncPhase,
    backgroundFailureCode: failureCode(fields.cli_failure_code), cliAvailable: fields.cli_available,
    confirmedBindingCount: fields.cli_bound_count, foregroundPhase: fields.foreground_phase as ForegroundReportPhase,
    ...(typeof fields.contact_avatar_revision === 'string' ? { contactAvatarRevision: fields.contact_avatar_revision } : {}),
    foregroundFailureCode: failureCode(fields.foreground_failure_code), probeAvailable: fields.probe_available,
    wechatInFront: fields.wechat_in_front, backfill: backfillReport(fields),
    ...('cli_incremental_identity_limit' in fields ? { incrementalIdentityLimit: count(fields.cli_incremental_identity_limit) } : {}),
    ...(() => {
      const incrementalPhase = optionalBackgroundIncrementalPhase(fields.cli_incremental_phase);
      return {
        ...(incrementalPhase === undefined ? {} : { incrementalPhase }),
        ...('cli_incremental_failure_code' in fields ? { incrementalFailureCode: failureCode(fields.cli_incremental_failure_code) } : {}),
      };
    })() };
}

export async function readSyncStatus(backend: BackendHost, signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'GET', path: '/api/sync/status',
    timeoutMs: 12_000, maxResponseBytes: SYNC_REPORT_MAX_BYTES, signal });
  return { generation: response.generation, report: parseSyncReport(response.data) };
}
export async function setSyncEnabled(backend: BackendHost, enabled: boolean, signal: AbortSignal) {
  // 只改变既有总开关，正文范围、读取算法和补齐仍由原同步宿主决定。
  const response = await backend.requestJson({ method: 'POST', path: enabled ? '/api/sync/enable' : '/api/sync/disable',
    body: {}, timeoutMs: 12_000, maxResponseBytes: SYNC_REPORT_MAX_BYTES, signal });
  return { generation: response.generation, report: parseSyncReport(response.data) };
}
export async function controlBackfill(backend: BackendHost, operation: 'pause' | 'retry', signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'POST', path: operation === 'pause' ? '/api/sync/backfill/pause' : '/api/sync/backfill/retry',
    body: {}, timeoutMs: 12_000, maxResponseBytes: SYNC_REPORT_MAX_BYTES, signal });
  return { generation: response.generation, report: parseSyncReport(response.data) };
}

export async function setSyncScope(backend: BackendHost, mode: SyncScope, signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'POST', path: '/api/sync/scope',
    body: { mode, confirmed: true }, timeoutMs: 12_000, maxResponseBytes: SYNC_REPORT_MAX_BYTES, signal });
  return { generation: response.generation, report: parseSyncReport(response.data) };
}
export async function setHistoryAuthorization(backend: BackendHost, decision: HistoryAuthorizationDecision, signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'POST', path: '/api/sync/history-authorization',
    body: { decision, confirmed: true }, timeoutMs: 12_000, maxResponseBytes: SYNC_REPORT_MAX_BYTES, signal });
  return { generation: response.generation, report: parseSyncReport(response.data) };
}
