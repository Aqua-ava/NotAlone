import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  legacyLedgerProjection,
  modelLedgerInputBudget,
  validateModelLedgerReceipt,
} from '../src/platform/models/model-ledger-contract.ts';
import { MESSAGES_MEASUREMENT_ID } from '../src/platform/models/model-input-budget.ts';

const receipt = overrides => ({
  attempt_id: randomUUID(), permit_id: randomUUID(), request_id: randomUUID(), owner_id: randomUUID(),
  contact_id: randomUUID(), provider: 'synthetic-provider', model: 'synthetic-model',
  called_at: '2026-10-30T00:00:00.000Z', latency_ms: null,
  dispatch: 'authorized_unconfirmed', outcome: 'pending', usage: null,
  cost: { status: 'unknown', amount: null, currency: null, pricing_version: null },
  ...overrides,
});

test('未经确认的调用不投影成旧物理台账；可确认的旧UUID和拒绝结果保持原样', () => {
  const pending = receipt();
  assert.equal(validateModelLedgerReceipt(pending), undefined);
  assert.equal(legacyLedgerProjection(pending), null);
  assert.throws(() => validateModelLedgerReceipt({
    ...pending,
    cost: { ...pending.cost, amount: '0' },
  }), /model_ledger_receipt_invalid/);

  const legacyId = randomUUID();
  const confirmed = receipt({
    ledger_entry_id: legacyId,
    legacy_outcome: 'rejected_by_validation',
    dispatch: 'response_observed',
    outcome: 'failed',
  });
  const projected = legacyLedgerProjection(confirmed);
  assert.deepEqual(projected, {
    id: legacyId,
    owner_id: confirmed.owner_id,
    contact_id: confirmed.contact_id,
    provider: 'synthetic-provider',
    model_name: 'synthetic-model',
    input_tokens: null,
    output_tokens: null,
    latency_ms: null,
    outcome: 'rejected_by_validation',
    called_at: '2026-10-30T00:00:00.000Z',
  });
});

test('预算只投影请求身份与数值，不保留正文或凭据', () => {
  const raw = {
    measurement_id: MESSAGES_MEASUREMENT_ID,
    measurement_kind: 'approximate',
    input_tokens: 123,
    maxTokens: 100,
    context_window_tokens: 1000,
    safety_margin_tokens: 20,
    serialized_bytes: 123,
    request_sha256: 'a'.repeat(64),
    messages: '不允许持久的合成正文',
    credential: '不允许持久的合成凭据',
  };
  const budget = modelLedgerInputBudget(raw);
  assert.deepEqual(Object.keys(budget).sort(), [
    'measurement_id', 'measurement_kind', 'input_tokens', 'max_output_tokens',
    'context_window_tokens', 'safety_margin_tokens', 'request_sha256', 'serialized_bytes',
  ].sort());
  assert.equal(JSON.stringify(budget).includes('不允许持久'), false);
  assert.equal(validateModelLedgerReceipt(receipt({ input_budget: budget })), undefined);
  assert.throws(() => validateModelLedgerReceipt(receipt({
    input_budget: { ...budget, messages: '合成正文' },
  })), /model_ledger_budget_invalid/);
  assert.throws(() => validateModelLedgerReceipt(receipt({
    input_budget: { ...budget, request_sha256: null },
  })), /model_ledger_budget_invalid/);
});
