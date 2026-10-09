import type { ImportReceipt, ImportSource, ImportStepName, ImportTask, ImportTaskStatus } from '../../shared/import-bridge';
import { normalizeUuid } from '../uuid';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const names: ImportStepName[] = ['parse', 'normalize', 'extract_memory', 'index', 'verify'];
const statuses: ImportTaskStatus[] = ['queued', 'running', 'verifying', 'succeeded', 'failed', 'cancelled'];
const stepStatuses = ['pending', 'running', 'succeeded', 'retryable', 'failed', 'cancelled'];
const invalid = () => new Error('导入处理结果暂时无法核验。');
const count = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
};
const identifier = (value: unknown): string => { const id = normalizeUuid(value); if (!id) throw invalid(); return id; };

// 仅展示固定安全分类，不将后端异常、模型输出或未知错误字符串交给界面。
function taskError(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw invalid();
  const messages: Record<string, string> = {
    model_configuration_unavailable: '模型配置不可用，请检查应用配置后继续原任务。',
    execution_resources_unavailable: '处理资源暂不可用，资料已保存，请稍后继续原任务。',
    memory_extraction_failed: '关系提取未完成，已保存的消息保留，可重试原失败任务。',
    index_rebuild_failed: '关系目录更新失败，可重试原失败任务。',
    index_verification_failed: '关系目录核验失败，尚未完成处理。',
    temporary_failure: '处理暂时失败，后端按原任务的重试规则恢复。',
  };
  return messages[value] ?? '该步骤未完成，请检查配置或稍后重试原任务。';
}

export function importReceipt(value: unknown): ImportReceipt {
  if (!record(value)) throw invalid();
  return { contactId: identifier(value.contact_id), taskId: identifier(value.task_id),
    importedCount: count(value.imported_count), skippedDuplicates: count(value.skipped_duplicates) };
}

export function importTask(value: unknown, receipt: ImportReceipt): ImportTask {
  if (!record(value) || value.task_type !== 'import' || identifier(value.task_id) !== receipt.taskId
    || !statuses.includes(value.status as ImportTaskStatus) || !names.includes(value.step as ImportStepName)
    || !Array.isArray(value.steps) || value.steps.length !== names.length) throw invalid();
  const steps = value.steps.map((step, index): ImportTask['steps'][number] => {
    if (!record(step) || step.name !== names[index] || !stepStatuses.includes(step.status as string)) throw invalid();
    return { name: names[index], status: step.status as ImportTask['steps'][number]['status'],
      attemptCount: count(step.attempt_count), processedCount: count(step.processed_count), totalCount: count(step.total_count), error: taskError(step.error_code) };
  });
  if (value.status === 'succeeded' && steps.some((step) => step.status !== 'succeeded')) throw invalid();
  return { taskId: receipt.taskId, status: value.status as ImportTaskStatus, step: value.step as ImportStepName,
    messageCount: count(value.message_count), retryCount: count(value.retry_count), error: taskError(value.error_code), steps };
}

export function importSources(value: unknown): ImportSource[] {
  if (!record(value) || !Array.isArray(value.sources)) throw invalid();
  return value.sources.map((source) => {
    if (!record(source) || typeof source.file_name !== 'string' || !source.file_name
      || !['active', 'delete_requested', 'deleted'].includes(source.status as string)) throw invalid();
    return { sourceId: identifier(source.source_id), fileName: source.file_name, recordCount: count(source.record_count), status: source.status as ImportSource['status'] };
  });
}
