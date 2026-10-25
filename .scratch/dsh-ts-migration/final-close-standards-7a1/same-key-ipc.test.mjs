import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const { build } = createRequire(path.join(process.cwd(), 'package.json'))('esbuild');

const output = await build({ stdin: { contents: `
  export { BackendRequestFailure } from './src/main/backend/json-client';
  export { ContactSession } from './src/main/contacts/session';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { createReplyBridge } from './src/preload/reply';
  export { AssistantSessionPanel } from './src/renderer/AssistantSessionPanel';
  export { createElement } from 'react';
  export { renderToStaticMarkup } from 'react-dom/server';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  loader: { '.css': 'empty' },
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const ports = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

async function eventually(read, accept, label) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(label);
}

let prepareAttempts = 0;
let retryPreparingResolve, retryReleaseResolve;
const retryPreparing = new Promise(resolve => { retryPreparingResolve = resolve; });
const retryRelease = new Promise(resolve => { retryReleaseResolve = resolve; });
const renderState = (state) => ports.renderToStaticMarkup(ports.createElement(ports.AssistantSessionPanel, {
  replies: { state, stopGeneration: () => Promise.resolve() },
}));

async function fixture() {
  const contactA = randomUUID(), contactB = randomUUID(), binding = randomUUID();
  const sessions = new Map([[contactA, { sessionId: randomUUID(), turns: [], currentInputVersionId: null }],
    [contactB, { sessionId: randomUUID(), turns: [], currentInputVersionId: null }]]);
  const sessionsById = new Map([...sessions.values()].map((session) => [session.sessionId, session]));
  const requests = [];
  let generation = 7;
  const backendListeners = new Set();
  const backend = {
    getConnectionGeneration: () => generation,
    onStateChanged: (listener) => { backendListeners.add(listener); return () => backendListeners.delete(listener); },
    subscribeMessages: (observer) => observer.connected(),
    captureAssistantStoppingConnection: () => {
      const captured = generation;
      return { getConnectionGeneration: () => captured, requestJson: (request) => requestJson(request, captured) };
    },
    requestJson: (request) => requestJson(request, generation),
  };
  async function requestJson(request, responseGeneration) {
      requests.push({ method: request.method, path: request.path, body: request.body });
      const contactId = /^\/api\/contacts\/([0-9a-f-]+)\//.exec(request.path)?.[1];
      const pathSessionId = /\/assistant-sessions\/([0-9a-f-]+)(?:\/|$)/.exec(request.path)?.[1];
      const session = pathSessionId ? sessionsById.get(pathSessionId) : sessions.get(contactId);
      if (request.path.endsWith('/assistant-session/default')) {
        return { generation: responseGeneration, data: { session_id: session.sessionId } };
      }
      if (request.method === 'POST' && request.path.endsWith('/assistant-sessions')) {
        const created = { sessionId: randomUUID(), turns: [], currentInputVersionId: null };
        sessions.set(contactId, created); sessionsById.set(created.sessionId, created);
        return { generation: responseGeneration, data: { session_id: created.sessionId } };
      }
      if (request.path.endsWith('/replies/prepare')) {
        prepareAttempts++;
        if (prepareAttempts === 1) throw new ports.BackendRequestFailure('connection');
        if (prepareAttempts === 2) { retryPreparingResolve(); await retryRelease; }
        const turn = {
          turnId: randomUUID(), requestKey: request.body.idempotency_key,
          inputVersionId: randomUUID(), state: 'running', interruptionReason: null,
          input: { content: request.body.content },
        };
        session.turns.push(turn); session.currentInputVersionId = turn.inputVersionId;
        return { generation: responseGeneration, data: { session_id: session.sessionId, turn_id: turn.turnId,
          request_key: turn.requestKey, input_version_id: turn.inputVersionId, state: 'running' } };
      }
      if (request.path.endsWith('/replies')) {
        const turn = session.turns.find((item) => item.requestKey === request.body.idempotency_key);
        return new Promise((resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new ports.BackendRequestFailure('cancelled')),
            { once: true });
        });
      }
      if (request.path.endsWith('/interrupt')) {
        const turn = session.turns.find((item) => item.requestKey === request.body.request_key);
        assert(turn, '停止必须携带原作业请求键。');
        turn.state = 'failed'; turn.interruptionReason = request.body.reason ?? 'app_quit';
        return { generation: responseGeneration, data: { session_id: session.sessionId, turn_id: turn.turnId,
          request_key: turn.requestKey, input_version_id: turn.inputVersionId, state: 'failed',
          interruption_reason: turn.interruptionReason } };
      }
      if (request.method === 'GET' && request.path.includes('/assistant-sessions/')) {
        return { generation: responseGeneration, data: {
          session_id: session.sessionId,
          current_input_version_id: session.currentInputVersionId,
          turns: session.turns.map((turn) => ({
            turn_id: turn.turnId, input_version_id: turn.inputVersionId, request_key: turn.requestKey,
            state: turn.state, interruption_reason: turn.interruptionReason,
            input: turn.input, reply: null, placeholder: null,
          })),
          inputs: session.turns.map((turn) => ({
            input_version_id: turn.inputVersionId, type: 'generation',
            conversation_binding_id: binding, turn_id: turn.turnId,
            state: 'active', content: null, placeholder: null,
          })),
        } };
      }
      throw new Error(`未模拟的请求：${request.method} ${request.path}`);
  }
  const contacts = new ports.ContactSession(async () => ({ generation, contacts: [
    { contactId: contactA, displayName: '合成联系人甲', messageCount: 0, sourceCount: 0 },
    { contactId: contactB, displayName: '合成联系人乙', messageCount: 0, sourceCount: 0 },
  ] }));
  contacts.setConnection(7); await contacts.refreshContacts();
  const handlers = new Map(), listeners = new Map();
  const replies = ports.installReplyBridge({
    handle: (channel, handler) => handlers.set(channel, handler),
    publish: (channel, state) => { for (const listener of listeners.get(channel) ?? []) listener(undefined, state); },
  }, backend, contacts);
  const bridge = ports.createReplyBridge({
    invoke: async (channel, ...args) => handlers.get(channel)(...args),
    on: (channel, listener) => { const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set); },
    removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
  });
  const select = async (contactId) => {
    contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
    const scope = { contactId, scopeRevision: contacts.getState().scopeRevision };
    contacts.setDraft({ ...scope, text: `合成草稿 ${contactId}` });
    await bridge.readSavedSession(scope);
    return scope;
  };
  const start = async (scope, phases = ['generating']) => {
    const generating = bridge.generate({ ...scope, newRequest: true });
    const ready = eventually(() => bridge.getState(), (state) => state.generationJobs?.some((job) =>
      job.contactId === scope.contactId && phases.includes(job.phase)), '生成未进入可停止状态。').then(() => 'ready');
    const failed = generating.catch((error) => ({ error }));
    const outcome = await Promise.race([ready, failed]);
    if (outcome !== 'ready') throw outcome.error;
    const job = (await bridge.getState()).generationJobs.find((item) => item.contactId === scope.contactId
      && phases.includes(item.phase));
    return { generating, job };
  };
  return { bridge, replies, select, start, requests,
    interruptCount: () => requests.filter((item) => item.method === 'POST' && item.path.endsWith('/interrupt')).length,
    interruptReasons: () => requests.filter((item) => item.method === 'POST' && item.path.endsWith('/interrupt'))
      .map((item) => item.body.reason ?? 'app_quit'),
    sessions, changeConnection: async () => {
      generation += 1;
      for (const listener of backendListeners) listener();
      contacts.setConnection(generation);
      await eventually(() => contacts.getState(), (state) => state.directoryPhase === 'ready',
        '换代后的联系人目录未就绪。');
    },
  };
}


test('生产控制器与IPC：同键准备重试的停止不能被旧未知登记抢占', async t => {
  const f = await fixture();
  const scope = await f.select(f.sessions.keys().next().value);
  await f.bridge.generate({...scope, newRequest: true});
  const failed = await f.bridge.getState();
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.canRetry, true);
  assert.equal(failed.generationJobs[0].phase, 'unconfirmed');
  const firstKey = f.requests.find(item => item.path.endsWith('/replies/prepare')).body.idempotency_key;
  const retrying = f.bridge.generate({...scope, newRequest: false});
  await retryPreparing;
  const visible = await f.bridge.getState();
  const job = visible.generationJobs.find(item => item.phase === 'preparing');
  assert(job);
  assert.equal(job.requestKey, firstKey);
  assert.equal(job.inputVersionId, null);
  assert.match(renderState(visible), /aria-label="停止本次生成"/);
  let stopError = null;
  const requestedStop = f.bridge.stopGeneration({...scope, sessionId: job.sessionId,
    requestKey: job.requestKey, inputVersionId: null}).catch(error => { stopError = error.message; });
  // 允许原准备返回，并观察停止屏障是否确实拦住生成 POST。
  retryReleaseResolve();
  await requestedStop;
  await eventually(() => f.bridge.getState(), state => state.generationJobs.some(item =>
    ['generating', 'cancelled'].includes(item.phase)), '重试未达到生成或取消终态');
  const modelPosts = f.requests.filter(item => item.path.endsWith('/replies')).length;
  const interrupts = f.interruptCount();
  // 本轮模拟传输若仍在运行，仅以真实回执执行一次收尾，避免保留自有悬挂请求。
  if (modelPosts) {
    const actual = (await f.bridge.getState()).generationJobs.find(item => item.phase === 'generating');
    await f.bridge.stopGeneration({...scope, sessionId: actual.sessionId,
      requestKey: actual.requestKey, inputVersionId: actual.inputVersionId});
  }
  await retrying;
  t.diagnostic(JSON.stringify({sameRequestKey: true, visiblePhase: job.phase,
    nullInputVersion: job.inputVersionId === null, stopError, modelPostsBeforeCleanup: modelPosts,
    interruptsBeforeCleanup: interrupts, realModelCalls: 0}));
  assert.equal(stopError, null, '当前可见准备作业的停止不得选中旧未知登记');
  assert.equal(modelPosts, 0);
  assert.equal(interrupts, 1);
});
