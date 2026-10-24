import type { UsageSummary, UsageEntry, UsageCostTotal } from '../../shared/usage-bridge';
const invalid = () => new Error('用量数据格式无效。');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}
function nullableCount(value: unknown): number | null { return value === null ? null : count(value); }
function label(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  return value;
}
function nullableLabel(value: unknown): string | null { return value === null ? null : label(value); }
function amount(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100 || !/^\d+(?:\.\d+)?$/.test(value)) throw invalid();
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw invalid(); return value as T;
}
function counts(value: unknown): Record<string, number> {
  const rows = record(value); if (Object.keys(rows).length > 100) throw invalid();
  return Object.fromEntries(Object.entries(rows).map(([key, value]) => [label(key), count(value)]));
}
function cost(value: unknown): UsageCostTotal {
  const row = record(value);
  return { status: choice(row.status, ['known', 'estimated']), currency: label(row.currency),
    pricingVersion: label(row.pricing_version), amount: amount(row.amount), calls: count(row.calls) };
}
function entry(value: unknown): UsageEntry {
  const row = record(value), calledAt = label(row.called_at);
  if (!Number.isFinite(Date.parse(calledAt)) || typeof row.confirmed !== 'boolean') throw invalid();
  const costStatus = choice(row.cost_status, ['known', 'estimated', 'unknown']);
  const costAmount = row.cost_amount === null ? null : amount(row.cost_amount);
  const currency = nullableLabel(row.currency), pricingVersion = nullableLabel(row.pricing_version);
  if (costStatus !== 'unknown' && (costAmount === null || currency === null || pricingVersion === null)
    || costStatus === 'unknown' && costAmount !== null) throw invalid();
  const dispatch = choice(row.dispatch, ['authorized_unconfirmed', 'response_observed', 'http_accepted', 'not_sent', 'legacy_recorded']);
  if (row.confirmed !== ['response_observed', 'http_accepted', 'legacy_recorded'].includes(dispatch)) throw invalid();
  return { scopeKind: choice(row.scope_kind, ['contact', 'owner_memory']), provider: label(row.provider), modelName: label(row.model_name),
    calledAt, latencyMs: nullableCount(row.latency_ms), dispatch,
    outcome: choice(row.outcome, ['pending', 'succeeded', 'failed', 'cancelled', 'unknown', 'run_failed', 'rejected_by_validation']),
    inputTokens: nullableCount(row.input_tokens), outputTokens: nullableCount(row.output_tokens),
    cacheReadTokens: nullableCount(row.cache_read_tokens), cacheWriteTokens: nullableCount(row.cache_write_tokens),
    costStatus, costAmount, currency, pricingVersion, source: choice(row.source, ['receipt', 'legacy']), confirmed: row.confirmed };
}
// 显式重建 DTO；不把范围标识、正文或新增 HTTP 字段透传给页面。
export function readUsageSummary(value: unknown): UsageSummary {
  const row = record(value);
  if (row.schema_version !== 1 || !Array.isArray(row.recent) || row.recent.length > 10
    || !Array.isArray(row.cost_totals) || row.cost_totals.length > 100) throw invalid();
  return { totalCalls: count(row.total_calls), totalAttempts: count(row.total_attempts),
    authorizedUnconfirmedCalls: count(row.authorized_unconfirmed_calls), notSentAttempts: count(row.not_sent_attempts),
    unknownUsageCalls: count(row.unknown_usage_calls), totalInputTokens: nullableCount(row.total_input_tokens),
    totalOutputTokens: nullableCount(row.total_output_tokens), knownInputTokens: count(row.known_input_tokens),
    knownOutputTokens: count(row.known_output_tokens), unknownCostCalls: count(row.unknown_cost_calls),
    providerCounts: counts(row.provider_counts), outcomeCounts: counts(row.outcome_counts),
    costTotals: row.cost_totals.map(cost), recent: row.recent.map(entry) };
}
