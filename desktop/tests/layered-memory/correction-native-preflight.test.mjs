import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const compiled = await build({ stdin: { contents: `export { withLayeredMemoryFixture } from './tests/layered-memory-fixture';
  export * from './tests/layered-correction-native-flow';`, resolveDir: process.cwd() },
  bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { withLayeredMemoryFixture, prepareNativeCorrection, simulateNativeCorrection, checkNativeCorrection } = module.exports;

test('原生八步后验先以真实公开 JSON 核对，HTTP 预检不签发 CUA 收据', { timeout: 90000 }, async () => {
  let cleaned = false;
  await withLayeredMemoryFixture(async fixture => {
    let previous;
    for (const scope of ['contact', 'owner']) for (let index = 0; index < 4; index++) {
      const step = await prepareNativeCorrection(fixture, scope, index, previous);
      await simulateNativeCorrection(fixture, step);
      await checkNativeCorrection(fixture, step);
      previous = step;
    }
    const proof = await fixture.command('runtime_proof');
    assert.equal(proof.external_model_calls, 0);
  }, () => { cleaned = true; }, { maxMemories: 2, separateTopics: true });
  assert.equal(cleaned, true);
});
