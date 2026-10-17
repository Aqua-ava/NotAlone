import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { test } from 'node:test';

const compiled = await build({ stdin: { contents: "export { withLayeredMemoryFixture } from './tests/layered-memory-fixture';", resolveDir: process.cwd() },
  bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { withLayeredMemoryFixture } = module.exports;

test('页面与原生共用HTTP夹具的默认行为仍为单条覆盖及有限四次调用', async () => {
  let cleaned = false;
  await withLayeredMemoryFixture(async fixture => {
    const path = `/api/contacts/${fixture.data.contact_ids[0]}/layered-memory`;
    const enabled = await fixture.request(path + '/enable', { settings_generation: 0, purpose_confirmed: true });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.data.layered_memory.status, 'paused');
    assert.equal(enabled.data.layered_memory.covered_count, 1);
    assert.equal(enabled.data.layered_memory.model_calls_used, 4);
  }, () => { cleaned = true; });
  assert.equal(cleaned, true);
});

test('双范围独立主题夹具同批完成，反馈甲保留乙，补充后的四Port均取得实际纠错对照', async () => {
  let cleaned = false;
  await withLayeredMemoryFixture(async fixture => {
    for (const scope of ['contact', 'owner']) {
      const path = scope === 'owner' ? '/api/memories/owner/layered-memory'
        : `/api/contacts/${fixture.data.contact_ids[0]}/layered-memory`;
      const enabled = await fixture.request(path + '/enable', { settings_generation: 0, purpose_confirmed: true });
      assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
      const ready = enabled.data.layered_memory;
      assert.equal(ready.status, 'ready', JSON.stringify(ready));
      assert.equal(ready.scenarios.length, 2);
      assert.equal(ready.model_calls_used, 4);
      const [target, kept] = ready.scenarios;
      const reason = '该主题将合成事实概括错误。';
      const feedback = await fixture.request(path + '/summary-error', { settings_generation: ready.settings_generation,
        organization_generation: ready.organization_generation, target_kind: 'scenario', version_id: target.version_id,
        item_index: 0, reason, operation_id: randomUUID() });
      assert.equal(feedback.status, 200, JSON.stringify(feedback.data));
      assert.deepEqual(feedback.data.layered_memory.scenarios.map(item => item.version_id), [kept.version_id]);
      await fixture.command(scope === 'owner' ? 'add_owner_memory' : 'add_memory');
      const refreshed = await fixture.request(path + '/refresh', { settings_generation: ready.settings_generation });
      assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data));
      assert.ok(refreshed.data.layered_memory.profile, JSON.stringify(refreshed.data));
      const proof = await fixture.command('runtime_proof');
      const received = proof.correction_receipts.filter(receipt => receipt.corrections.some(item => item.reason === reason
        && item.rejected_text === target.paragraphs[0].text));
      assert.deepEqual(new Set(received.map(item => item.step)), new Set(['scenario_propose', 'scenario_verify', 'profile_propose', 'profile_verify']));
      assert.ok(received.every(item => item.corrections.every(value => value.rule === 'independent-literal-v1')));
      assert.equal(proof.external_model_calls, 0);
      assert.deepEqual(proof.fixture_options, { max_memories: 2, separate_topics: true });
    }
  }, () => { cleaned = true; }, { maxMemories: 2, separateTopics: true });
  assert.equal(cleaned, true);
});
