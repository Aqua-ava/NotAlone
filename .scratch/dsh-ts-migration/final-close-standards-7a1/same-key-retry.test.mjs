// 原请求键可显式重试；停止必须选中当前准备作业，不能命中已结束传输的旧未知登记。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const root = process.env.NOTALONE_REVIEW_FIXED_ROOT;
const require = createRequire(join(root, 'desktop/package.json'));
const {build} = require('esbuild');
const result = await build({stdin: {contents: `export {AssistantGenerationJobs} from './src/main/reply/assistant-generation-jobs';`,
  resolveDir: join(root, 'desktop')}, bundle: true, platform: 'node', format: 'cjs', write: false});
const module = {exports: {}};
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
const {AssistantGenerationJobs} = module.exports;
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

test('同键准备重试的可见停止不能被旧未知登记抢占', async t => {
  const identity = {connectionGeneration: 11, contactId: randomUUID(), sessionId: randomUUID(), requestKey: randomUUID()};
  const receipt = {sessionId: identity.sessionId, requestKey: identity.requestKey,
    turnId: randomUUID(), inputVersionId: randomUUID(), state: 'running'};
  const jobs = new AssistantGenerationJobs();
  const interruptions = [];
  const stopping = label => ({recover: async () => { throw new Error('合成未知不作猜测'); },
    interrupt: async (actual, reason) => {
      interruptions.push({label, actual, reason});
      return {state: 'failed', interruptionReason: 'user_cancelled'};
    }});
  await jobs.execute({identity, stopping: stopping('old'), adapter: {run: async protocol => {
    protocol.preparing(); throw new Error('合成首次准备响应丢失');
  }}, consume: () => {}, failed: () => {}});
  assert.equal(jobs.states(11)[0].phase, 'unconfirmed');
  const entered = defer(), release = defer();
  let modelCalls = 0, stopError = null;
  const execution = jobs.execute({identity, stopping: stopping('retry'), adapter: {run: async protocol => {
    protocol.preparing(); entered.resolve(); await release.promise;
    await protocol.prepared(receipt);
    protocol.requested(); modelCalls++;
    return {value: null, outcome: 'completed'};
  }}, consume: () => {}, failed: () => {}});
  await entered.promise;
  assert.equal(jobs.states(11).length, 1);
  assert.equal(jobs.states(11)[0].phase, 'preparing');
  assert.equal(jobs.states(11)[0].inputVersionId, null);
  const stopped = jobs.cancelUserGeneration(identity, null).catch(error => { stopError = error.message; return false; });
  await Promise.resolve(); await Promise.resolve();
  release.resolve(); await execution;
  const confirmed = await stopped;
  t.diagnostic(JSON.stringify({stopError, confirmed, modelCalls,
    interruptCount: interruptions.length, finalPhase: jobs.states(11)[0]?.phase}));
  assert.equal(stopError, null, '当前准备作业的停止不能落到旧的结束传输登记');
  assert.equal(confirmed, true);
  assert.equal(modelCalls, 0);
  assert.equal(interruptions.length, 1);
  assert.equal(interruptions[0].label, 'retry');
  assert.equal(jobs.states(11)[0].phase, 'cancelled');
});
