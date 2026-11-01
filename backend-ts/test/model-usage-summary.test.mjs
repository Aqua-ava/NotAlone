import assert from 'node:assert/strict';
import test from 'node:test';
import { projectUsageSummary } from '../src/platform/models/usage-summary.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { SqliteMemoryExtraction } from '../src/memory/sqlite/service.ts';
import { fixture, owner, modelPort } from './fixtures/memory-sqlite/support.mjs';

const contact = '11111111-1111-4111-8111-111111111111';
function row(id, state, settlement, receipt, overrides = {}) {
  return { id, provider: 'synthetic', model: '', state, settlement_state: settlement, error_code: null,
    sent_at: 1000, received_at: state === 'succeeded' ? 1100 : null, scope_kind: 'contact', contact_id: contact,
    receipt: JSON.stringify(receipt), ...overrides };
}

test('模型用量仅汇总已确认调用且不返回回执正文', () => {
  const rows = [
    row('call-success', 'succeeded', 'settled', { provider: 'synthetic', model: 'model-a', called_at: '2026-11-01T00:00:00Z',
      dispatch: 'response_observed', outcome: 'succeeded', usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: null, cache_write_tokens: null },
      cost: { status: 'known', amount: '0.1', currency: 'CNY', pricing_version: 'price-v1' }, body: 'private-body-canary' }),
    row('call-unknown', 'unknown', 'unknown', { provider: 'synthetic', model: 'model-a',
      dispatch: 'authorized_unconfirmed', outcome: 'unknown', usage: null,
      cost: { status: 'unknown', amount: null, currency: null, pricing_version: null }, scope_kind: 'owner_memory' },
    { scope_kind: 'owner_memory', contact_id: null, sent_at: 2000, received_at: null }),
    row('call-not-sent', 'failed', 'settled', { dispatch: 'not_sent', outcome: 'run_failed', usage: null,
      cost: { status: 'unknown', amount: null, currency: null, pricing_version: null } },
    { error_code: 'not_dispatched', sent_at: null, received_at: null }),
    row('call-dsh', 'succeeded', 'settled', { format: 'dsh-physical-step-v1', usage: { inputTokens: 8, outputTokens: 3,
      cacheReadTokens: 2, cacheWriteTokens: 1 }, inputBudget: { request_sha256: 'a'.repeat(64) } },
    { id: 'call-dsh', provider: 'deepseek', model: 'deepseek-chat', sent_at: 3000, received_at: 3100, scope_kind: 'owner_memory', contact_id: null }),
    row('call-failed-response', 'failed', 'settled', { dispatch: 'response_observed', outcome: 'failed', usage: null,
      cost: { status: 'unknown', amount: null, currency: null, pricing_version: null } },
    { id: 'call-failed-response', sent_at: 4000, received_at: 4200 }),
  ];
  const summary = projectUsageSummary(rows);
  assert.equal(summary.total_calls, 3);
  assert.equal(summary.total_attempts, 5);
  assert.equal(summary.authorized_unconfirmed_calls, 1);
  assert.equal(summary.not_sent_attempts, 1);
  assert.equal(summary.unknown_usage_calls, 1);
  assert.equal(summary.total_input_tokens, null);
  assert.equal(summary.total_output_tokens, null);
  assert.equal(summary.known_input_tokens, 18);
  assert.equal(summary.known_output_tokens, 8);
  assert.equal(summary.unknown_cost_calls, 2);
  assert.deepEqual(summary.provider_counts, { synthetic: 2, deepseek: 1 });
  assert.deepEqual(summary.outcome_counts, { succeeded: 2, unknown: 1, run_failed: 1, failed: 1 });
  assert.deepEqual(summary.cost_totals, [{ status: 'known', currency: 'CNY', pricing_version: 'price-v1', amount: '0.1', calls: 1 }]);
  assert.equal(summary.recent.length, 5);
  const dsh = summary.recent.find(entry => entry.entry_id === 'call-dsh');
  assert.equal(dsh.scope_kind, 'owner_memory');
  assert.equal(dsh.contact_id, null);
  assert.equal(dsh.dispatch, 'response_observed');
  assert.equal(dsh.model_name, 'deepseek-chat');
  assert.doesNotMatch(JSON.stringify(summary), /private-body-canary|request_sha256|permit_id/);
});

test('未识别回执保持发送未确认，空账本用量为零', () => {
  const empty = projectUsageSummary([]);
  assert.equal(empty.total_calls, 0);
  assert.equal(empty.total_attempts, 0);
  assert.equal(empty.total_input_tokens, 0);
  assert.deepEqual(empty.recent, []);
  const summary = projectUsageSummary([row('legacy', 'failed', 'unknown', { unexpected: true })]);
  assert.equal(summary.total_calls, 0);
  assert.equal(summary.authorized_unconfirmed_calls, 1);
  assert.equal(summary.unknown_usage_calls, 0);
  assert.equal(summary.recent[0].dispatch, 'authorized_unconfirmed');
  assert.equal(summary.recent[0].source, 'receipt');
});

test('真实SQLite汇总正常提取回执，并隔离同库其他本人及其联系人', async t => {
  const f = await fixture(t), otherOwner = '00000000-0000-4000-8000-000000000002';
  const metadata = {
    account: async () => ({ externalKey: 'synthetic-other-account', identityScheme: 'wechat.account.v1',
      sourceGeneration: 'source-1', assurance: 'verified', supportProfile: 'synthetic-metadata-v1' }),
    sessions: async () => ['c', 'd'].map(externalKey => ({ externalKey, displayName: `合成${externalKey}`,
      kind: 'private', identityAssurance: 'verified' })),
  };
  const otherContacts = new SqliteContactService(f.storage, otherOwner, metadata);
  const otherHistory = new SqliteHistoryService(f.storage, otherContacts, f.channel);
  let currentMemory, otherMemory;
  try {
    await f.service.synchronize(f.saved[0].contact_id);
    await f.contacts.setReading(false);
    await otherContacts.initialize();
    await otherContacts.confirmAccount((await otherContacts.detectAccount()).candidate_token);
    const snapshot = await otherContacts.candidates(true);
    const otherBindings = await otherContacts.confirm(snapshot.snapshot_token, snapshot.sessions.map(session => ({
      locator: session.username, observed_display_name: session.display_name,
      expected_selection_generation: session.selection_generation,
    })));
    await otherContacts.setReading(true);
    for (const binding of otherBindings.bindings) await otherHistory.synchronize(binding.contact_id);
    await otherContacts.setReading(false);

    currentMemory = new SqliteMemoryExtraction(f.storage, owner, modelPort(() => currentMemory.accounting));
    otherMemory = new SqliteMemoryExtraction(f.storage, otherOwner, modelPort(() => otherMemory.accounting));
    await currentMemory.start('usage-current-owner');
    await currentMemory.waitForIdle();
    await otherMemory.start('usage-other-owner');
    await otherMemory.waitForIdle();

    const current = await f.storage.execute('modelUsage.summary', { ownerId: owner });
    const other = await f.storage.execute('modelUsage.summary', { ownerId: otherOwner });
    assert.equal(current.total_calls, 1);
    assert.equal(current.total_attempts, 1);
    assert.equal(current.total_input_tokens, 10);
    assert.equal(current.total_output_tokens, 1);
    assert.deepEqual(current.provider_counts, { synthetic: 1 });
    assert.deepEqual(current.recent.map(entry => entry.contact_id), [f.saved[0].contact_id]);
    assert.equal(current.recent[0].scope_kind, 'contact');
    assert.equal(current.recent[0].dispatch, 'response_observed');
    assert.equal(current.recent[0].outcome, 'succeeded');
    assert.equal(other.total_calls, 2);
    assert.equal(other.total_attempts, 2);
    assert.equal(other.total_input_tokens, 20);
    assert.equal(other.total_output_tokens, 2);
    assert.deepEqual(new Set(other.recent.map(entry => entry.contact_id)),
      new Set(otherBindings.bindings.map(binding => binding.contact_id)));
    assert.ok(other.recent.every(entry => entry.entry_id !== current.recent[0].entry_id));
    assert.doesNotMatch(JSON.stringify([current, other]), /request_sha256|permit_id|input_budget|合成正文/);
    const missingOwner = await f.storage.execute('modelUsage.summary', {
      ownerId: '00000000-0000-4000-8000-000000000003',
    });
    assert.equal(missingOwner.total_calls, 0);
    assert.deepEqual(missingOwner.recent, []);
    assert.deepEqual(await f.storage.check(), { integrity: 'ok', foreignKeys: 'ok' });
  } finally {
    await currentMemory?.close();
    await otherMemory?.close();
    await otherHistory.close();
    await otherContacts.close();
    await f.service.close();
    await f.contacts.close();
  }
});
