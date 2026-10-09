import type { BackgroundSyncPhase, ForegroundReportPhase, SyncBackfillPhase, SyncBackfillReport, SyncStatusReport } from '../../shared/sync-control-bridge';
import type { BackendHost } from '../backend/host';

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
  return { enabled: fields.sync_enabled, backgroundPhase: fields.cli_sync_phase as BackgroundSyncPhase,
    backgroundFailureCode: failureCode(fields.cli_failure_code), cliAvailable: fields.cli_available,
    confirmedBindingCount: fields.cli_bound_count, foregroundPhase: fields.foreground_phase as ForegroundReportPhase,
    foregroundFailureCode: failureCode(fields.foreground_failure_code), probeAvailable: fields.probe_available,
    wechatInFront: fields.wechat_in_front, backfill: backfillReport(fields) };
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
