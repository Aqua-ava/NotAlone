import type { BackgroundSyncPhase, ForegroundReportPhase, SyncStatusReport } from '../../shared/sync-control-bridge';
import type { BackendHost } from '../backend/host';

const backgroundPhases: BackgroundSyncPhase[] = ['disabled', 'waiting_bindings', 'active', 'degraded'];
const foregroundPhases: ForegroundReportPhase[] = ['sync_disabled', 'waiting_foreground', 'unavailable', 'active', 'failed'];

function failureCode(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(value)) throw new Error('同步报告不可用。');
  return value;
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
    wechatInFront: fields.wechat_in_front };
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
