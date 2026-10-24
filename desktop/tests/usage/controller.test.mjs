import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['src/main/usage/controller.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { UsageController } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
export function summary() { return { schema_version: 1, total_calls: 1, total_attempts: 3, authorized_unconfirmed_calls: 1,
  not_sent_attempts: 1, unknown_usage_calls: 2, total_input_tokens: null, total_output_tokens: null,
  known_input_tokens: 12, known_output_tokens: 3, unknown_cost_calls: 3, provider_counts: { synthetic: 1 },
  outcome_counts: { cancelled: 2, failed: 1 }, cost_totals: [],
  recent: [{ entry_id: 'private-entry-canary', contact_id: 'private-contact-canary', scope_kind: 'owner_memory',
    provider: 'synthetic', model_name: 'synthetic-model', called_at: '2026-10-24T00:00:00Z', latency_ms: 4,
    dispatch: 'authorized_unconfirmed', outcome: 'cancelled', input_tokens: null, output_tokens: null,
    cache_read_tokens: null, cache_write_tokens: null, cost_status: 'unknown', cost_amount: null,
    currency: null, pricing_version: null, source: 'receipt', confirmed: false, body: 'private-body-canary' }] }; }
function fixture() {
  let generation = 1, fail = false, response = summary(), pending;
  const calls = [], listeners = [];
  const backend = { getConnectionGeneration: () => generation, onStateChanged: fn => listeners.push(fn),
    async requestJson(request) { calls.push(request); if (pending) await pending;
      if (fail) throw Error('private-secret-canary'); return { generation: 1, data: response }; } };
  return { controller: new UsageController(backend), calls,
    fail: value => { fail = value; }, response: value => { response = value; },
    hold: value => { pending = value; }, replace: () => { ++generation; for (const fn of listeners) fn(); } };
}
test('公开用量控制器只读并投影未知与授权边界，不含身份正文', async () => {
  const f = fixture(); await f.controller.refresh();
  const state = f.controller.getState(); assert.equal(state.phase, 'ready');
  assert.equal(state.summary.totalCalls, 1); assert.equal(state.summary.authorizedUnconfirmedCalls, 1);
  assert.equal(state.summary.totalInputTokens, null); assert.equal(state.summary.recent[0].outcome, 'cancelled');
  assert.equal(state.summary.recent[0].scopeKind, 'owner_memory');
  assert.doesNotMatch(JSON.stringify(state), /private-/);
  assert.deepEqual(f.calls.map(({ method, path, body }) => ({ method, path, body })), [{ method: 'GET', path: '/api/ledger/summary', body: undefined }]);
});
test('失败可见并仅GET安全刷新，异常原文不外泄', async () => {
  const f = fixture(); f.fail(true); await f.controller.refresh();
  assert.equal(f.controller.getState().errorCode, 'usage_read_failed');
  assert.equal(f.controller.getState().summary, null);
  assert.doesNotMatch(JSON.stringify(f.controller.getState()), /private-/);
  f.fail(false); await f.controller.refresh(); assert.equal(f.controller.getState().phase, 'ready');
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.method === 'GET'));
});
test('连接变化后清除旧账单并拒绝迟到结果', async () => {
  const f = fixture(); let release; f.hold(new Promise(resolve => { release = resolve; }));
  const reading = f.controller.refresh(); f.replace(); release(); await reading;
  assert.equal(f.controller.getState().phase, 'idle'); assert.equal(f.controller.getState().summary, null);
  assert.equal(f.calls[0].signal.aborted, true);
});
test('坏响应不能把未知费用转成0或把授权未确认当已确认', async () => {
  for (const change of [row => { row.recent[0].cost_amount = '0'; }, row => { row.recent[0].confirmed = true; }]) {
    const f = fixture(), data = summary(); change(data); f.response(data); await f.controller.refresh();
    assert.equal(f.controller.getState().phase, 'error'); assert.equal(f.controller.getState().summary, null);
  }
});
