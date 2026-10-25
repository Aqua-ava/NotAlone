// 只验证同键停止修复的新等待边界；真实协议回调和单一作业登记均来自固定源码。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const root = process.env.NOTALONE_REVIEW_FIXED_ROOT;
const require = createRequire(join(root, 'desktop/package.json'));
const {build} = require('esbuild');
const bundle = await build({stdin: {contents:
  `export {AssistantGenerationJobs} from './src/main/reply/assistant-generation-jobs';`,
  resolveDir: join(root, 'desktop')}, bundle: true, platform: 'node', format: 'cjs', write: false});
const module = {exports: {}};
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports);
const {AssistantGenerationJobs} = module.exports;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const boundary = () => new Promise(resolve => setImmediate(resolve));

async function scenario(t, lifecycle, lateBeforeStop) {
  const identity = {connectionGeneration: 19, contactId: randomUUID(), sessionId: randomUUID(), requestKey: randomUUID()};
  const receipt = {sessionId: identity.sessionId, requestKey: identity.requestKey,
    turnId: randomUUID(), inputVersionId: randomUUID(), state: 'running'};
  const jobs = new AssistantGenerationJobs();
  let oldProtocol;
  const interruptions = [], recoveryCalls = [];
  const acknowledged = deferred(), interrupted = deferred();
  const stopping = label => ({
    recover: async () => { recoveryCalls.push(label); throw new Error('未知仍需权威身份'); },
    interrupt: async (actual, reason = 'app_quit') => {
      assert.deepEqual(actual, {...identity, ...receipt});
      interruptions.push({label, reason}); interrupted.resolve(); await acknowledged.promise;
      return {state: 'failed', interruptionReason: reason};
    },
  });
  await jobs.execute({identity, stopping: stopping('old'), adapter: {run: async protocol => {
    oldProtocol = protocol; protocol.preparing(); throw new Error('合成首次准备响应丢失');
  }}, consume: () => assert.fail('旧未知不能发布'), failed: () => {}});
  assert.equal(jobs.states(19)[0].phase, 'unconfirmed');
  const entered = deferred(), release = deferred();
  let modelCalls = 0;
  const executing = jobs.execute({identity, stopping: stopping('current'), adapter: {run: async protocol => {
    protocol.preparing(); entered.resolve(); await release.promise;
    await protocol.prepared(receipt);
    protocol.requested(); modelCalls++;
    return {value: null, outcome: 'completed'};
  }}, consume: () => assert.fail('停止中的准备不得发布'), failed: () => {}});
  await entered.promise;
  assert.equal(jobs.recoveryPending(undefined), 2, '当前登记不能删除旧未知');
  assert.equal(jobs.states(19).length, 1);
  assert.equal(jobs.states(19)[0].phase, 'preparing');
  for (const invalid of [{...identity, connectionGeneration: 20}, {...identity, contactId: randomUUID()},
    {...identity, sessionId: randomUUID()}, {...identity, requestKey: randomUUID()}]) {
    await assert.rejects(jobs.cancelUserGeneration(invalid, null), /已经结束或不再属于/);
  }
  await assert.rejects(jobs.cancelUserGeneration(identity, randomUUID()), /已经结束或不再属于/);
  assert.throws(() => oldProtocol.observe({kind: 'receipt', receipt: {...receipt, requestKey: randomUUID()}}), /回执归属无效/);
  if (lateBeforeStop) oldProtocol.observe({kind: 'receipt', receipt});
  let stopped = false;
  const cancellation = jobs.cancelUserGeneration(identity, null).then(result => { stopped = true; return result; });
  const duplicate = jobs.cancelUserGeneration(identity, null);
  assert.equal(jobs.states(19)[0].phase, 'stopping');
  const settling = lifecycle === 'quit'
    ? jobs.beginClosing(() => assert.fail('已有原停止连接不得使用替代退出回调'))
    : jobs.prepareConnectionChange();
  if (!lateBeforeStop) {
    await boundary();
    assert.equal(jobs.recoveryPending(undefined), 2);
    oldProtocol.observe({kind: 'receipt', receipt});
  }
  await boundary();
  assert.equal(interruptions.length, 0, '旧回执不得抢先退出或重载中断');
  assert.equal(stopped, false);
  assert.equal(modelCalls, 0);
  release.resolve(); await interrupted.promise;
  assert.deepEqual(interruptions, [{label: 'current', reason: 'user_cancelled'}]);
  assert.equal(stopped, false, '真实中断确认前不得完成用户停止');
  assert.equal(modelCalls, 0);
  acknowledged.resolve();
  assert.equal(await cancellation, true);
  assert.equal(await duplicate, true);
  await executing; await settling;
  assert.deepEqual(interruptions, [{label: 'current', reason: 'user_cancelled'}]);
  assert.equal(recoveryCalls.length, 0);
  assert.equal(modelCalls, 0);
  assert.deepEqual(jobs.pendingReceipts(), []);
  assert.equal(jobs.recoveryPending(undefined), 0);
  assert.equal(jobs.states(19)[0].phase, 'cancelled');
  assert.throws(() => oldProtocol.observe({kind: 'receipt', receipt}), /回执归属无效/);
  t.diagnostic(JSON.stringify({lifecycle, lateBeforeStop, modelCalls,
    interruptCount: interruptions.length, currentUserCancellation: true,
    oldUnknownRetainedUntilReceipt: true, finalPending: 0}));
}

test('旧真实回执先到，再停止当前同键准备并退出，等待不成环', {timeout: 3000},
  t => scenario(t, 'quit', true));
test('用户停止及重载先开始，旧真实回执后到，仍只结算当前用户停止', {timeout: 3000},
  t => scenario(t, 'reload', false));
