import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

async function ports() {
  const result = await build({ stdin: { contents: `
    export { readInputBudget, readInputBudgetFailure } from './src/main/reply/input-budget-read';
    export { readReplyResult } from './src/main/reply/result-read';
  `, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const ready = { state: 'ready', allowed: true, model_id: 'synthetic-json-model-v1', context_window_tokens: 1000,
  input_tokens: 500, output_reserve_tokens: 100, total_tokens: 600, measurement_kind: 'exact',
  measurement_id: 'synthetic-json-codepoint-framing-v1', reason: null };
const exceeded = { ...ready, state: 'exceeded', allowed: false, input_tokens: 901, total_tokens: 1001,
  reason: 'context_window_exceeded' };
const unavailable = { ...ready, state: 'unavailable', allowed: false, context_window_tokens: null,
  input_tokens: null, output_reserve_tokens: null, total_tokens: null, measurement_kind: null,
  measurement_id: null, reason: 'model_capability_unknown' };

test('完整估算预算回执保留安全余量，旧精确回执继续按零余量读取', async () => {
  const { readInputBudget } = await ports();
  const receipt = { ...ready, measurement_kind: 'approximate',
    measurement_id: 'synthetic-request-estimate-v1', safety_margin_tokens: 200, total_tokens: 800 };
  const budget = readInputBudget(receipt, true);
  assert.equal(budget.measurementKind, 'approximate');
  assert.equal(budget.safetyMarginTokens, 200);
  assert.equal(budget.totalTokens, 800);
  assert.equal(readInputBudget(ready, true).safetyMarginTokens, 0);
});

test('估算余量与总数必须一致，陌生计量类型和额外正文仍被拒绝', async () => {
  const { readInputBudget } = await ports();
  const receipt = { ...ready, measurement_kind: 'approximate',
    measurement_id: 'synthetic-request-estimate-v1', safety_margin_tokens: 200, total_tokens: 800 };
  for (const bad of [{ ...receipt, safety_margin_tokens: 0, total_tokens: 600 },
    { ...receipt, safety_margin_tokens: -1 }, { ...receipt, safety_margin_tokens: 1.5 },
    { ...receipt, safety_margin_tokens: true }, { ...receipt, safety_margin_tokens: '200' },
    { ...receipt, safety_margin_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { ...receipt, safety_margin_tokens: 900, total_tokens: 1500 },
    { ...receipt, total_tokens: 600 }, { ...receipt, measurement_kind: 'character_ratio' },
    { ...receipt, text: '不能进入预算元数据的合成正文。' }]) assert.throws(() => readInputBudget(bad));
  assert.equal(readInputBudget({ ...ready, safety_margin_tokens: 200, total_tokens: 800 }).safetyMarginTokens, 200);
  assert.equal(readInputBudget({ ...unavailable, measurement_kind: 'approximate',
    measurement_id: 'synthetic-request-estimate-v1', safety_margin_tokens: 200 }).safetyMarginTokens, 200);
});

test('预算元数据严格解码已核实数值与未知配置，不接收正文或矛盾状态', async () => {
  const { readInputBudget } = await ports();
  assert.equal(readInputBudget(ready, true).totalTokens, 600);
  assert.equal(readInputBudget(unavailable).inputTokens, null);
  for (const bad of [null, { ...ready, text: '不应出现的合成正文。' }, { ...ready, allowed: false },
    { ...ready, total_tokens: 601 }, { ...ready, input_tokens: -1 }, { ...ready, context_window_tokens: 500 },
    { ...ready, input_tokens: Number.MAX_SAFE_INTEGER + 1 }, { ...ready, model_id: '合成\n正文' },
    { ...ready, model_id: '不应出现的合成正文。' }, { ...ready, measurement_id: '合成私人正文' },
    { ...ready, measurement_kind: 'approximate' }, { ...unavailable, input_tokens: 500 },
    { ...unavailable, reason: '任意正文' }, { ...exceeded, total_tokens: 600 }]) assert.throws(() => readInputBudget(bad));
  assert.throws(() => readInputBudget(exceeded, true));
  assert.throws(() => readInputBudget(unavailable, true));
});

test('只有匹配的409预算分类可携元数据，错误正文和其他分类均不透传', async () => {
  const { readInputBudgetFailure } = await ports();
  const payload = { error: 'input_budget_exceeded', input_budget: exceeded, text: '不透传的合成响应正文。' };
  assert.equal(readInputBudgetFailure(payload, 409).state, 'exceeded');
  assert.equal(readInputBudgetFailure({ error: 'input_budget_unavailable', input_budget: unavailable }, 409).inputTokens, null);
  for (const value of [{ ...payload, input_budget: ready }, { ...payload, input_budget: unavailable },
    { ...payload, error: 'assistant_session_rejected' }, { ...payload, input_budget: { ...exceeded, text: '正文' } }]) {
    assert.equal(readInputBudgetFailure(value, 409), undefined);
  }
  assert.equal(readInputBudgetFailure(payload, 502), undefined);
});

test('历史旧结果没有预算回执时不补造状态，伪造成功回执被拒绝', async () => {
  const { readReplyResult } = await ports();
  const reply = { reply_request_id: randomUUID(), candidates: [{ candidate_id: randomUUID(), text: '合成原候选。',
    basis: '合成草稿依据。', citation_ids: [], risk_notes: [] }], context_receipt: { evidence_ids: [] } };
  assert.equal(readReplyResult(reply).inputBudget, undefined);
  assert.equal(readReplyResult({ ...reply, input_budget: { ...ready, state: 'warning' } }).inputBudget.state, 'warning');
  assert.throws(() => readReplyResult({ ...reply, input_budget: exceeded }));
});
