// 独立验证新停止入口和生命周期边界；不使用作者测试夹具或模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const root = process.env.NOTALONE_REVIEW_FIXED_ROOT;
const require = createRequire(join(root, 'desktop/package.json'));
const {build} = require('esbuild');
const result = await build({stdin: {contents: `
  export {AssistantGenerationJobs} from './src/main/reply/assistant-generation-jobs';
  export {installReplyBridge} from './src/main/reply/bridge';
  export {ContactSession} from './src/main/contacts/session';
`, resolveDir: join(root, 'desktop')}, bundle: true, platform: 'node', format: 'cjs', write: false});
const module = {exports: {}};
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
const {AssistantGenerationJobs, installReplyBridge, ContactSession} = module.exports;
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

function pending({interruptFailure = false, malformedReceipt = false} = {}) {
  const identity = {connectionGeneration: 11, contactId: randomUUID(), sessionId: randomUUID(), requestKey: randomUUID()};
  const receipt = {sessionId: identity.sessionId, requestKey: identity.requestKey,
    turnId: randomUUID(), inputVersionId: randomUUID(), state: 'running'};
  const entered = defer(), release = defer(), interruptEntered = defer(), acknowledge = defer();
  const jobs = new AssistantGenerationJobs();
  const interruptions = [], errors = [];
  let modelCalls = 0;
  const execution = jobs.execute({identity, stopping: {
    recover: async () => { throw new Error('合成未知范围不得猜测'); },
    interrupt: async (actual, reason) => {
      interruptions.push({actual, reason}); interruptEntered.resolve(); await acknowledge.promise;
      if (interruptFailure) throw new Error('合成中断响应未知');
      return {state: 'failed', interruptionReason: reason};
    },
  }, adapter: {run: async protocol => {
    protocol.preparing(); entered.resolve(); await release.promise;
    await protocol.prepared(malformedReceipt ? {...receipt, requestKey: randomUUID()} : receipt);
    protocol.requested(); modelCalls++;
    return {value: null, outcome: 'completed'};
  }}, consume: () => {}, failed: error => { errors.push(error.message); }});
  return {identity, receipt, jobs, entered: entered.promise, release: release.resolve,
    interruptEntered: interruptEntered.promise, acknowledge: acknowledge.resolve,
    execution, interruptions, errors, modelCalls: () => modelCalls};
}

test('准备停止与设置重载共用原中断，确认之前不派发模型', async () => {
  const f = pending(); await f.entered;
  const stop = f.jobs.cancelUserGeneration(f.identity, null);
  const reload = f.jobs.prepareConnectionChange();
  f.release(); await f.interruptEntered;
  assert.equal(f.modelCalls(), 0);
  assert.equal(f.interruptions.length, 1);
  assert.equal(f.interruptions[0].reason, 'user_cancelled');
  assert.deepEqual(f.interruptions[0].actual, {...f.identity, ...f.receipt});
  f.acknowledge(); await stop; await f.execution; await reload;
  assert.equal(f.interruptions.length, 1);
  assert.equal(f.jobs.states(11)[0].phase, 'cancelled');
  assert.deepEqual(f.jobs.pendingReceipts(), []);
});

test('中断响应未知不能成功取消，也不能越过准备屏障派发模型', async () => {
  const f = pending({interruptFailure: true}); await f.entered;
  const stopping = assert.rejects(f.jobs.cancelUserGeneration(f.identity, null), /合成中断响应未知/);
  f.release(); await f.interruptEntered; f.acknowledge();
  await stopping; await f.execution;
  assert.equal(f.modelCalls(), 0);
  assert.equal(f.jobs.states(11)[0].phase, 'unconfirmed');
  assert.equal(f.jobs.pendingReceipts().length, 1);
});

test('迟到的错请求回执不会成为停止身份，原请求保持未知', async () => {
  const f = pending({malformedReceipt: true}); await f.entered;
  const stopping = assert.rejects(f.jobs.cancelUserGeneration(f.identity, null), /停止身份尚未确认/);
  f.release(); await f.execution; await stopping;
  assert.equal(f.modelCalls(), 0);
  assert.equal(f.interruptions.length, 0);
  assert.equal(f.jobs.states(11)[0].phase, 'unconfirmed');
  assert.deepEqual(f.jobs.pendingReceipts(), []);
});

test('IPC 只放行显式 null 或 UUID，字段闭合并保留 helper 角色', async () => {
  const handlers = new Map();
  const backend = {getConnectionGeneration: () => 11, onStateChanged: () => () => {},
    subscribeMessages: observer => { observer.connected(); return () => {}; }};
  const contacts = new ContactSession(async () => ({generation: 11, contacts: []}));
  contacts.setConnection(11);
  const replies = installReplyBridge({handle: (name, callback, role) => handlers.set(name, {callback, role}),
    publish: () => {}}, backend, contacts);
  const received = [];
  replies.stopGeneration = value => { received.push(value); return Promise.resolve(); };
  const handler = handlers.get('reply:stop-generation');
  assert.equal(handler.role, 'helper');
  const command = {contactId: randomUUID(), scopeRevision: 3, sessionId: randomUUID(), requestKey: randomUUID(), inputVersionId: null};
  await handler.callback(command);
  assert.deepEqual(received, [command]);
  for (const value of [undefined, '', false, {}, 0, 'invalid']) {
    assert.throws(() => handler.callback({...command, inputVersionId: value}));
  }
  const {inputVersionId, ...missing} = command;
  assert.throws(() => handler.callback(missing));
  assert.throws(() => handler.callback({...command, another: null}));
  assert.throws(() => handler.callback({...command, requestKey: null}));
  assert.equal(received.length, 1);
});
