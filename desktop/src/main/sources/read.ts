import type { DeletionSource, DeletionTask, DeletionStepName } from '../../shared/source-deletion-bridge';
import { isUuid } from '../uuid';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const names: DeletionStepName[] = ['mark_deleted', 'delete_derived', 'delete_index', 'clear_cache', 'verify_not_retrievable'];
const statuses = ['queued', 'running', 'verifying', 'succeeded', 'failed', 'cancelled'];
const invalid = () => new Error('删除结果暂时无法核验。');
export function deletionTask(value: unknown, taskId: string): DeletionTask {
  if (!record(value) || value.task_type !== 'delete' || value.task_id !== taskId || !statuses.includes(value.status as string)
    || !names.includes(value.step as DeletionStepName) || !Array.isArray(value.steps) || value.steps.length !== names.length) throw invalid();
  const steps = value.steps.map((step, index) => {
    if (!record(step) || step.name !== names[index] || !['pending', 'running', 'succeeded', 'retryable', 'failed', 'cancelled'].includes(step.status as string)) throw invalid();
    return { name: names[index], status: step.status as DeletionTask['steps'][number]['status'] };
  });
  if (value.status === 'succeeded' && steps.some((step) => step.status !== 'succeeded')) throw invalid();
  return { taskId, status: value.status as DeletionTask['status'], step: value.step as DeletionStepName, steps };
}
export function deletionSources(value: unknown): { source: DeletionSource; taskId: string | null }[] {
  if (!record(value) || !Array.isArray(value.sources)) throw invalid();
  const known = new Set<string>();
  return value.sources.map((entry) => {
    if (!record(entry) || !isUuid(entry.source_id) || known.has(entry.source_id)
      || !(entry.file_name === null || typeof entry.file_name === 'string')
      || typeof entry.record_count !== 'number' || !Number.isSafeInteger(entry.record_count) || entry.record_count < 0
      || !['active', 'delete_requested', 'deleting', 'delete_failed', 'deleted'].includes(entry.status as string)
      || !(entry.task_id === null || isUuid(entry.task_id))) throw invalid();
    known.add(entry.source_id);
    return { source: { sourceId: entry.source_id, fileName: entry.file_name, recordCount: entry.record_count,
      status: entry.status as DeletionSource['status'], task: null }, taskId: entry.task_id };
  });
}
export function deletionReceipt(value: unknown): string {
  if (!record(value) || !isUuid(value.task_id) || !statuses.includes(value.status as string)) throw invalid();
  return value.task_id;
}
