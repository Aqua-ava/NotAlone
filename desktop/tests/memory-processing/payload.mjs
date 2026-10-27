import { ids, payload } from '../layered-memory/support.mjs';
export function lifecyclePayload(overrides = {}) {
  return { scope: 'contact', contact_id: ids.contact, control_generation: 0,
    current: { status: 'waiting', round_id: null, phase: null, processed_count: null, total_count: null, unit: null,
      pending_count: 0, reason: '暂无待处理资料。', reason_code: null, has_usable_results: false, actions: [] },
    history: { entries: [], next_cursor: null }, ...overrides };
}

function otherResponse(request) {
  if (request.path.startsWith('/api/tasks')) return { tasks: [{ task_id: ids.work, task_type: 'observation', contact_id: ids.contact,
    scope_kind: 'contact', status: 'failed', phase: 'extract_memory', message_count: 53, retry_count: 1, error_code: 'synthetic_failure',
    processed_count: 20, total_count: 53, work_revision: null, settings_generation: null, updated_at: '2026-10-20T02:00:00Z', steps: [], actions: [] }], has_more: false };
  return request.path.includes('/layered-memory') ? payload() : request.path.endsWith('/sources') ? { sources: [] }
    : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] };
}


export { otherResponse };
