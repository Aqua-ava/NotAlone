import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fixture, profilePayload, ids } from './support.mjs';
const compiled = await build({ stdin: { contents: `export { readLayeredEvidence } from './src/main/reply/layered-evidence-read';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const inference = { kind: 'inference', section: 'insights', basis: '几次合成讨论都选择先了解细节。', uncertainty: '样本有限，不能推为稳定人格。' };
function sample() {
  const payload = profilePayload();
  Object.assign(payload.layered_memory.profile.entries[0], inference);
  Object.assign(payload.layered_memory.scenarios[0].paragraphs[0], { ...inference, section: 'implicit_signals' });
  return payload;
}

test('公开资料读取保留L2/L3推断分类、依据及局限，旧资料仍可读', async () => {
  let payload = sample();
  const f = await fixture(async () => ({ generation: 1, data: payload }));
  await f.bridge.readLayeredMemory(f.selection());
  let state = await f.bridge.getState();
  assert.equal(state.layeredMemory.phase, 'ready');
  assert.equal(state.layeredMemory.value.profile.entries[0].kind, 'inference');
  assert.equal(state.layeredMemory.value.scenarios[0].paragraphs[0].basis, inference.basis);
  payload = profilePayload();
  await f.bridge.readLayeredMemory(f.selection());
  state = await f.bridge.getState();
  assert.equal(state.layeredMemory.phase, 'ready');
  assert.equal(state.layeredMemory.value.profile.entries[0].kind, undefined);
});

test('真实资料回复策略可解码且推断不能在展示投影中丢失或升级为stable', () => {
  const payload = sample().layered_memory;
  const value = { layered_status: 'loaded', layered_context: { schema_version: 3, scope_kind: 'contact',
    settings_generation: 1, organization_generation: 1, profile_version_id: ids.profile,
    profile_entries: payload.profile.entries, directory: [], read_policy: 'verified-items-scoped-layered-v1',
    scenario_read_budget: null, budget: { profile_entries: 4, directory_entries: 4, characters: 10000 } } };
  assert.equal(module.exports.readLayeredEvidence(value).layeredContext.profileEntries[0].basis, inference.basis);
  value.layered_context.profile_entries[0].temporal_status = 'stable';
  assert.throws(() => module.exports.readLayeredEvidence(value));
  value.layered_context.profile_entries[0].temporal_status = 'uncertain';
  delete value.layered_context.profile_entries[0].basis;
  assert.throws(() => module.exports.readLayeredEvidence(value));
});
