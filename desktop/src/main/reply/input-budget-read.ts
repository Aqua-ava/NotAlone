import type { AssistantInputBudget } from '../../shared/assistant-input-budget';

const fields = ['state', 'allowed', 'model_id', 'context_window_tokens', 'input_tokens', 'output_reserve_tokens',
  'total_tokens', 'measurement_kind', 'measurement_id', 'reason'];
const unavailableReasons = new Set(['invalid_request', 'model_mismatch', 'model_capability_unknown',
  'output_reserve_mismatch', 'counter_unavailable', 'measurement_failed', 'invalid_measurement',
  'incomplete_measurement', 'unmeasurable_model_request']);
const identifier = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

export function readInputBudget(value: unknown, successOnly = false): AssistantInputBudget {
  const invalid = () => new Error('模型预算元数据格式无效。');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const keys = Object.keys(value), hasMargin = keys.includes('safety_margin_tokens');
  if (keys.length !== fields.length + (hasMargin ? 1 : 0)
    || !keys.every((key) => fields.includes(key) || key === 'safety_margin_tokens')) throw invalid();
  const receipt = value as Record<string, unknown>, state = receipt.state;
  const margin = hasMargin ? receipt.safety_margin_tokens : 0;
  if (!['ready', 'warning', 'exceeded', 'unavailable'].includes(state as string)
    || !identifier(receipt.model_id) || typeof receipt.allowed !== 'boolean'
    || receipt.allowed !== (state === 'ready' || state === 'warning')
    || successOnly && !receipt.allowed
    || !(receipt.context_window_tokens === null || positive(receipt.context_window_tokens))
    || !(receipt.output_reserve_tokens === null || positive(receipt.output_reserve_tokens))
    || !(receipt.measurement_kind === null || ['exact', 'verified_upper_bound', 'approximate'].includes(receipt.measurement_kind as string))
    || !Number.isSafeInteger(margin) || (margin as number) < 0
    || !(receipt.measurement_id === null || identifier(receipt.measurement_id))) throw invalid();
  const capacity = receipt.context_window_tokens as number | null, reserve = receipt.output_reserve_tokens as number | null;
  if (capacity !== null && reserve !== null && reserve + (margin as number) >= capacity) throw invalid();
  if (state === 'unavailable') {
    if (receipt.input_tokens !== null || receipt.total_tokens !== null
      || !unavailableReasons.has(receipt.reason as string)) throw invalid();
  } else if (capacity === null || reserve === null || receipt.measurement_kind === null || receipt.measurement_id === null
    || receipt.measurement_kind === 'approximate' && (margin as number) === 0
    || !Number.isSafeInteger(receipt.input_tokens) || (receipt.input_tokens as number) < 0
    || !Number.isSafeInteger(receipt.total_tokens) || receipt.total_tokens !== (receipt.input_tokens as number) + reserve + (margin as number)
    || (state === 'exceeded' ? (receipt.total_tokens as number) <= capacity || receipt.reason !== 'context_window_exceeded'
      : (receipt.total_tokens as number) > capacity || receipt.reason !== null)) throw invalid();
  return { state: state as AssistantInputBudget['state'], allowed: receipt.allowed,
    modelId: receipt.model_id, contextWindowTokens: capacity, inputTokens: receipt.input_tokens as number | null,
    outputReserveTokens: reserve, safetyMarginTokens: margin as number, totalTokens: receipt.total_tokens as number | null,
    measurementKind: receipt.measurement_kind as AssistantInputBudget['measurementKind'],
    measurementId: receipt.measurement_id as string | null, reason: receipt.reason as string | null };
}

export function readInputBudgetFailure(value: unknown, status: number): AssistantInputBudget | undefined {
  if (status !== 409 || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const response = value as Record<string, unknown>;
  const expected = response.error === 'input_budget_exceeded' ? 'exceeded'
    : response.error === 'input_budget_unavailable' ? 'unavailable' : undefined;
  if (!expected) return undefined;
  try { const decision = readInputBudget(response.input_budget);
    return decision.state === expected ? decision : undefined; }
  catch { return undefined; }
}
