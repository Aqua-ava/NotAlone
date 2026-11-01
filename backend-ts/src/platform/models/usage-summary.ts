import type { StorageAction, StorageRow, StorageTransaction } from '../../storage/sqlite/contracts.ts';

type Usage = { input_tokens: number; output_tokens: number; cache_read_tokens: number | null; cache_write_tokens: number | null };
type Cost = { status: 'known' | 'estimated'; amount: string; currency: string; pricing_version: string };
type Receipt = Record<string, unknown>;
const dispatches = ['authorized_unconfirmed', 'response_observed', 'http_accepted', 'not_sent', 'legacy_recorded'] as const;
const outcomes = ['pending', 'succeeded', 'failed', 'cancelled', 'unknown', 'run_failed', 'rejected_by_validation'] as const;
const amountPattern = /^\d+(?:\.\d+)?$/;

function object(value: unknown): Receipt | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Receipt : null;
}
function receipt(value: unknown): Receipt | null {
  if (typeof value !== 'string') return object(value);
  try { return object(JSON.parse(value)); } catch { return null; }
}
function safeCount(value: unknown): number | null {
  if (typeof value === 'bigint') return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function usage(value: unknown): Usage | null {
  const row = object(value);
  if (!row) return null;
  const input = safeCount(row.input_tokens ?? row.inputTokens), output = safeCount(row.output_tokens ?? row.outputTokens);
  const rawCacheRead = row.cache_read_tokens ?? row.cacheReadTokens ?? null;
  const rawCacheWrite = row.cache_write_tokens ?? row.cacheWriteTokens ?? null;
  const cacheRead = rawCacheRead === null ? null : safeCount(rawCacheRead);
  const cacheWrite = rawCacheWrite === null ? null : safeCount(rawCacheWrite);
  if (input === null || output === null || rawCacheRead !== null && cacheRead === null
    || rawCacheWrite !== null && cacheWrite === null || (cacheRead ?? 0) + (cacheWrite ?? 0) > input) return null;
  return { input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite };
}
function cost(value: unknown): Cost | null {
  const row = object(value);
  if (!row || row.status !== 'known' && row.status !== 'estimated' || typeof row.amount !== 'string'
    || row.amount.length > 100 || !amountPattern.test(row.amount) || typeof row.currency !== 'string'
    || !row.currency.trim() || row.currency.length > 40 || typeof row.pricing_version !== 'string'
    || !row.pricing_version.trim() || row.pricing_version.length > 100) return null;
  return { status: row.status, amount: row.amount, currency: row.currency, pricing_version: row.pricing_version };
}
function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 80 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function calledAt(row: StorageRow, details: Receipt | null): string {
  const fromReceipt = isoDate(details?.called_at);
  if (fromReceipt) return fromReceipt;
  const stamp = safeCount(row.received_at) ?? safeCount(row.sent_at) ?? 0;
  return new Date(stamp).toISOString();
}
function dispatch(row: StorageRow, details: Receipt | null): typeof dispatches[number] {
  if (dispatches.includes(details?.dispatch as typeof dispatches[number])) return details!.dispatch as typeof dispatches[number];
  if (['dsh-physical-step-v1', 'dsh-assistant-event-v1'].includes(String(details?.format))
    && row.settlement_state === 'settled') return 'response_observed';
  if (row.state === 'succeeded' && row.settlement_state === 'settled') return 'response_observed';
  if (row.error_code === 'not_dispatched' || row.state === 'prepared' && row.sent_at === null) return 'not_sent';
  return 'authorized_unconfirmed';
}
function outcome(row: StorageRow, details: Receipt | null): typeof outcomes[number] {
  if (outcomes.includes(details?.outcome as typeof outcomes[number])) return details!.outcome as typeof outcomes[number];
  if (details?.legacy_outcome === 'rejected_by_validation' || details?.legacy_outcome === 'run_failed') return details.legacy_outcome;
  if (row.state === 'succeeded') return 'succeeded';
  if (row.state === 'failed') return 'failed';
  if (row.state === 'unknown') return 'unknown';
  return 'pending';
}
function addDecimal(a: { units: bigint; scale: number }, amount: string): void {
  const [whole, fraction = ''] = amount.split('.');
  const scale = fraction.length, nextScale = Math.max(a.scale, scale);
  a.units = a.units * 10n ** BigInt(nextScale - a.scale) + BigInt(whole + fraction.padEnd(nextScale, '0'));
  a.scale = nextScale;
}
function decimal(value: { units: bigint; scale: number }): string {
  if (!value.scale) return String(value.units);
  const digits = String(value.units).padStart(value.scale + 1, '0'), whole = digits.slice(0, -value.scale);
  const fraction = digits.slice(-value.scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** 将受当前owner约束的模型调用记录投影成UI合同，不返回回执、正文、请求键或凭据。 */
export function projectUsageSummary(rows: StorageRow[]) {
  const providerCounts: Record<string, number> = {}, outcomeCounts: Record<string, number> = {};
  const costTotals = new Map<string, { status: Cost['status']; currency: string; pricing_version: string; amount: { units: bigint; scale: number }; calls: number }>();
  let totalCalls = 0, authorizedUnconfirmedCalls = 0, notSentAttempts = 0, unknownUsageCalls = 0;
  let knownInputTokens = 0, knownOutputTokens = 0, allInputKnown = true, allOutputKnown = true;
  const projected = rows.map(row => {
    const details = receipt(row.receipt), state = outcome(row, details), sent = dispatch(row, details);
    const countedUsage = usage(details?.usage), countedCost = cost(details?.cost), confirmed = ['response_observed', 'http_accepted', 'legacy_recorded'].includes(sent);
    outcomeCounts[state] = (outcomeCounts[state] ?? 0) + 1;
    if (sent === 'authorized_unconfirmed') authorizedUnconfirmedCalls++;
    if (sent === 'not_sent') notSentAttempts++;
    if (confirmed) {
      totalCalls++;
      const provider = typeof details?.provider === 'string' && details.provider.trim() ? details.provider : String(row.provider || 'unknown');
      providerCounts[provider] = (providerCounts[provider] ?? 0) + 1;
      if (countedUsage) {
        knownInputTokens += countedUsage.input_tokens;
        knownOutputTokens += countedUsage.output_tokens;
      } else {
        unknownUsageCalls++;
        allInputKnown = false; allOutputKnown = false;
      }
      if (countedCost) {
        const key = JSON.stringify([countedCost.status, countedCost.currency, countedCost.pricing_version]);
        const current = costTotals.get(key) ?? { status: countedCost.status, currency: countedCost.currency,
          pricing_version: countedCost.pricing_version, amount: { units: 0n, scale: 0 }, calls: 0 };
        addDecimal(current.amount, countedCost.amount); current.calls++; costTotals.set(key, current);
      }
    }
    const latency = safeCount(details?.latency_ms) ?? (safeCount(row.sent_at) !== null && safeCount(row.received_at) !== null
      ? Math.max(0, safeCount(row.received_at)! - safeCount(row.sent_at)!) : null);
    const time = calledAt(row, details);
    return {
      entry_id: String(row.id), contact_id: row.scope_kind === 'owner_memory' ? null : row.contact_id === null ? null : String(row.contact_id),
      scope_kind: row.scope_kind === 'owner_memory' ? 'owner_memory' as const : 'contact' as const,
      provider: typeof details?.provider === 'string' && details.provider.trim() ? details.provider : String(row.provider || 'unknown'),
      model_name: typeof details?.model === 'string' && details.model.trim() ? details.model : String(row.model || '未知模型'),
      called_at: time, latency_ms: latency, dispatch: sent, outcome: state,
      input_tokens: countedUsage?.input_tokens ?? null, output_tokens: countedUsage?.output_tokens ?? null,
      cache_read_tokens: countedUsage?.cache_read_tokens ?? null, cache_write_tokens: countedUsage?.cache_write_tokens ?? null,
      cost_status: countedCost?.status ?? 'unknown', cost_amount: countedCost?.amount ?? null,
      currency: countedCost?.currency ?? null, pricing_version: countedCost?.pricing_version ?? null,
      source: details ? 'receipt' as const : 'legacy' as const, confirmed: confirmed,
    };
  });
  const recent = projected.sort((a, b) => Date.parse(b.called_at) - Date.parse(a.called_at));
  return {
    schema_version: 1,
    total_calls: totalCalls,
    total_attempts: rows.length,
    authorized_unconfirmed_calls: authorizedUnconfirmedCalls,
    not_sent_attempts: notSentAttempts,
    unknown_usage_calls: unknownUsageCalls,
    total_input_tokens: allInputKnown ? knownInputTokens : null,
    total_output_tokens: allOutputKnown ? knownOutputTokens : null,
    known_input_tokens: knownInputTokens,
    known_output_tokens: knownOutputTokens,
    unknown_cost_calls: totalCalls - [...costTotals.values()].reduce((sum, item) => sum + item.calls, 0),
    provider_counts: providerCounts,
    outcome_counts: outcomeCounts,
    cost_totals: [...costTotals.values()].map(item => ({ status: item.status, currency: item.currency,
      pricing_version: item.pricing_version, amount: decimal(item.amount), calls: item.calls })),
    recent: recent.slice(0, 10),
  };
}

function readUsageSummary(tx: StorageTransaction, ownerId: string) {
  return projectUsageSummary(tx.all(`SELECT c.id,c.provider,c.model,c.state,c.error_code,c.sent_at,c.received_at,c.settlement_state,c.receipt,
    CASE WHEN json_extract(c.receipt,'$.scope_kind')='owner_memory' OR p.scope_kind='self' OR d.scope_kind='self'
      THEN 'owner_memory' ELSE 'contact' END AS scope_kind,
    CASE WHEN json_extract(c.receipt,'$.scope_kind')='owner_memory' OR p.scope_kind='self' OR d.scope_kind='self'
      THEN NULL ELSE COALESCE(json_extract(c.receipt,'$.contact_id'),r.contact_id,p.contact_id,d.contact_id,
        (SELECT min(s.source_contact_id) FROM operation_scope s WHERE s.owner_id=c.owner_id AND s.operation_id=c.operation_id)) END AS contact_id
    FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
    LEFT JOIN processing_step ps ON ps.owner_id=o.owner_id AND ps.id=o.memory_step_id
    LEFT JOIN processing_task p ON p.owner_id=ps.owner_id AND p.id=ps.task_id
    LEFT JOIN reply_request r ON r.owner_id=o.owner_id AND r.id=o.reply_request_id
    LEFT JOIN document_effect_scope d ON d.owner_id=o.owner_id AND d.operation_id=o.id
    WHERE c.owner_id=? ORDER BY coalesce(c.received_at,c.sent_at,0) DESC,c.rowid DESC`, [ownerId]));
}

export const modelUsageSummaryActions: StorageAction[] = [{
  name: 'modelUsage.summary', mode: 'read', retryBusy: false,
  execute(tx, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as { ownerId?: unknown }).ownerId !== 'string') throw new Error('model_usage_owner_invalid');
    return readUsageSummary(tx, (input as { ownerId: string }).ownerId);
  },
}];
