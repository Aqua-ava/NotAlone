import type { ContactDeletionItem, ContactDeletionPhase } from '../../shared/contact-deletion-bridge';
import { isUuid } from '../uuid';

const phases = new Set(['fenced', 'cleaning', 'verifying', 'blocked', 'completed']);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('联系人删除状态不可用。');

export function deletionReceipt(value: unknown): string {
  if (!record(value) || !isUuid(value.operation_id) || !phases.has(String(value.state))) throw invalid();
  return value.operation_id.toLowerCase();
}

export function deletionOperation(value: unknown): ContactDeletionItem {
  if (!record(value) || value.scope_kind !== 'contact' || !isUuid(value.operation_id) || !phases.has(String(value.state))) throw invalid();
  if (value.state === 'completed') {
    if (value.status !== 'succeeded' || typeof value.finished_at !== 'string' || !Number.isFinite(Date.parse(value.finished_at))
      || !Array.isArray(value.checks) || !value.checks.some(check => record(check) && check.kind === 'final_recheck' && check.result === 'passed')
      || value.checks.some(check => !record(check) || !['passed', 'not_applicable'].includes(String(check.result)))) throw invalid();
  } else if (!isUuid(value.contact_id)) throw invalid();
  if (value.error_code !== null && value.error_code !== undefined
    && (typeof value.error_code !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(value.error_code))) throw invalid();
  return { id: value.operation_id.toLowerCase(), operationId: value.operation_id.toLowerCase(),
    contactId: value.state === 'completed' ? null : (value.contact_id as string).toLowerCase(), displayName: null,
    phase: value.state as ContactDeletionPhase, errorCode: typeof value.error_code === 'string' ? value.error_code : null };
}

export function deletionOperations(value: unknown): ContactDeletionItem[] {
  if (!record(value) || !Array.isArray(value.operations)) throw invalid();
  const items = value.operations.filter(item => record(item) && item.scope_kind === 'contact').map(deletionOperation);
  if (new Set(items.map(item => item.operationId)).size !== items.length) throw invalid();
  return items;
}
