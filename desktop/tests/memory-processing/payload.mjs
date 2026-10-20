import { ids } from '../layered-memory/support.mjs';
export function processingPayload(overrides = {}) {
  return { scope: 'contact', contact_id: ids.contact, has_more: false, tasks: [{ task_id: ids.work, contact_id: ids.contact,
    task_type: 'import', status: 'interrupted', phase: 'extraction', processed_count: 20, total_count: 53,
    created_count: null, updated_count: null, updated_at: '2026-10-20T10:00:00+08:00', reason_code: 'execution_interrupted', action: 'resume', ...overrides }] };
}
