// 原独立 RED 字节保持不变，另加退出、重载、身份边界三项合成探针。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
await import(pathToFileURL(process.env.NOTALONE_REVIEW_ORIGINAL_PROBE));
const require = createRequire(process.env.NOTALONE_REVIEW_ROOT + '/desktop/package.json');
const { build } = require('esbuild');
const output = await build({ entryPoints: [process.env.NOTALONE_REVIEW_ROOT + '/desktop/src/main/reply/assistant-generation-jobs.ts'],
  bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = { exports: {} };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, loaded, loaded.exports);
const { AssistantGenerationJobs } = loaded.exports;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = { connectionGeneration: 6, contactId: id(11), sessionId: id(12), requestKey: id(13) };
const receipt = { sessionId: identity.sessionId, requestKey: identity.requestKey,
  turnId: id(14), inputVersionId: id(15), state: 'running' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

async function retryFixture() {
  const jobs = new AssistantGenerationJobs();
  const entered = deferred(), currentReceipt = deferred(), acknowledge = deferred(), interrupted = deferred();
  const interruptions = [], recoveries = [];
  let originalProtocol, modelDispatches = 0;
  const stopping = label => ({
    async interrupt(actual, reason = 'app_quit') {
      assert.deepEqual(actual, { ...identity, ...receipt });
      interruptions.push({ label, reason }); interrupted.resolve();
      await acknowledge.promise;
      return { state: 'failed', interruptionReason: 'user_cancelled' };
    },
    async recover(actual) {
      recoveries.push({ label, actual });
      throw new Error('合成未知必须等待真实回执，不能伪装未领取');
    },
  });
  await jobs.execute({ identity, stopping: stopping('old'), adapter: { async run(protocol) {
    originalProtocol = protocol; protocol.preparing(); throw new Error('synthetic_lost_preparation_response');
  } }, consume() { assert.fail('未知不能消费'); }, failed() {} });
  assert.equal(jobs.states(6)[0].phase, 'unconfirmed');
  const execution = jobs.execute({ identity, stopping: stopping('current'), adapter: { async run(protocol) {
    protocol.preparing(); entered.resolve(); await currentReceipt.promise;
    await protocol.prepared(receipt); protocol.requested(); modelDispatches++;
    return { value: null, outcome: 'completed' };
  } }, consume() {}, failed() {} });
  await entered.promise;
  assert.deepEqual(jobs.states(6), [{ contactId: identity.contactId, sessionId: identity.sessionId,
    requestKey: identity.requestKey, turnId: null, inputVersionId: null, canRetry: false, phase: 'preparing' }]);
  return { jobs, originalProtocol, execution, interrupted: interrupted.promise, interruptions, recoveries,
    releaseReceipt: currentReceipt.resolve, acknowledge: acknowledge.resolve, modelDispatches: () => modelDispatches };
}

for (const lifecycle of ['quit', 'reload']) {
  test(`独立：同键旧晚回执与${lifecycle}等待当前停止，无循环或重复中断`, { timeout: 2500 }, async t => {
    const f = await retryFixture();
    if (lifecycle === 'quit') f.originalProtocol.observe({ kind: 'receipt', receipt });
    let stopSettled = false, lifecycleSettled = false;
    const stop = f.jobs.cancelUserGeneration(identity, null).then(value => { stopSettled = true; return value; });
    const duplicate = f.jobs.cancelUserGeneration(identity, null);
    assert.equal(f.jobs.states(6)[0].phase, 'stopping');
    const lifecycleWork = (lifecycle === 'quit'
      ? f.jobs.beginClosing(() => assert.fail('不得另行退出中断'))
      : f.jobs.prepareConnectionChange()).then(() => { lifecycleSettled = true; });
    if (lifecycle === 'reload') f.originalProtocol.observe({ kind: 'receipt', receipt });
    await turn();
    assert.equal(stopSettled, false); assert.equal(lifecycleSettled, false);
    assert.equal(f.interruptions.length, 0); assert.equal(f.recoveries.length, 0);
    assert.equal(f.modelDispatches(), 0);
    f.releaseReceipt(); await f.interrupted;
    assert.equal(stopSettled, false); assert.equal(lifecycleSettled, false);
    assert.deepEqual(f.interruptions, [{ label: 'current', reason: 'user_cancelled' }]);
    assert.equal(f.modelDispatches(), 0);
    f.acknowledge(); assert.equal(await stop, true); assert.equal(await duplicate, true);
    await f.execution; await lifecycleWork;
    assert.equal(f.jobs.states(6)[0].phase, 'cancelled');
    assert.deepEqual(f.jobs.pendingReceipts(), []);
    assert.equal(f.recoveries.length, 0);
    assert.throws(() => f.originalProtocol.observe({ kind: 'receipt', receipt }), /回执归属无效/);
    t.diagnostic(JSON.stringify({ lifecycle, model_dispatches: f.modelDispatches(), interruptions: f.interruptions,
      unknown_preserved_until_real_receipt: true, settled_without_cycle: true }));
  });
}

test('独立：反向选择仍严格核对连接、联系人、会话、请求和非空版本', { timeout: 2500 }, async t => {
  const f = await retryFixture();
  for (const wrong of [{ ...identity, connectionGeneration: 7 }, { ...identity, contactId: id(21) },
    { ...identity, sessionId: id(22) }, { ...identity, requestKey: id(23) }]) {
    await assert.rejects(f.jobs.cancelUserGeneration(wrong, null), /已经结束或不再属于/);
  }
  await assert.rejects(f.jobs.cancelUserGeneration(identity, id(25)), /已经结束或不再属于/);
  assert.equal(f.jobs.states(6)[0].phase, 'preparing');
  assert.deepEqual(f.jobs.states(7), []); assert.equal(f.interruptions.length, 0);
  const stop = f.jobs.cancelUserGeneration(identity, null);
  // 原 unknown 仍在，收到同范围真实回执可核验；错 scope 不能进入。
  assert.throws(() => f.originalProtocol.observe({ kind: 'receipt', receipt: { ...receipt, sessionId: id(22) } }), /回执归属无效/);
  assert.doesNotThrow(() => f.originalProtocol.observe({ kind: 'receipt', receipt }));
  assert.equal(f.jobs.states(6)[0].phase, 'stopping');
  assert.equal(f.jobs.states(6)[0].inputVersionId, null);
  f.releaseReceipt(); await f.interrupted; f.acknowledge();
  assert.equal(await stop, true); await f.execution;
  assert.equal(f.modelDispatches(), 0); assert.equal(f.interruptions.length, 1);
  assert.deepEqual(f.jobs.pendingReceipts(), []);
  t.diagnostic(JSON.stringify({ rejected_wrong_stop_identities: 5, rejected_wrong_late_receipt: true,
    model_dispatches: f.modelDispatches(), interrupt_count: f.interruptions.length }));
});
