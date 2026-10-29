/** 历史执行方是启动期唯一配置；不支持请求级切换或因传输缺失回退到另一写者。 */
export type HistoryRuntime = 'typescript';

export function resolveHistoryRuntime(
  environment: NodeJS.ProcessEnv,
  options: {incrementalRemoteAvailable: boolean},
): HistoryRuntime {
  const raw = environment.NOTALONE_HISTORY_RUNTIME;
  const runtime = raw === undefined ? 'typescript' : raw;
  if (runtime !== 'typescript') throw new Error('history_runtime_invalid');
  if (!options.incrementalRemoteAvailable)
    throw new Error('history_runtime_incremental_required');
  return runtime;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const phases = new Set(['not_started','syncing','complete','incomplete']);
const failureCode = /^[a-z][a-z0-9_]{0,95}$/;
const nullableTimestamp = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('history_coverages_invalid');
  return value;
};
const nullableCursor = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error('history_coverages_invalid');
  return value;
};
const count = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('history_coverages_invalid');
  return value as number;
};

/** 只投影既有桌面状态合同字段；验证失败交给宿主映射为 sync_status_unavailable。 */
export function projectHistoryCoverages(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('history_coverages_invalid');
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('history_coverages_invalid');
    const row = item as Record<string, unknown>;
    if (typeof row.binding_id !== 'string' || !uuid.test(row.binding_id)
      || typeof row.contact_id !== 'string' || !uuid.test(row.contact_id)
      || typeof row.phase !== 'string' || !phases.has(row.phase)
      || (row.failure_code !== null && (typeof row.failure_code !== 'string' || !failureCode.test(row.failure_code))))
      throw new Error('history_coverages_invalid');
    return {
      binding_id: row.binding_id.toLowerCase(),
      contact_id: row.contact_id.toLowerCase(),
      phase: row.phase,
      failure_code: row.failure_code,
      message_count: count(row.message_count),
      non_text_count: count(row.non_text_count),
      page_count: count(row.page_count),
      last_cursor: nullableCursor(row.last_cursor),
      watermark_at: nullableTimestamp(row.watermark_at),
      started_at: nullableTimestamp(row.started_at),
      completed_at: nullableTimestamp(row.completed_at),
      updated_at: nullableTimestamp(row.updated_at),
    };
  });
}
