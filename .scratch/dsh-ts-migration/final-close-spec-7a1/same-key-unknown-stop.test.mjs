// 只复验准备响应丢失后，同原请求重试期间的停止选择。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(process.env.NOTALONE_REVIEW_ROOT + '/desktop/package.json');
const { build } = require('esbuild');
const built = await build({ entryPoints: [process.env.NOTALONE_REVIEW_ROOT + '/desktop/src/main/reply/assistant-generation-jobs.ts'],
  bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports);
const { AssistantGenerationJobs } = loaded.exports;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = { connectionGeneration: 1, contactId: id(1), sessionId: id(2), requestKey: id(3) };
const receipt = { sessionId: identity.sessionId, requestKey: identity.requestKey,
  turnId: id(4), inputVersionId: id(5), state: 'running' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('同key未知准备重试时，停止应登记到当前可见准备并在真实回执后中断', { timeout: 3000 }, async t => {
  const jobs = new AssistantGenerationJobs();
  const interruptions = [];
  const stopping = {
    async interrupt(actual, reason) {
      interruptions.push({ actual, reason });
      return { state: 'failed', interruptionReason: 'user_cancelled' };
    }, recover: async () => receipt,
  };
  await jobs.execute({ identity, stopping, adapter: { async run(protocol) {
    protocol.preparing(); throw new Error('synthetic_first_prepare_response_lost');
  } }, consume() {}, failed() {} });
  assert.equal(jobs.states(1)[0].phase, 'unconfirmed');
  const entered = deferred(), release = deferred();
  let modelDispatches = 0;
  const execution = jobs.execute({ identity, stopping, adapter: { async run(protocol) {
    protocol.preparing(); entered.resolve(); await release.promise;
    await protocol.prepared(receipt); protocol.requested(); modelDispatches++;
    return { value: null, outcome: 'completed' };
  } }, consume() {}, failed() {} });
  await entered.promise;
  assert.equal(jobs.states(1)[0].phase, 'preparing');
  const stopped = jobs.cancelUserGeneration(identity, null).then(value => ({ value }), error => ({ error: error.message }));
  await new Promise(done => setImmediate(done));
  release.resolve(); await execution;
  const outcome = await stopped;
  t.diagnostic(JSON.stringify({ stop: outcome, model_dispatches_after_stop: modelDispatches,
    interrupt_count: interruptions.length, final_phase: jobs.states(1)[0]?.phase }));
  assert.deepEqual(outcome, { value: true });
  assert.equal(modelDispatches, 0); assert.equal(interruptions.length, 1);
});
