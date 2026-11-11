// 注册表是写入、导出和命令行读取的共同隐私边界；任何额外字段整条拒绝。
export const diagnosticModules = Object.freeze(['contacts', 'memory.management', 'memory.processing', 'history.sync', 'media', 'reply', 'deletion', 'startup', 'foreground', 'diagnostics']);
export const diagnosticReasons = Object.freeze(['scope_changed', 'connection_changed', 'contact_selected', 'contact_removed', 'directory_missing', 'directory_failed', 'reading_scope_changed', 'source_deleted', 'contact_deleted', 'history_cleared', 'application_quit', 'user_release', 'request_started', 'request_completed', 'request_failed', 'request_timeout', 'request_aborted', 'response_invalid', 'response_unavailable', 'source_stale', 'late_response', 'revision_changed', 'request_slow', 'sql_slow', 'enabled', 'disabled', 'cleared', 'started', 'completed', 'failed', 'paused', 'resumed', 'retry', 'cancelled', 'authorization_revoked', 'source_changed', 'image_late_ready', 'image_unavailable', 'model_unavailable', 'lease_lost', 'shutdown', 'not_ready', 'permission_missing', 'ambiguous', 'unmatched', 'timeout', 'aborted', 'rejected', 'degraded', 'budget_exhausted', 'no_change', 'receipt_unknown', 'worker_interrupted', 'policy_changed', 'targets_completed_elsewhere', 'waiting_window', 'content_rejected', 'claim_failed', 'G01', 'G02', 'G03', 'G04', 'T01', 'T02', 'T03', 'N01', 'N02', 'N03', 'N04', 'N05', 'N06', 'N07', 'A01', 'A02', 'R01', 'R02', 'L01', 'C01', 'thumbnail_only', 'media_key_missing', 'association_failed', 'context_frozen', 'runtime_ready', 'diagnostic_cleanup_failed', 'begin', 'context_unavailable', 'context_changed', 'window_unavailable', 'display_unsupported', 'source_rect_invalid', 'first_frame', 'output_dimensions', 'pixel_format', 'buffer_lock', 'missing_buffer', 'frame_limit', 'detector_failed', 'stream_error', 'stream_connection_invalid', 'stream_connection_interrupted', 'stream_context_missing', 'stream_system_stopped', 'stream_user_stopped', 'stream_permission_declined', 'stream_missing_entitlements', 'stream_internal', 'stream_invalid_parameter', 'stream_start_failed', 'operation_failed', 'lease_expired', 'stopped', 'instances_ambiguous', 'instances_zero', 'instances_multiple', 'foreground_unknown', 'not_wechat_foreground', 'version_unsupported', 'window_list_unavailable', 'window_not_visible', 'windows_ambiguous', 'window_geometry_invalid', 'identity_mismatch']);
export const diagnosticCallers = Object.freeze(['select_contact', 'connection_generation', 'reading_scope_begin', 'reading_scope_end', 'directory_missing', 'directory_failed', 'contact_removed', 'management_read', 'management_history', 'management_documents', 'management_decide', 'management_release', 'data_lifecycle', 'foreground_scope_change', 'application_quit', 'memory_scope_listener', 'management_read_failed', 'management_history_failed', 'management_documents_failed', 'management_decision_failed', 'backend_state_changed', 'request_json', 'sqlite_worker', 'sqlite_readonly_worker', 'settings', 'memory_processing', 'memory_run', 'memory_task', 'memory_batch', 'history_sync', 'media_read', 'reply_generate', 'source_deletion', 'contact_deletion', 'history_clear', 'foreground_controller', 'startup_controller', 'backend_startup', 'diagnostic_cli', 'history_first', 'history_incremental', 'diagnostic_transaction', 'diagnostic_transport', 'diagnostic_lazy', 'diagnostic_writer', 'media_extract', 'media_preview', 'media_memory_image', 'reply_http', 'account_deletion', 'foreground_probe', 'foreground_native', 'foreground_context']);
export const diagnosticStates = Object.freeze(['idle', 'queued', 'pending', 'running', 'ready', 'paused', 'blocked', 'failed', 'completed', 'cancelled', 'revoked', 'stopped', 'enabled', 'disabled', 'preparing', 'processing', 'succeeded', 'interrupted', 'waiting', 'partial', 'unknown', 'incomplete', 'awaiting_decision', 'scheduled', 'superseded', 'generating', 'saving']);
const common = ['traceId', 'reasonCode', 'caller', 'contactPrefix'];
const schema = (module, level, fields) => Object.freeze({ module, level, fields: Object.freeze([...common, ...fields]) });
export const diagnosticEvents = Object.freeze({
  'scope.revision_changed': schema('contacts', 'info', ['fromRevision', 'toRevision', 'interruptedTraceId']),
  'management.synchronize': schema('memory.management', 'debug', ['fromRevision', 'toRevision', 'interruptedTraceId']),
  'management.invalidated': schema('memory.management', 'info', ['fromRevision', 'toRevision', 'interruptedTraceId']),
  'management.released': schema('memory.management', 'info', ['interruptedTraceId']),
  'lifecycle.invalidated': schema('deletion', 'info', ['interruptedTraceId', 'count']),
  'request.started': schema(null, 'debug', []),
  'request.finished': schema(null, 'debug', ['durationMs', 'count']),
  'request.slow': schema(null, 'warn', ['durationMs', 'count']),
  'request.failed': schema(null, 'warn', ['durationMs']),
  'sql.summary': schema(null, 'debug', ['sqlFingerprint', 'count', 'durationMs']),
  'sql.slow': schema(null, 'warn', ['sqlFingerprint', 'count', 'durationMs']),
  'processing.run_changed': schema('memory.processing', 'info', ['runId', 'taskId', 'fromState', 'toState', 'count', 'durationMs']),
  'processing.task_changed': schema('memory.processing', 'info', ['runId', 'taskId', 'fromState', 'toState', 'count', 'durationMs']),
  'processing.batch_changed': schema('memory.processing', 'info', ['runId', 'taskId', 'batchId', 'fromState', 'toState', 'count', 'durationMs']),
  'processing.control_changed': schema('memory.processing', 'info', ['runId', 'fromState', 'toState', 'count']),
  'processing.image_excluded': schema('memory.processing', 'info', ['runId', 'taskId', 'count']),
  'sync.state_changed': schema('history.sync', 'info', ['fromState', 'toState', 'durationMs']),
  'sync.continuity': schema('history.sync', 'info', []),
  'sync.decision': schema('history.sync', 'info', ['count', 'durationMs']),
  'sync.completed': schema('history.sync', 'info', ['count', 'durationMs']),
  'media.decision': schema('media', 'info', ['count', 'durationMs']),
  'reply.state_changed': schema('reply', 'info', ['fromState', 'toState', 'durationMs']),
  'reply.decision': schema('reply', 'info', ['count', 'durationMs']),
  'deletion.decision': schema('deletion', 'info', ['count', 'durationMs', 'taskId']),
  'foreground.state_changed': schema('foreground', 'info', ['fromState', 'toState', 'durationMs']),
  'foreground.decision': schema('foreground', 'info', ['count', 'durationMs']),
  'startup.decision': schema('startup', 'info', ['count', 'durationMs']),
  'diagnostics.error': schema(null, 'error', ['durationMs', 'count']),
  'diagnostics.changed': schema('diagnostics', 'info', ['count']),
});
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const validators = {
  traceId: uuid, interruptedTraceId: uuid, runId: uuid, taskId: uuid, batchId: uuid,
  reasonCode: value => diagnosticReasons.includes(value), caller: value => diagnosticCallers.includes(value),
  contactPrefix: value => typeof value === 'string' && /^[0-9a-f]{8}$/.test(value),
  durationMs: finite, count: value => Number.isSafeInteger(value) && finite(value),
  fromRevision: value => Number.isSafeInteger(value) && finite(value), toRevision: value => Number.isSafeInteger(value) && finite(value),
  fromState: value => diagnosticStates.includes(value), toState: value => diagnosticStates.includes(value),
  sqlFingerprint: value => typeof value === 'string' && /^[0-9a-f]{16,64}$/.test(value),
};
function dataFields(value) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) return;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(field => !('value' in field))) return;
  return Object.fromEntries(Object.entries(descriptors).map(([key, field]) => [key, field.value]));
}
export function checkedDiagnosticEvent(value) {
  try {
    const input = dataFields(value);
    if (!input || typeof input.event !== 'string') return;
    const rule = Object.hasOwn(diagnosticEvents, input.event) && diagnosticEvents[input.event];
    if (!rule) return;
    const module = input.module ?? rule.module;
    if (!diagnosticModules.includes(module) || rule.module && module !== rule.module) return;
    if (Object.keys(input).some(key => key !== 'event' && key !== 'module' && (!rule.fields.includes(key) || !validators[key](input[key])))) return;
    return { ...input, module };
  } catch { /* 不读取异常正文，也不向业务抛出诊断失败。 */ }
}
export function checkedDiagnosticRecord(value) {
  try {
    const input = dataFields(value);
    if (!input || !['main', 'backend', 'renderer'].includes(input.proc) || !['debug', 'info', 'warn', 'error'].includes(input.level)
      || typeof input.time !== 'string' || new Date(input.time).toISOString() !== input.time) return;
    const { time, level, proc, ...event } = input;
    const checked = checkedDiagnosticEvent(event);
    if (!checked || level !== diagnosticEvents[checked.event].level) return;
    return { ...checked, time, level, proc };
  } catch { /* 损坏或越界记录不进入查询及导出。 */ }
}
