import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { build } from 'esbuild';

const output = await build({ stdin: { contents: `
  export { AssistantGenerationJobs } from './src/main/reply/assistant-generation-jobs';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = { exports: {} };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
const { AssistantGenerationJobs } = loaded.exports;
const owner = { connectionGeneration: 7, contactId: '38c6e784-93dc-476b-8a2c-2733523a23b9',
  sessionId: 'ad630563-b558-40ec-bdaa-c34201756c42' };
const identity = { ...owner, requestKey: '69b51458-cf1d-47d2-a96c-fd465f15c353' };
const receipt = { sessionId: owner.sessionId, requestKey: identity.requestKey,
  turnId: '7a750bd7-d1b9-4b96-969c-99e5464d896a', inputVersionId: 'a4afba16-2fa1-45d0-ac42-de8d06045bda', state: 'running' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function preparation({ unknown = false, notReserved = false } = {}) {
  const changed = [], jobs = new AssistantGenerationJobs(() => changed.push(jobs.states(7)));
  const entered = deferred(), release = deferred(), acknowledgement = deferred(), interrupted = deferred();
  const interruptions = [], failures = [];
  let modelCalls = 0;
  const execution = jobs.execute({ identity, stopping: {
    async interrupt(actual, reason) {
      interruptions.push({ actual, reason }); interrupted.resolve();
      await acknowledgement.promise;
      return { state: 'failed', interruptionReason: 'user_cancelled' };
    },
    recover: async () => { throw new Error('合成未知准备不能证明已领取或未领取'); },
  }, adapter: { async run(protocol) {
    protocol.preparing(); entered.resolve(); await release.promise;
    if (unknown) throw new Error('合成准备响应丢失');
    if (notReserved) {
      protocol.notReserved({ contactId: owner.contactId, sessionId: owner.sessionId,
        requestKey: identity.requestKey, state: 'not_reserved' }, 7);
      return { value: null, outcome: 'no_generation' };
    }
    await protocol.prepared(receipt);
    protocol.requested(); modelCalls += 1;
    return { value: null, outcome: 'completed' };
  } }, consume: () => {}, failed: error => { failures.push(error.message); } });
  return { jobs, entered: entered.promise, release: () => release.resolve(),
    acknowledge: () => acknowledgement.resolve(), interrupted: interrupted.promise,
    execution, changed, interruptions, failures, modelCalls: () => modelCalls };
}

test('准备状态带原请求键及空回执，停止须等真实回执和中断确认，重复停止仅中断一次', async () => {
  const f = preparation(); await f.entered;
  const { connectionGeneration, ...visibleIdentity } = identity;
  assert.deepEqual(f.jobs.states(7), [{ ...visibleIdentity,
    turnId: null, inputVersionId: null, canRetry: false, phase: 'preparing' }]);
  let settled = false;
  const stopping = f.jobs.cancelUserGeneration(identity, null).then(value => { settled = true; return value; });
  const duplicate = f.jobs.cancelUserGeneration(identity, null);
  assert.equal(f.jobs.states(7)[0].phase, 'stopping');
  assert.equal(f.jobs.pendingReceipts().length, 0);
  assert.equal(settled, false); assert.equal(f.interruptions.length, 0);
  f.release(); await f.interrupted;
  assert.equal(settled, false); assert.equal(f.modelCalls(), 0);
  assert.deepEqual(f.interruptions, [{ actual: { ...identity, ...receipt }, reason: 'user_cancelled' }]);
  f.acknowledge();
  assert.equal(await stopping, true); assert.equal(await duplicate, true); await f.execution;
  assert.equal(f.modelCalls(), 0); assert.equal(f.interruptions.length, 1);
  assert.equal(f.jobs.states(7)[0].phase, 'cancelled');
  assert.equal(f.jobs.states(7)[0].inputVersionId, receipt.inputVersionId);
  await f.jobs.beginClosing(() => assert.fail('已停止作业不应再次退出中断'));
});

test('准备停止拒绝错误连接、联系人、会话、请求和伪造输入版本', async () => {
  const f = preparation(); await f.entered;
  for (const wrong of [{ ...identity, connectionGeneration: 8 }, { ...identity, contactId: receipt.turnId },
    { ...identity, sessionId: receipt.turnId }, { ...identity, requestKey: receipt.turnId }]) {
    await assert.rejects(f.jobs.cancelUserGeneration(wrong, null), /已经结束或不再属于/);
  }
  await assert.rejects(f.jobs.cancelUserGeneration(identity, receipt.inputVersionId), /已经结束或不再属于/);
  assert.equal(f.jobs.states(7)[0].phase, 'preparing');
  const stopping = f.jobs.cancelUserGeneration(identity, null);
  f.release(); f.acknowledge(); await stopping; await f.execution;
  assert.equal(f.interruptions.length, 1); assert.equal(f.modelCalls(), 0);
});

test('准备响应未知时不能伪装取消成功，原身份仍阻止退出假排空', async () => {
  const f = preparation({ unknown: true }); await f.entered;
  const rejected = assert.rejects(f.jobs.cancelUserGeneration(identity, null), /停止身份尚未确认/);
  f.release(); await f.execution; await rejected;
  assert.equal(f.jobs.states(7)[0].phase, 'unconfirmed');
  assert.equal(f.modelCalls(), 0); assert.equal(f.interruptions.length, 0);
  await assert.rejects(f.jobs.beginClosing(() => assert.fail('未知准备不能伪造回执')), /身份尚未确认/);
  await assert.rejects(f.jobs.beginClosing(() => assert.fail('未知准备重试仍不能伪造回执')), /合成未知准备/);
});

test('正式未领取证明可结算准备停止，不虚构输入版本或中断请求', async () => {
  const f = preparation({ notReserved: true }); await f.entered;
  const stopping = f.jobs.cancelUserGeneration(identity, null);
  f.release(); assert.equal(await stopping, true); await f.execution;
  assert.equal(f.jobs.states(7)[0].phase, 'cancelled');
  assert.equal(f.jobs.states(7)[0].inputVersionId, null);
  assert.equal(f.interruptions.length, 0); assert.equal(f.modelCalls(), 0);
  await f.jobs.beginClosing(() => assert.fail('未领取不应发送中断'));
});

test('准备停止与退出交错时只结算原user_cancelled，不死锁或重复中断', async () => {
  const f = preparation(); await f.entered;
  const stopping = f.jobs.cancelUserGeneration(identity, null);
  const closing = f.jobs.beginClosing(() => assert.fail('用户停止正在结算时不得重复app_quit'));
  f.release(); await f.interrupted;
  assert.equal(f.modelCalls(), 0);
  f.acknowledge(); await stopping; await f.execution; await closing;
  assert.equal(f.interruptions.length, 1);
  assert.deepEqual(f.jobs.pendingReceipts(), []);
});
