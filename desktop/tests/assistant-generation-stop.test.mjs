import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

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

test('用户停止按原作业只发送一次 user_cancelled 中断并收敛为可读终态', async () => {
  const f = await fixture();
  const scope = await f.select((await f.bridge.getState()).contactId ?? f.sessions.keys().next().value);
  const { generating, job } = await f.start(scope);
  const command = { ...scope, sessionId: job.sessionId, requestKey: job.requestKey, inputVersionId: job.inputVersionId };
  const first = f.bridge.stopGeneration(command), second = f.bridge.stopGeneration(command);
  await Promise.all([first, second]);
  await generating.catch(() => {});
  await f.bridge.stopGeneration(command);
  assert.equal(f.interruptCount(), 1, '重复停止必须共用同一个中断请求。');
  assert.deepEqual(f.interruptReasons(), ['user_cancelled']);
  const state = await f.bridge.getState();
  assert.equal(state.generationJobs.find((item) => item.requestKey === job.requestKey).phase, 'cancelled');
  assert.equal(state.savedSession.turns[0].state, 'failed');
  assert.equal(state.savedSession.turns[0].interruptionReason, 'user_cancelled');
  assert.equal(state.savedSession.turns[0].reply, null);
  const html = renderState(state);
  assert.match(html, /本次生成已停止，没有保存候选/);
  assert.match(html, /上次生成已由你停止/);
  assert.doesNotMatch(html, /上次生成中断/);
  assert.doesNotMatch(html, /生成失败，可核对原请求后重试/);
});

test('联系人切换后旧停止命令不能中断新生成，旧作业身份也不会延伸到新请求', async () => {
  const f = await fixture();
  const contactA = f.sessions.keys().next().value;
  const scopeA = await f.select(contactA);
  const first = await f.start(scopeA);
  const stale = { ...scopeA, sessionId: first.job.sessionId, requestKey: first.job.requestKey,
    inputVersionId: first.job.inputVersionId };
  await f.bridge.stopGeneration(stale);
  await first.generating.catch(() => {});

  const contactB = [...f.sessions.keys()][1];
  const scopeB = await f.select(contactB);
  const second = await f.start(scopeB);
  await assert.rejects(f.bridge.stopGeneration(stale));
  assert.equal(f.interruptCount(), 1, '旧联系人停止不能命中断言中的新生成。');
  assert.equal((await f.bridge.getState()).generationJobs.find((job) => job.requestKey === second.job.requestKey).phase,
    'generating');
  await f.bridge.stopGeneration({ ...scopeB, sessionId: second.job.sessionId,
    requestKey: second.job.requestKey, inputVersionId: second.job.inputVersionId });
  await second.generating.catch(() => {});
  assert.equal(f.interruptCount(), 2);
});

test('连接换代后旧停止命令不能进入新连接或中断新生成', async () => {
  const f = await fixture();
  const contactA = f.sessions.keys().next().value;
  const scopeA = await f.select(contactA);
  const first = await f.start(scopeA);
  const stale = { ...scopeA, sessionId: first.job.sessionId, requestKey: first.job.requestKey,
    inputVersionId: first.job.inputVersionId };
  await f.bridge.stopGeneration(stale);
  await first.generating.catch(() => {});

  const contactB = [...f.sessions.keys()][1];
  const scopeB7 = await f.select(contactB);
  const oldConnection = await f.start(scopeB7);
  await f.changeConnection();
  await oldConnection.generating.catch(() => {});
  const scopeB = await f.select(contactB);
  const current = await f.start(scopeB);
  await assert.rejects(f.bridge.stopGeneration(stale));
  assert.equal(f.interruptCount(), 1, '旧连接停止不能发到新连接或命中新请求。');
  assert.equal((await f.bridge.getState()).generationJobs.find((job) => job.requestKey === current.job.requestKey).phase,
    'generating');
});

test('隐藏小窗和Esc离开视图不取消生成，真正退出才按原作业以app_quit停止', async () => {
  const f = await fixture();
  const contactId = f.sessions.keys().next().value;
  const scope = await f.select(contactId);
  const { generating, job } = await f.start(scope);

  f.replies.notifyHelperLifecycle('hidden');
  const hidden = await f.bridge.getState();
  assert.equal(hidden.phase, 'idle');
  assert.equal(f.interruptCount(), 0, '隐藏或 Esc 只离开视图，不能冒充取消。');
  assert.equal(hidden.generationJobs.find((item) => item.requestKey === job.requestKey).phase, 'generating');
  const hiddenHtml = renderState(hidden);
  assert.match(hiddenHtml, /aria-label="停止本次生成"/);
  assert.doesNotMatch(hiddenHtml, /已由你停止/);

  await f.replies.beginGenerationClosing();
  await generating.catch(() => {});
  assert.deepEqual(f.interruptReasons(), ['app_quit']);
  assert.equal(f.sessions.get(contactId).turns[0].interruptionReason, 'app_quit');
});

test('同联系人新开会话只切换展示，不取消原生成，退出仍停原会话', async () => {
  const f = await fixture();
  const contactId = f.sessions.keys().next().value;
  const scope = await f.select(contactId);
  const oldSession = f.sessions.get(contactId);
  const { generating, job } = await f.start(scope);

  await f.replies.newSavedSession(scope);
  const switched = await f.bridge.getState();
  assert.notEqual(switched.savedSession.sessionId, job.sessionId);
  assert.equal(f.interruptCount(), 0, '新开会话不能冒充取消原生成。');
  assert.equal(switched.generationJobs.find((item) => item.requestKey === job.requestKey).phase, 'generating');
  assert.equal(oldSession.turns[0].interruptionReason, null);
  assert.doesNotMatch(renderState(switched), /已由你停止/);

  await f.replies.beginGenerationClosing();
  await generating.catch(() => {});
  assert.deepEqual(f.interruptReasons(), ['app_quit']);
  assert.equal(oldSession.turns[0].interruptionReason, 'app_quit');
});

test('联系人切换只保留各自任务，不取消原生成', async () => {
  const f = await fixture();
  const [contactA, contactB] = f.sessions.keys();
  const scopeA = await f.select(contactA);
  const first = await f.start(scopeA);
  const scopeB = await f.select(contactB);
  const beforeSecond = await f.bridge.getState();
  assert.equal(beforeSecond.contactId, contactB);
  assert.equal(beforeSecond.phase, 'idle');
  assert.equal(beforeSecond.savedSession.phase, 'ready');
  const second = await f.start(scopeB, ['queued', 'generating']);

  assert.equal(f.interruptCount(), 0, '联系人切换不能冒充取消原生成。');
  const state = await f.bridge.getState();
  assert.equal(state.generationJobs.find((item) => item.requestKey === first.job.requestKey).phase, 'generating');
  assert.ok(['queued', 'generating'].includes(state.generationJobs.find((item) =>
    item.requestKey === second.job.requestKey).phase));
  assert.doesNotMatch(renderState(state), /已由你停止/);

  await f.replies.beginGenerationClosing();
  await Promise.all([first.generating.catch(() => {}), second.generating.catch(() => {})]);
  assert.deepEqual(f.interruptReasons(), ['app_quit', 'app_quit']);
  assert.equal(f.sessions.get(contactA).turns[0].interruptionReason, 'app_quit');
  assert.equal(f.sessions.get(contactB).turns[0].interruptionReason, 'app_quit');
});
