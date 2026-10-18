import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const compiled = await build({ stdin: { contents: `export { withLayeredMemoryFixture } from './tests/layered-memory-fixture';
  export * from './tests/layered-correction-native-flow';`, resolveDir: process.cwd() },
  bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { withLayeredMemoryFixture, prepareNativeCorrection, simulateNativeCorrection, checkNativeCorrection, waitNativeCorrectionReady } = module.exports;

test('原生八步后验先以真实公开 JSON 核对，HTTP 预检不签发 CUA 收据', { timeout: 90000 }, async () => {
  let cleaned = false;
  await withLayeredMemoryFixture(async fixture => {
    let previous;
    for (const scope of ['contact', 'owner']) for (let index = 0; index < 4; index++) {
      const step = await prepareNativeCorrection(fixture, scope, index, previous);
      await simulateNativeCorrection(fixture, step);
      const observed = await checkNativeCorrection(fixture, step);
      if (step.action === 'fact') await writeFile(path.join(process.env.NOTALONE_LAYERED_TEST_EVIDENCE_DIR,
        `immediate-${step.name}.json`), JSON.stringify({ native_app: false, external_model_calls: 0,
        old_memory_id: step.memory.memory_id, old_memory_text: step.memory.text,
        old_profile_version: step.before.profile?.version_id, ...observed }), { mode: 0o600, flag: 'wx' });
      previous = step;
    }
    const proof = await fixture.command('runtime_proof');
    assert.equal(proof.external_model_calls, 0);
  }, () => { cleaned = true; }, { maxMemories: 2, separateTopics: true });
  assert.equal(cleaned, true);
});

test('事实修正后合法重建仍排除旧版本，HTTP 预检不签发 CUA 收据', { timeout: 90000 }, async () => {
  let cleaned = false;
  await withLayeredMemoryFixture(async fixture => {
    let previous;
    for (const scope of ['contact', 'owner']) for (let index = 0; index < 4; index++) {
      const step = await prepareNativeCorrection(fixture, scope, index, previous);
      await simulateNativeCorrection(fixture, step);
      if (step.action === 'fact') {
        const current = await fixture.request(step.layeredPath);
        assert.equal(current.status, 200);
        const refreshed = await fixture.request(step.layeredPath + '/refresh', {
          settings_generation: current.data.layered_memory.settings_generation,
        });
        assert.equal(refreshed.status, 200);
        const ready = await waitNativeCorrectionReady(fixture, step.layeredPath);
        assert.ok(ready.profile, '必须实际重建新背景，不能以空结果规避后验。');
      }
      const observed = await checkNativeCorrection(fixture, step);
      if (step.action === 'fact') await writeFile(path.join(process.env.NOTALONE_LAYERED_TEST_EVIDENCE_DIR,
        `rebuilt-${step.name}.json`), JSON.stringify({ native_app: false, external_model_calls: 0,
        old_memory_id: step.memory.memory_id, old_memory_text: step.memory.text,
        old_profile_version: step.before.profile?.version_id, ...observed }), { mode: 0o600, flag: 'wx' });
      previous = step;
    }
    const proof = await fixture.command('runtime_proof');
    assert.equal(proof.external_model_calls, 0);
  }, () => { cleaned = true; }, { maxMemories: 2, separateTopics: true });
  assert.equal(cleaned, true);
});
