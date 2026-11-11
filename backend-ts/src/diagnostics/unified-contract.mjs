// 注册表是写入、导出和命令行读取的共同隐私边界；任何额外字段整条拒绝。
export const diagnosticModules = Object.freeze(['contacts', 'memory.management', 'memory.processing', 'history.sync', 'media', 'reply', 'deletion', 'startup', 'foreground', 'diagnostics']);
export const diagnosticReasons = Object.freeze(['scope_changed', 'connection_changed', 'contact_selected', 'contact_removed', 'directory_missing', 'directory_failed', 'reading_scope_changed', 'source_deleted', 'contact_deleted', 'history_cleared', 'application_quit', 'user_release', 'request_started', 'request_completed', 'request_failed', 'request_timeout', 'request_aborted', 'response_invalid', 'response_unavailable', 'source_stale', 'late_response', 'revision_changed', 'request_slow', 'sql_slow', 'enabled', 'disabled', 'cleared', 'started', 'completed', 'failed', 'paused', 'resumed', 'retry', 'cancelled', 'authorization_revoked', 'source_changed', 'image_late_ready', 'image_unavailable', 'model_unavailable', 'lease_lost', 'shutdown', 'not_ready', 'permission_missing', 'ambiguous', 'unmatched', 'timeout', 'aborted', 'rejected', 'degraded', 'budget_exhausted', 'no_change', 'receipt_unknown', 'worker_interrupted', 'policy_changed', 'targets_completed_elsewhere', 'waiting_window', 'content_rejected', 'claim_failed']);
export const diagnosticCallers = Object.freeze(['select_contact', 'connection_generation', 'reading_scope_begin', 'reading_scope_end', 'directory_missing', 'directory_failed', 'contact_removed', 'management_read', 'management_history', 'management_documents', 'management_decide', 'management_release', 'data_lifecycle', 'foreground_scope_change', 'application_quit', 'memory_scope_listener', 'management_read_failed', 'management_history_failed', 'management_documents_failed', 'management_decision_failed', 'backend_state_changed', 'request_json', 'sqlite_worker', 'sqlite_readonly_worker', 'settings', 'memory_processing', 'memory_run', 'memory_task', 'memory_batch', 'history_sync', 'media_read', 'reply_generate', 'source_deletion', 'contact_deletion', 'history_clear', 'foreground_controller', 'startup_controller', 'backend_startup', 'diagnostic_cli']);
export const diagnosticStates = Object.freeze(['idle', 'queued', 'pending', 'running', 'ready', 'paused', 'blocked', 'failed', 'completed', 'cancelled', 'revoked', 'stopped', 'enabled', 'disabled', 'preparing', 'processing', 'succeeded', 'interrupted', 'waiting', 'partial', 'unknown', 'incomplete', 'awaiting_decision', 'scheduled', 'superseded']);
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
  'processing.model_call': schema('memory.processing', 'info', ['callId', 'originalBytes', 'sentBytes', 'imageCount', 'requestBytes', 'durationMs', 'stage', 'failureCategory', 'toState']),
  'processing.model_image': schema('memory.processing', 'info', ['callId', 'imageId', 'originalBytes', 'sentBytes', 'imageCount', 'requestBytes', 'width', 'height', 'mimeType', 'durationMs', 'stage', 'failureCategory']),
  'sync.decision': schema('history.sync', 'info', ['count', 'durationMs']),
  'sync.completed': schema('history.sync', 'info', ['count', 'durationMs']),
  'media.decision': schema('media', 'info', ['count', 'durationMs']),
  'reply.decision': schema('reply', 'info', ['count', 'durationMs']),
  'deletion.decision': schema('deletion', 'info', ['count', 'durationMs']),
  'foreground.decision': schema('foreground', 'info', ['count', 'durationMs']),
  'startup.decision': schema('startup', 'info', ['count', 'durationMs']),
  'diagnostics.error': schema(null, 'error', ['durationMs', 'count']),
  'diagnostics.changed': schema('diagnostics', 'info', ['count']),
});
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const validators = {
  traceId: uuid, interruptedTraceId: uuid, runId: uuid, taskId: uuid, batchId: uuid, callId: uuid, imageId: uuid,
  reasonCode: value => diagnosticReasons.includes(value), caller: value => diagnosticCallers.includes(value),
  contactPrefix: value => typeof value === 'string' && /^[0-9a-f]{8}$/.test(value),
  durationMs: finite, count: value => Number.isSafeInteger(value) && finite(value),
  fromRevision: value => Number.isSafeInteger(value) && finite(value), toRevision: value => Number.isSafeInteger(value) && finite(value),
  fromState: value => diagnosticStates.includes(value), toState: value => diagnosticStates.includes(value),
  sqlFingerprint: value => typeof value === 'string' && /^[0-9a-f]{16,64}$/.test(value),
  originalBytes: value => Number.isSafeInteger(value) && finite(value), sentBytes: value => Number.isSafeInteger(value) && finite(value),
  requestBytes: value => Number.isSafeInteger(value) && finite(value), imageCount: value => Number.isSafeInteger(value) && value >= 1 && value <= 8,
  width: value => Number.isSafeInteger(value) && value >= 1 && value <= 32768, height: value => Number.isSafeInteger(value) && value >= 1 && value <= 32768,
  mimeType: value => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value),
  stage: value => ['before_send', 'awaiting_response', 'response_received'].includes(value),
  failureCategory: value => ['none', 'socket_closed', 'reset', 'timeout', 'tls', 'dns', 'other', 'image_budget', 'image_invalid', 'model_budget', 'cancelled'].includes(value),
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
