import type { BackgroundSyncPhase, ForegroundReportPhase, SyncBackfillPhase, SyncBackfillReport, SyncPriorityReport, SyncStatusReport, SyncScope } from '../../shared/sync-control-bridge';
import type { BackendHost } from '../backend/host';
import { isUuid } from '../uuid';

const backgroundPhases: BackgroundSyncPhase[] = ['disabled', 'waiting_bindings', 'active', 'degraded'];
const foregroundPhases: ForegroundReportPhase[] = ['sync_disabled', 'waiting_foreground', 'unavailable', 'active', 'failed'];
const backfillPhases: SyncBackfillPhase[] = ['not_required', 'gap_detected', 'backfilling', 'complete', 'failed', 'incomplete', 'paused'];

function failureCode(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(value)) throw new Error('同步报告不可用。');
  return value;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('同步报告不可用。');
  return value;
}
function priorityReport(fields: Record<string, unknown>): SyncPriorityReport | undefined {
  // 旧后台没有优先读取指标；不把未测量的数据填成零。
  if (!('cli_priority_contact_id' in fields)) return undefined;
  const contactId = fields.cli_priority_contact_id;
  const lastSuccessAt = fields.cli_priority_last_success_at;
  if (!(contactId === null || isUuid(contactId)) || !(lastSuccessAt === null
    || (typeof lastSuccessAt === 'string' && lastSuccessAt.length <= 64
      && /^\d{4}-\d{2}-\d{2}T/.test(lastSuccessAt) && Number.isFinite(Date.parse(lastSuccessAt))))) {
    throw new Error('同步报告不可用。');
  }
  const duration = (key: string) => fields[key] === null ? null : count(fields[key]);
  const localHistoryState = fields.cli_priority_local_history_state;
  if (localHistoryState !== undefined && localHistoryState !== null && localHistoryState !== 'deleted' && localHistoryState !== 'empty') {
    throw new Error('同步报告不可用。');
  }
  return { contactId: contactId === null ? null : contactId.toLowerCase(), lastSuccessAt,
    lastDurationMs: duration('cli_priority_last_duration_ms'),
    lastCliDurationMs: duration('cli_priority_last_cli_duration_ms'),
    lastStoreDurationMs: duration('cli_priority_last_store_duration_ms'),
    lastFailureCode: failureCode(fields.cli_priority_last_failure_code),
    ...('cli_priority_local_history_state' in fields ? { localHistoryState } : {}),
    queueWaitMs: duration('cli_priority_queue_wait_ms') };
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
function parseSyncReport(value: unknown): SyncStatusReport {
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
  return { syncScope: (fields.sync_scope ?? 'selected') as SyncScope,
    syncScopeFailureCode: 'sync_scope_failure_code' in fields ? failureCode(fields.sync_scope_failure_code) : null,
    enabled: fields.sync_enabled, backgroundPhase: fields.cli_sync_phase as BackgroundSyncPhase,
    backgroundFailureCode: failureCode(fields.cli_failure_code), cliAvailable: fields.cli_available,
    confirmedBindingCount: fields.cli_bound_count, foregroundPhase: fields.foreground_phase as ForegroundReportPhase,
    foregroundFailureCode: failureCode(fields.foreground_failure_code), probeAvailable: fields.probe_available,
    wechatInFront: fields.wechat_in_front, backfill: backfillReport(fields),
    ...('cli_priority_contact_id' in fields ? { priority: priorityReport(fields) } : {}) };
}

export async function readSyncStatus(backend: BackendHost, signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'GET', path: '/api/sync/status',
    timeoutMs: 12_000, maxResponseBytes: 16_384, signal });
  return { generation: response.generation, report: parseSyncReport(response.data) };
}
export async function setSyncEnabled(backend: BackendHost, enabled: boolean, signal: AbortSignal) {
  // 只改变既有总开关，正文范围、读取算法和补齐仍由原同步宿主决定。
  const response = await backend.requestJson({ method: 'POST', path: enabled ? '/api/sync/enable' : '/api/sync/disable',
    body: {}, timeoutMs: 12_000, maxResponseBytes: 16_384, signal });
  return { generation: response.generation, report: parseSyncReport(response.data) };
}
export async function controlBackfill(backend: BackendHost, operation: 'pause' | 'retry', signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'POST', path: operation === 'pause' ? '/api/sync/backfill/pause' : '/api/sync/backfill/retry',
    body: {}, timeoutMs: 12_000, maxResponseBytes: 16_384, signal });
  return { generation: response.generation, report: parseSyncReport(response.data) };
}

export async function setSyncScope(backend: BackendHost, mode: SyncScope, signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'POST', path: '/api/sync/scope',
    body: { mode, confirmed: true }, timeoutMs: 12_000, maxResponseBytes: 16_384, signal });
  return { generation: response.generation, report: parseSyncReport(response.data) };
}
