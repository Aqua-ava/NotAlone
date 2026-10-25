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
const owner = { connectionGeneration: 11, contactId: id(1), sessionId: id(2) };
const identity = { ...owner, requestKey: id(3) };
const receipt = { sessionId: owner.sessionId, requestKey: identity.requestKey,
  turnId: id(4), inputVersionId: id(5), state: 'running' };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function launch({ jobs = new AssistantGenerationJobs(), key = identity, actual = receipt,
  responseUnknown = false, awaitModel = false, interruptResult } = {}) {
  const entered = deferred(), prepare = deferred(), model = deferred(), interruptEntered = deferred();
  const ack = deferred(), interruptions = [], failures = [];
  let protocol, calls = 0, published = 0, job;
  const execution = jobs.execute({ identity: key,
    registered(value) { job = value; },
    stopping: {
      async interrupt(got, reason = 'app_quit') {
        interruptions.push({ got, reason }); interruptEntered.resolve();
        return interruptResult ? interruptResult(interruptions.length, reason) : ack.promise;
      },
      recover: async () => actual,
    },
    adapter: { async run(value) {
      protocol = value; protocol.preparing(); entered.resolve(); await prepare.promise;
      if (responseUnknown) throw new Error('synthetic_preparation_unknown');
      await protocol.prepared(actual); protocol.requested(); calls++;
      if (awaitModel) await model.promise;
      return { value: null, outcome: 'completed' };
    } },
    consume() { if (jobs.canPublish(job, key)) published++; },
    failed(error) { failures.push(error.message); },
  });
  return { jobs, entered: entered.promise, release: prepare.resolve, complete: model.resolve,
    execution, interrupted: interruptEntered.promise, interruptions, failures,
    confirm: () => ack.resolve({ state: 'failed', interruptionReason: 'user_cancelled' }),
    reject: () => ack.reject(new Error('synthetic_interrupt_unknown')),
    calls: () => calls, published: () => published, job: () => job, protocol: () => protocol };
}

test('独立：准备通知主动公开原请求且轮次和输入版本仍为null', { timeout: 3000 }, async () => {
  const notifications = [];
  const jobs = new AssistantGenerationJobs(() => notifications.push(jobs.states(11)));
  const f = launch({ jobs }); await f.entered;
  try {
    assert.ok(notifications.some(states => states.some(state => state.phase === 'preparing')));
    assert.deepEqual(jobs.states(11), [{ contactId: owner.contactId, sessionId: owner.sessionId,
      requestKey: identity.requestKey, turnId: null, inputVersionId: null, canRetry: false, phase: 'preparing' }]);
    assert.deepEqual(jobs.pendingReceipts(), []);
    assert.deepEqual(jobs.states(12), []);
  } finally { f.release(); await f.execution; }
});

test('独立：准备停止遇到连接切换仍只中断旧真实回执一次', { timeout: 3000 }, async () => {
  const f = launch(); await f.entered;
  const stop = f.jobs.cancelUserGeneration(identity, null);
  const change = f.jobs.prepareConnectionChange();
  f.release(); await f.interrupted;
  assert.equal(f.calls(), 0); assert.equal(f.published(), 0);
  f.confirm(); assert.equal(await stop, true); await f.execution; await change;
  assert.deepEqual(f.interruptions, [{ got: { ...identity, ...receipt }, reason: 'user_cancelled' }]);
  assert.equal(f.jobs.states(11)[0].phase, 'cancelled');
  assert.deepEqual(f.jobs.pendingReceipts(), []);
});

test('独立：中断确认失败不派模型、不记取消，随后退出按原身份结算', { timeout: 3000 }, async () => {
  const f = launch({ interruptResult: async count => {
    if (count === 1) throw new Error('synthetic_interrupt_unknown');
    return { state: 'failed', interruptionReason: 'app_quit' };
  } }); await f.entered;
  const stop = assert.rejects(f.jobs.cancelUserGeneration(identity, null), /synthetic_interrupt_unknown/);
  f.release(); await stop; await f.execution;
  assert.equal(f.calls(), 0); assert.equal(f.jobs.states(11)[0].phase, 'unconfirmed');
  assert.equal(f.jobs.pendingReceipts()[0].requestKey, identity.requestKey);
  await f.jobs.beginClosing(() => assert.fail('应使用原停止连接'));
  assert.deepEqual(f.interruptions.map(x => x.reason), ['user_cancelled', 'app_quit']);
  assert.deepEqual(f.jobs.pendingReceipts(), []);
});

test('独立：准备停止后删除原会话，迟到回执不能派发或发布', { timeout: 3000 }, async () => {
  const f = launch(); await f.entered;
  const stop = assert.rejects(f.jobs.cancelUserGeneration(identity, null), /停止身份尚未确认/);
  f.jobs.forget(owner); f.release(); await stop; await f.execution;
  assert.equal(f.calls(), 0); assert.equal(f.published(), 0);
  assert.equal(f.interruptions.length, 0); assert.deepEqual(f.jobs.states(11), []);
});

test('独立：供应商迟到完成不覆盖已确认取消', { timeout: 3000 }, async () => {
  const f = launch({ awaitModel: true }); await f.entered; f.release(); await tick();
  assert.equal(f.calls(), 1);
  const stop = f.jobs.cancelUserGeneration(identity, receipt.inputVersionId);
  await f.interrupted; assert.equal(f.jobs.canPublish(f.job(), owner), false);
  f.confirm(); assert.equal(await stop, true); f.complete(); await f.execution;
  assert.equal(f.published(), 0); assert.equal(f.jobs.states(11)[0].phase, 'cancelled');
});

test('独立：空版本的旧界面停止可匹配同原请求已到达的真实回执', { timeout: 3000 }, async () => {
  const f = launch({ awaitModel: true }); await f.entered; f.release(); await tick();
  const stop = f.jobs.cancelUserGeneration(identity, null); await f.interrupted;
  f.confirm(); assert.equal(await stop, true); f.complete(); await f.execution;
  assert.equal(f.interruptions[0].got.inputVersionId, receipt.inputVersionId);
  assert.equal(f.jobs.states(12).length, 0);
  assert.equal(f.jobs.states(11)[0].phase, 'cancelled');
});

test('独立：权威已完成中断回执返回false，不冒充用户取消', { timeout: 3000 }, async () => {
  const f = launch({ interruptResult: async () => ({ state: 'completed', interruptionReason: null }) });
  await f.entered; const stop = f.jobs.cancelUserGeneration(identity, null); f.release();
  assert.equal(await stop, false); await f.execution;
  assert.equal(f.jobs.states(11)[0].phase, 'completed');
  assert.equal(f.published(), 1); assert.equal(f.interruptions.length, 1);
});

test('独立：准备传输未知保留原请求，不返回取消成功', { timeout: 3000 }, async () => {
  const f = launch({ responseUnknown: true }); await f.entered;
  const stop = assert.rejects(f.jobs.cancelUserGeneration(identity, null), /停止身份尚未确认/);
  f.release(); await stop; await f.execution;
  assert.equal(f.jobs.states(11)[0].phase, 'unconfirmed');
  assert.equal(f.calls(), 0); assert.equal(f.interruptions.length, 0);
  assert.equal(f.jobs.recoveryPending(12), 1);
});
