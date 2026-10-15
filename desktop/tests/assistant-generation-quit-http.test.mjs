import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { test, after } from 'node:test';
import { build } from 'esbuild';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

// 只替换 Electron 的 quit 事件；Host、公开业务桥接与认证 HTTP 均是生产实现。
const production = await build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { readContactDirectory } from './src/main/contacts/directory';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { createReplyBridge } from './src/preload/reply';
  export { BackendHost } from './src/main/backend/host';
  export { installQuitLifecycle } from './src/main/backend/quit';
  export { interruptAssistantGeneration, recoverAssistantGenerationReceipt } from './src/main/reply/assistant-generation-interruption';
  export { JsonClient, BackendRequestFailure } from './src/main/backend/json-client';
  export { readConnection } from './src/main/backend/connection';
  export { AssistantSessionPanel } from './src/renderer/AssistantSessionPanel';
  export { createElement } from 'react';
  export { renderToStaticMarkup } from 'react-dom/server';
  export { withRewriteFixture } from './tests/rewrite-backend-fixture';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'controlled-quit-event', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'controlled-quit' }));
    builder.onLoad({ filter: /.*/, namespace: 'controlled-quit' }, () => ({ contents:
      "export const app = { on: (...args) => globalThis.__notaloneControlledQuit.on(...args), quit: () => globalThis.__notaloneControlledQuit.quit() };" }));
  } }] });
const bundleDirectory = await mkdtemp('/private/tmp/notalone-a17-quit-bundle-');
await writeFile(path.join(bundleDirectory, 'production.cjs'), production.outputFiles[0].text);
const ports = (await import(path.join(bundleDirectory, 'production.cjs'))).default;
after(() => rm(bundleDirectory, { recursive: true, force: true }));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function eventually(read, accept, label) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(label);
}
function controlledApplication() {
  const listeners = [];
  let confirmed = 0, manager = 0;
  const application = { on: (name, listener) => { assert.equal(name, 'before-quit'); listeners.push(listener); },
    quit: () => { let prevented = false; const event = { preventDefault: () => { prevented = true; } };
      for (const listener of listeners) listener(event);
      if (!prevented) confirmed += 1;
    } };
  return { application, windows: { prepareToQuit: () => {}, open: async (role) => { assert.equal(role, 'manager'); manager += 1; } },
    counts: () => ({ confirmed, manager }) };
}

async function withPublicFixture(use) {
  await ports.withRewriteFixture('notalone-a17-quit-http-', async (fixture) => {
    console.log(`A17 migration actual=${fixture.data.migration_count}, repeat=${fixture.data.migration_repeat}`);
    createInterface({ input: fixture.child.stdout }).on('line', (line) => {
      const value = JSON.parse(line);
      if (value.cleanup || value.model_counts) console.log(`A17 ${JSON.stringify(value)}`);
    });
    let realConnection = await ports.readConnection(fixture.infoPath);
    const gates = [], requestGates = [], observed = [], activeResponses = new Map();
    const proxy = createServer((incoming, outgoing) => {
      const item = { method: incoming.method, path: incoming.url, completed: false };
      observed.push(item);
      activeResponses.set(item, outgoing);
      let upstream;
      const forward = (body) => {
        upstream = request({ hostname: '127.0.0.1', port: realConnection.port, method: incoming.method,
        path: incoming.url, headers: incoming.headers }, (response) => {
        item.status = response.statusCode;
        const gate = gates.find((candidate) => !candidate.entered && candidate.matches(item));
        if (!gate) { outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing); return; }
        gate.entered = true;
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks); item.completed = true;
          const payload = JSON.parse(body.toString('utf8'));
          gate.arrived.resolve(payload);
          void gate.release.promise.then(() => { if (gate.failResponse) outgoing.destroy();
            else if (gate.project) {
              const projected = Buffer.from(JSON.stringify(gate.project(payload)));
              const headers = { ...response.headers, 'content-length': projected.length };
              delete headers['transfer-encoding'];
              outgoing.writeHead(response.statusCode, headers); outgoing.end(projected);
            } else { outgoing.writeHead(response.statusCode, response.headers); outgoing.end(body); } });
        });
      });
      upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'application/json' }); outgoing.end('{"error":"synthetic_proxy_failure"}'); });
        if (body === undefined) incoming.pipe(upstream); else upstream.end(body);
      };
      const requestGate = requestGates.find((candidate) => !candidate.entered && candidate.matches(item));
      if (requestGate) {
        requestGate.entered = true;
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('end', () => {
          const body = Buffer.concat(chunks);
          requestGate.arrived.resolve({ path: item.path, body: JSON.parse(body.toString('utf8')) });
          void requestGate.release.promise.then(() => forward(body));
        });
      } else forward();
      outgoing.on('close', () => { activeResponses.delete(item); if (!outgoing.writableEnded) upstream?.destroy(); });
    });
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
    const infoPath = path.join(fixture.directory, 'controlled-host.info');
    await writeFile(infoPath, `address=127.0.0.1:${proxy.address().port}\ntoken=${realConnection.token}\npid=${realConnection.pid}\n`, { mode: 0o600 });
    await writeFile(path.join(fixture.directory, 'backend-launch.json'), JSON.stringify({ backendInfoPath: infoPath }), { mode: 0o600 });
    let host = new ports.BackendHost(fixture.directory);
    const event = controlledApplication(); globalThis.__notaloneControlledQuit = event.application;
    const handlers = new Map(), listeners = new Map();
    const commands = { handle: (channel, handler) => { assert(!handlers.has(channel)); handlers.set(channel, handler); },
      publish: (channel, state) => { for (const listener of listeners.get(channel) ?? []) listener(undefined, state); } };
    let contacts, replies, bridge;
    const rebuild = async () => {
      contacts = new ports.ContactSession(() => ports.readContactDirectory(host));
      contacts.setConnection(host.getConnectionGeneration()); await contacts.refreshContacts();
      handlers.clear(); listeners.clear();
      replies = ports.installReplyBridge(commands, host, contacts);
      bridge = ports.createReplyBridge({ invoke: async (channel, ...args) => { const handler = handlers.get(channel); assert(handler); return handler(...args); },
        on: (channel, listener) => { const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set); },
        removeListener: (channel, listener) => listeners.get(channel)?.delete(listener) });
      return { contacts, replies, bridge };
    };
    const gateResponse = (matches, failResponse = false, project) => { const gate = { matches, failResponse, project, entered: false, arrived: deferred(), release: deferred() }; gates.push(gate); return gate; };
    const gateRequest = (matches) => { const gate = { matches, entered: false, arrived: deferred(), release: deferred() }; requestGates.push(gate); return gate; };
    try {
      await host.connect(); assert.notEqual(host.getConnectionGeneration(), undefined);
      await rebuild();
      const select = async (contactId) => { contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
        const scope = { contactId, scopeRevision: contacts.getState().scopeRevision }; await bridge.readSavedSession(scope); return scope; };
      const scope = await select(fixture.data.contact_ids[0]);
      await use({ fixture, get host() { return host; }, event, observed, gateResponse, gateRequest, scope, select,
        disconnectResponse: (matches) => {
          const entry = [...activeResponses].find(([item]) => matches(item)); assert(entry, '没有可断开的本轮HTTP请求。');
          entry[1].destroy();
        },
        get contacts() { return contacts; }, get replies() { return replies; }, get bridge() { return bridge; },
        get connection() { return realConnection; },
        reopen: async () => {
          await fixture.command('restart'); realConnection = await ports.readConnection(fixture.infoPath);
          host = new ports.BackendHost(fixture.directory); await host.connect(); await rebuild();
          return select(fixture.data.contact_ids[0]);
        },
        installQuit: () => ports.installQuitLifecycle(host, event.windows,
          () => replies.beginGenerationClosing((receipt) => ports.interruptAssistantGeneration(host, receipt),
            (identity) => ports.recoverAssistantGenerationReceipt(host, identity))),
      });
    } finally {
      for (const gate of [...gates, ...requestGates]) gate.release.resolve();
      console.log(`A17 observed ${JSON.stringify(await fixture.command('counts'))}`);
      await fixture.command('release');
      await host.stop();
      proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve));
      delete globalThis.__notaloneControlledQuit;
    }
  }, undefined, path.resolve('tests/fixtures/assistant-generation-ownership.py'));
}

test('受控退出等待迟到实际prepare及interrupt确认才关闭Host，准备后退出为零模型', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成退出等待中的草稿。' });
    const prepared = f.gateResponse((item) => item.path.endsWith('/replies/prepare'));
    const interrupted = f.gateResponse((item) => item.path.endsWith('/interrupt'));
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    const actual = await prepared.arrived.promise;
    assert.equal(f.replies.pendingGenerationReceipts().length, 0);
    f.installQuit(); f.event.application.quit();
    // 只观察公开退出与真实 HTTP；等待一个事件回合而不猜内部调用顺序。
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.event.counts().confirmed, 0, '实际准备身份未知前不能确认退出。');
    assert(!f.observed.some((item) => item.path === '/api/runtime/shutdown'), 'prepare仍在返回途中，不能先关闭认证后端。');
    prepared.release.resolve();
    const result = await interrupted.arrived.promise;
    assert.equal(result.turn_id, actual.turn_id); assert.equal(result.input_version_id, actual.input_version_id);
    assert.equal(result.state, 'failed'); assert.equal(result.interruption_reason, 'app_quit');
    assert(!f.observed.some((item) => item.path === '/api/runtime/shutdown'), '中断确认仍在返回途中，不能先关Host。');
    interrupted.release.resolve(); await generating;
    await eventually(() => f.event.counts(), (counts) => counts.confirmed === 1, '中断已确认后未结束退出。');
    assert.equal(f.host.getState().phase, 'stopped');
    assert.equal((await f.fixture.command('counts')).actual_calls, 0);
    assert.equal(f.observed.filter((item) => item.path.endsWith('/replies')).length, 0);
  });
});


test('真实运行退出后公开重建只GET显示中断，显式新请求才重新生成，晚旧结果不能复活', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成原运行草稿。' });
    await f.fixture.plan({ text: '不应在重开复活的旧候选。', count: 1 }); await f.fixture.command('hold');
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    await eventually(() => f.fixture.command('counts'), (value) => value.entered, '未进入真实受控模型。');
    const receipt = f.replies.pendingGenerationReceipts()[0]; assert(receipt);
    f.installQuit(); f.event.application.quit();
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1, '运行退出尚未确认。');
    await generating; await f.fixture.command('release');
    await eventually(() => f.fixture.command('counts'), (value) => value.completed_calls === 1, '旧模型未返回。');
    const before = await f.fixture.command('counts');
    const scope = await f.reopen();
    const saved = (await f.bridge.getState()).savedSession;
    assert.equal(saved.phase, 'ready'); assert.equal(saved.turns.length, 1);
    assert.equal(saved.turns[0].state, 'failed'); assert.equal(saved.turns[0].interruptionReason, 'app_quit');
    assert.equal(saved.turns[0].reply, null);
    assert.equal(saved.turns[0].inputVersionId, receipt.inputVersionId);
    const html = ports.renderToStaticMarkup(ports.createElement(ports.AssistantSessionPanel, { replies: { state: await f.bridge.getState() } }));
    assert(html.includes('上次生成中断')); assert(!html.includes('不应在重开复活的旧候选。'));
    assert.equal((await f.fixture.command('counts')).actual_calls, before.actual_calls, '重建读取不得自动续跑。');
    f.contacts.setDraft({ ...scope, text: '合成明确重试的新草稿。' });
    await f.fixture.plan({ text: '用户明确重试的新候选。', count: 1 });
    await f.bridge.generate({ ...scope, newRequest: true });
    const newState = await f.bridge.getState(); assert.equal(newState.phase, 'ready');
    assert.equal(newState.result.candidates[0].editedText, '用户明确重试的新候选。');
    await f.bridge.readSavedSession(scope);
    const resumed = (await f.bridge.getState()).savedSession;
    assert.equal(resumed.turns.length, 2); assert.equal(resumed.turns[0].state, 'failed');
    assert.equal(resumed.turns[1].state, 'completed'); assert.notEqual(resumed.turns[1].requestKey, receipt.requestKey);
    assert.equal((await f.fixture.command('counts')).actual_calls, 2);
  });
});


test('公开重试中断使用权威原输入与新key，同时保留当前未保存草稿和要求', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成原保存草稿：只说稍后回复。' });
    await f.bridge.updateOptions({ ...f.scope, options: { tone: 'original', instruction: '原保存要求：不增加承诺。', includeRelationshipContext: false } });
    const prepared = f.gateResponse((item) => item.path.endsWith('/replies/prepare'));
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    const actual = await prepared.arrived.promise;
    f.installQuit(); f.event.application.quit(); prepared.release.resolve(); await generating;
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1, '未完成退出。');
    const scope = await f.reopen();
    f.contacts.setDraft({ ...scope, text: '当前未保存的新草稿不能被覆盖。' });
    await f.bridge.updateOptions({ ...scope, options: { tone: 'warm', instruction: '当前未保存的新要求。', includeRelationshipContext: true } });
    const before = await f.bridge.getState();
    const html = ports.renderToStaticMarkup(ports.createElement(ports.AssistantSessionPanel, { replies: { state: before } }));
    assert(html.includes('重试上次中断生成'), '已保存中断必须提供明确重试操作。');
    assert.equal((await f.fixture.command('counts')).actual_calls, 0);
    await f.fixture.plan({ text: '显式重试原保存输入的候选。', count: 1 });
    await f.bridge.retryInterruptedGeneration({ ...scope, sessionId: actual.session_id,
      turnId: actual.turn_id, inputVersionId: actual.input_version_id });
    const after = await f.bridge.getState(); assert.equal(after.phase, 'ready');
    assert.equal(after.result.input.draftText, '合成原保存草稿：只说稍后回复。');
    assert.equal(after.result.input.userInstruction, '原保存要求：不增加承诺。');
    assert.equal(after.result.input.includeRelationshipContext, false);
    assert.deepEqual(after.options, before.options);
    assert.equal(f.contacts.getState().draft, '当前未保存的新草稿不能被覆盖。');
    await f.bridge.readSavedSession(scope);
    const turns = (await f.bridge.getState()).savedSession.turns;
    assert.equal(turns.length, 2); assert.notEqual(turns[1].requestKey, turns[0].requestKey);
    assert.equal(turns[0].interruptionReason, 'app_quit'); assert.equal(turns[1].state, 'completed');
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
  });
});


test('合法最大改写要求加语气说明后中断重试完整保留权威输入并经过原预算', async () => {
  await withPublicFixture(async (f) => {
    const original = '甲'.repeat(4096);
    f.contacts.setDraft({ ...f.scope, text: '合成边界草稿：稍后回复。' });
    await f.bridge.updateOptions({ ...f.scope, options: { tone: 'concise', instruction: original, includeRelationshipContext: false } });
    const prepared = f.gateResponse((item) => item.path.endsWith('/replies/prepare'));
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    const actual = await prepared.arrived.promise;
    f.installQuit(); f.event.application.quit(); prepared.release.resolve(); await generating;
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1, '未完成边界输入退出。');
    const scope = await f.reopen();
    const savedInstruction = (await f.bridge.getState()).savedSession.turns[0].input.content.user_instruction;
    assert(savedInstruction.length > 4096); assert(savedInstruction.endsWith(original));
    assert.equal((await f.fixture.command('counts')).actual_calls, 0);
    f.contacts.setDraft({ ...scope, text: '用户另写的新草稿应保留。' });
    await f.bridge.updateOptions({ ...scope, options: { tone: 'warm', instruction: '新编辑要求应保留。', includeRelationshipContext: true } });
    const before = await f.bridge.getState();
    await f.fixture.plan({ text: '完整原要求重试后的合成候选。', count: 1 });
    await f.bridge.retryInterruptedGeneration({ ...scope, sessionId: actual.session_id,
      turnId: actual.turn_id, inputVersionId: actual.input_version_id });
    const after = await f.bridge.getState();
    assert.equal(after.phase, 'ready'); assert.equal(after.result.input.userInstruction, savedInstruction);
    assert.equal(after.result.input.draftText, '合成边界草稿：稍后回复。');
    assert.deepEqual(after.options, before.options);
    assert.equal(f.contacts.getState().draft, '用户另写的新草稿应保留。');
    await f.bridge.readSavedSession(scope);
    const turns = (await f.bridge.getState()).savedSession.turns;
    assert.equal(turns.length, 2); assert.equal(turns[1].input.content.user_instruction, savedInstruction);
    assert.notEqual(turns[1].requestKey, actual.request_key);
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
  });
});


test('字符合同允许的大草稿在prepare预算超限时保存失败输入，不启动模型或留下运行身份', async () => {
  await withPublicFixture(async (f) => {
    const sessionId = (await f.bridge.getState()).savedSession.sessionId;
    const path = `/api/contacts/${f.scope.contactId}/assistant-sessions/${sessionId}`;
    await assert.rejects(f.host.requestJson({ method: 'POST', path: `${path}/replies/prepare`,
      body: { contact_id: f.scope.contactId, idempotency_key: randomUUID(), content: {
        type: 'rewrite_draft', draft_text: '甲'.repeat(100000), user_instruction: null,
        include_relationship_context: false } } }),
    (error) => error.status === 409 && error.code === 'input_budget_exceeded');
    const saved = (await f.host.requestJson({ method: 'GET', path })).data;
    assert.equal(saved.turns.length, 1); assert.equal(saved.turns[0].state, 'failed');
    assert.equal(saved.turns[0].input.content.draft_text, '甲'.repeat(100000));
    assert.equal(saved.current_input_version_id, saved.turns[0].input_version_id);
    assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
    f.installQuit(); f.event.application.quit();
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1, '预算早拒绝后正常退出未完成。');
    assert(!f.observed.some((item) => item.path.endsWith('/interrupt')));
    assert.equal((await f.fixture.command('counts')).actual_calls, 0);
  });
});

test('已保存合法Unicode声明中断输入可经公开重试完整提交，保留原字符合同及预算', async () => {
  const content = { type: 'initiate_conversation', purpose: '🚲'.repeat(4096), user_instruction: '🕊'.repeat(4096) };
  await withPublicFixture(async (f) => {
    const sessionId = (await f.bridge.getState()).savedSession.sessionId;
    const path = `/api/contacts/${f.scope.contactId}/assistant-sessions/${sessionId}`;
    const actual = (await f.host.requestJson({ method: 'POST', path: `${path}/replies/prepare`,
      body: { contact_id: f.scope.contactId, idempotency_key: randomUUID(), content } })).data;
    await f.host.requestJson({ method: 'POST', path: `${path}/interrupt`,
      body: { request_key: actual.request_key, input_version_id: actual.input_version_id } });
    f.installQuit(); f.event.application.quit();
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1, '合法输入退出未完成。');
    const scope = await f.reopen();
    assert.equal((await f.fixture.command('counts')).actual_calls, 0);
    await f.fixture.plan({ text: '合法Unicode原输入明确重试后的候选。', count: 1 });
    f.contacts.setDraft({ ...scope, text: '不覆盖独立新草稿。' });
    await f.bridge.retryInterruptedGeneration({ ...scope, sessionId, turnId: actual.turn_id, inputVersionId: actual.input_version_id });
    const result = await f.bridge.getState(); assert.equal(result.phase, 'ready');
    await f.bridge.readSavedSession(scope);
    const turns = (await f.bridge.getState()).savedSession.turns;
    assert.equal(turns.length, 2); assert.notEqual(turns[1].requestKey, actual.request_key);
    for (const [key, value] of Object.entries(content)) assert.equal(turns[1].input.content[key], value);
    assert.equal(f.contacts.getState().draft, '不覆盖独立新草稿。');
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
  });
});


test('中断已提交但ACK丢失时禁止关Host，退出重试沿同认证连接和原actual回执幂等确认', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成确认丢包前草稿。' });
    await f.fixture.plan({ text: '丢包后不能復活的旧候选。', count: 1 }); await f.fixture.command('hold');
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    await eventually(() => f.fixture.command('counts'), (value) => value.entered, '未进入真实模型。');
    const generation = f.host.getConnectionGeneration();
    const original = f.replies.pendingGenerationReceipts()[0];
    const lost = f.gateResponse((item) => item.path.endsWith('/interrupt'), true);
    f.installQuit(); f.event.application.quit();
    const actual = await lost.arrived.promise; assert.equal(actual.interruption_reason, 'app_quit');
    lost.release.resolve(); await generating;
    await eventually(() => f.event.counts(), (value) => value.manager === 1, '失败退出未走原manager路径。');
    assert.equal(f.host.getState().phase, 'shutdown-failed');
    assert.equal(f.host.getState().canRetryShutdown, true);
    assert.equal(f.event.counts().confirmed, 0);
    assert(!f.observed.some((item) => item.path === '/api/runtime/shutdown'));
    assert.equal(f.host.getConnectionGeneration(), generation, '预排空失败不能丢掉仍认证的原连接。');
    f.event.application.quit();
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1, '重试未确认同次真实中断。');
    assert.equal(f.observed.filter((item) => item.path.endsWith('/interrupt')).length, 2);
    await f.fixture.command('release');
    const scope = await f.reopen();
    const saved = (await f.bridge.getState()).savedSession;
    assert.equal(saved.turns[0].inputVersionId, original.inputVersionId);
    assert.equal(saved.turns[0].interruptionReason, 'app_quit');
    assert.equal(saved.turns[0].reply, null);
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
  });
});


async function reserveAndQuit(f, mode = 'rewrite_draft') {
  if (mode === 'rewrite_draft') f.contacts.setDraft({ ...f.scope, text: '合成原中断输入。' });
  else {
    await f.bridge.setMode({ ...f.scope, mode });
    if (mode === 'initiate_conversation') await f.bridge.updatePurpose({ ...f.scope, purpose: '合成原主动目的：问候近况。' });
    else {
      await f.bridge.loadMessages({ ...f.scope, older: false });
      const state = await f.bridge.getState();
      await f.bridge.selectMessage({ ...f.scope, messageId: state.messages.items[0].messageId });
      await f.bridge.updateDirection({ ...f.scope, direction: '合成原回应意愿：表示愿意等候。' });
    }
    await f.bridge.updateRequirements({ ...f.scope, requirements: '合成原要求：不增加约定。' });
    await f.bridge.updateSkill({ ...f.scope, skill: { mode: 'disabled', versionId: null } });
  }
  const gate = f.gateResponse((item) => item.path.endsWith('/replies/prepare'));
  const generating = f.bridge.generate({ ...f.scope, newRequest: true });
  const receipt = await gate.arrived.promise;
  f.installQuit(); f.event.application.quit(); gate.release.resolve(); await generating;
  await eventually(() => f.event.counts(), (value) => value.confirmed === 1, '受控退出未确认。');
  return receipt;
}

for (const mode of ['initiate_conversation', 'reply_to_message']) test(`公开中断重试保留${mode}权威原意愿，只在点击后生成，不覆盖新草稿`, async () => {
  await withPublicFixture(async (f) => {
    const actual = await reserveAndQuit(f, mode);
    const scope = await f.reopen();
    f.contacts.setDraft({ ...scope, text: '新的未保存草稿。' });
    await f.bridge.setMode({ ...scope, mode });
    if (mode === 'initiate_conversation') await f.bridge.updatePurpose({ ...scope, purpose: '当前未保存的新主动目的。' });
    else await f.bridge.updateDirection({ ...scope, direction: '当前未保存的新回应方向。' });
    await f.bridge.updateRequirements({ ...scope, requirements: '当前未保存的新要求。' });
    const editing = await f.bridge.getState();
    await f.fixture.plan({ text: '明确重试原意愿的合成候选。', count: 1 });
    assert.equal((await f.fixture.command('counts')).actual_calls, 0);
    await f.bridge.retryInterruptedGeneration({ ...scope, sessionId: actual.session_id, turnId: actual.turn_id,
      inputVersionId: actual.input_version_id });
    const state = await f.bridge.getState(); assert.equal(state.phase, 'ready');
    assert.equal(state.result.input.mode, mode); assert.equal(state.result.input.userInstruction, '合成原要求：不增加约定。');
    assert.equal(state.result.input.skillChoice.mode, 'disabled');
    assert.equal(state.purpose, editing.purpose); assert.equal(state.direction, editing.direction);
    assert.equal(state.requirements, editing.requirements); assert.equal(state.mode, editing.mode);
    assert.equal(f.contacts.getState().draft, '新的未保存草稿。');
    assert.equal(mode === 'initiate_conversation' ? state.result.input.purpose : state.result.input.direction,
      mode === 'initiate_conversation' ? '合成原主动目的：问候近况。' : '合成原回应意愿：表示愿意等候。');
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
    await f.bridge.readSavedSession(scope);
    const saved = (await f.bridge.getState()).savedSession;
    assert.equal(saved.turns[0].interruptionReason, 'app_quit'); assert.equal(saved.turns[1].state, 'completed');
    assert.notEqual(saved.turns[1].requestKey, actual.request_key);
  });
});

test('中断重试拒绝外来scope、旧操作、未知turn和额外正文，CURRENT改变后零模型', async () => {
  await withPublicFixture(async (f) => {
    const actual = await reserveAndQuit(f);
    const scope = await f.reopen();
    const request = { ...scope, sessionId: actual.session_id, turnId: actual.turn_id, inputVersionId: actual.input_version_id };
    for (const invalid of [{ ...request, contactId: f.fixture.data.contact_ids[1] }, { ...request, scopeRevision: scope.scopeRevision - 1 },
      { ...request, sessionId: randomUUID() }, { ...request, turnId: randomUUID() }, { ...request, inputVersionId: randomUUID() },
      { ...request, turnId: 'invalid' }, { ...request, draft_text: '禁止RPC携正文。' }]) {
      await assert.rejects(f.bridge.retryInterruptedGeneration(invalid));
    }
    const path = `/api/contacts/${scope.contactId}/assistant-sessions/${actual.session_id}`;
    await f.host.requestJson({ method: 'POST', path: `${path}/inputs`, body: {
      expected_input_version_id: actual.input_version_id, content: { type: 'purpose_exploration',
        purpose_hint: '合成后来独立讨论', correction: '', requirements: '', answer: '', confirmed_intent: '', skill_mode: 'auto', skill_version_id: null },
    } });
    await assert.rejects(f.bridge.retryInterruptedGeneration(request));
    assert.equal((await f.fixture.command('counts')).actual_calls, 0);
    await f.bridge.readSavedSession(scope);
    const state = await f.bridge.getState();
    assert.notEqual(state.savedSession.currentInputVersionId, actual.input_version_id);
    const html = ports.renderToStaticMarkup(ports.createElement(ports.AssistantSessionPanel, { replies: { state } }));
    assert(!html.includes('重试上次中断生成'), '旧非CURRENT中断不得误作当前重试入口。');
  });
});

test('中断重试读取后CURRENT推进触发prepare409，随后普通同key重试仍保留CAS且不改未保存编辑', async () => {
  await withPublicFixture(async (f) => {
    const actual = await reserveAndQuit(f);
    const scope = await f.reopen();
    f.contacts.setDraft({ ...scope, text: 'CAS拒绝前当前未保存的新草稿。' });
    await f.bridge.updateOptions({ ...scope, options: { tone: 'warm', instruction: 'CAS拒绝前当前未保存的新要求。', includeRelationshipContext: true } });
    const editing = { draft: f.contacts.getState().draft, options: (await f.bridge.getState()).options };
    const path = `/api/contacts/${scope.contactId}/assistant-sessions/${actual.session_id}`;
    const gate = f.gateResponse((item) => item.method === 'GET' && item.path === path);
    const retrying = f.bridge.retryInterruptedGeneration({ ...scope, sessionId: actual.session_id,
      turnId: actual.turn_id, inputVersionId: actual.input_version_id });
    await gate.arrived.promise;
    const newer = await f.host.requestJson({ method: 'POST', path: `${path}/inputs`, body: {
      expected_input_version_id: actual.input_version_id, content: { type: 'purpose_exploration',
        purpose_hint: '合成prepare前独立讨论', correction: '', requirements: '', answer: '', confirmed_intent: '', skill_mode: 'auto', skill_version_id: null },
    } });
    gate.release.resolve(); await retrying;
    assert.equal((await f.bridge.getState()).phase, 'failed');
    assert.equal(f.observed.filter((item) => item.path.endsWith('/retry-interrupted/prepare')).at(-1).status, 409,
      '首次明确恢复必须实际经旧CURRENT的CAS拒绝。');
    assert.equal((await f.fixture.command('counts')).actual_calls, 0);
    const beforeOrdinaryRetry = (await f.host.requestJson({ method: 'GET', path })).data;
    assert.equal(beforeOrdinaryRetry.current_input_version_id, newer.data.input_version_id);
    assert.equal(beforeOrdinaryRetry.turns.length, 1); assert.equal(beforeOrdinaryRetry.turns[0].interruption_reason, 'app_quit');
    await f.fixture.plan({ text: '失去CAS的旧输入不应调用模型。', count: 1 });
    await f.bridge.generate({ ...scope, newRequest: false });
    assert.equal((await f.fixture.command('counts')).actual_calls, 0, '普通同key重试不得绕过明确恢复的CURRENT守卫。');
    assert.equal(f.observed.filter((item) => item.path.endsWith('/retry-interrupted/prepare')).at(-1).status, 409);
    assert.deepEqual((await f.host.requestJson({ method: 'GET', path })).data, beforeOrdinaryRetry,
      '没有领取的新key不能追加旧输入或推进独立CURRENT。');
    assert.equal(f.contacts.getState().draft, editing.draft); assert.deepEqual((await f.bridge.getState()).options, editing.options);
  });
});

test('真实已可靠完成在退出时保持completed且新CURRENT不回退，重建仅展示', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成完成先赢草稿。' });
    await f.fixture.plan({ text: '退出前已可靠保存的合成候选。', count: 1 });
    const completed = f.gateResponse((item) => item.path.endsWith('/replies'));
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    const result = await completed.arrived.promise;
    const receipt = f.replies.pendingGenerationReceipts()[0];
    assert.equal(result.state, 'completed'); assert.equal(result.turn_id, receipt.turnId);
    const path = `/api/contacts/${f.scope.contactId}/assistant-sessions/${receipt.sessionId}`;
    const later = await f.host.requestJson({ method: 'POST', path: `${path}/inputs`, body: {
      expected_input_version_id: receipt.inputVersionId, content: { type: 'purpose_exploration',
        purpose_hint: '合成可靠完成后的独立讨论', correction: '', requirements: '', answer: '', confirmed_intent: '', skill_mode: 'auto', skill_version_id: null },
    } });
    f.installQuit(); f.event.application.quit();
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1, '可靠完成退出未确认。');
    completed.release.resolve(); await generating;
    const scope = await f.reopen(); const saved = (await f.bridge.getState()).savedSession;
    assert.equal(saved.turns[0].state, 'completed'); assert.equal(saved.turns[0].interruptionReason, null);
    assert.equal(saved.turns[0].reply.candidates[0].text, '退出前已可靠保存的合成候选。');
    assert.equal(saved.currentInputVersionId, later.data.input_version_id);
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
  });
});

test('实际会话删除先于迟到prepare回执，退出核对404后完成，旧正文不能恢复', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成待删除草稿不能复活。' });
    const gate = f.gateResponse((item) => item.path.endsWith('/replies/prepare'));
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    const actual = await gate.arrived.promise;
    const path = `/api/contacts/${f.scope.contactId}/assistant-sessions/${actual.session_id}`;
    const deleted = await f.host.requestJson({ method: 'DELETE', path, body: { confirmed: true } });
    assert.equal(deleted.data.state, 'deleted');
    f.installQuit(); f.event.application.quit(); gate.release.resolve(); await generating;
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1, '删除后退出未获确认。');
    const scope = await f.reopen(); const state = await f.bridge.getState();
    assert.notEqual(state.savedSession.sessionId, actual.session_id); assert.equal(state.savedSession.turns.length, 0);
    assert(!JSON.stringify(state).includes('合成待删除草稿不能复活。'));
    assert.equal((await f.fixture.command('counts')).actual_calls, 0);
    await assert.rejects(f.bridge.retryInterruptedGeneration({ ...scope, sessionId: actual.session_id,
      turnId: actual.turn_id, inputVersionId: actual.input_version_id }));
  });
});

test('真实来源删除先赢时中断只接受无正文占位，重建和旧中断重试零模型', async () => {
  await withPublicFixture(async (f) => {
    await f.bridge.setMode({ ...f.scope, mode: 'reply_to_message' });
    await f.bridge.loadMessages({ ...f.scope, older: false });
    await f.bridge.selectMessage({ ...f.scope, messageId: (await f.bridge.getState()).messages.items[0].messageId });
    await f.bridge.updateDirection({ ...f.scope, direction: '合成退出前来源意愿。' });
    await f.bridge.updateSkill({ ...f.scope, skill: { mode: 'disabled', versionId: null } });
    const gate = f.gateResponse((item) => item.path.endsWith('/replies/prepare'));
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    const actual = await gate.arrived.promise;
    const sources = await f.host.requestJson({ method: 'GET', path: `/api/contacts/${f.scope.contactId}/sources` });
    const sourceId = sources.data.sources[0].source_id;
    await f.host.requestJson({ method: 'DELETE', path: `/api/contacts/${f.scope.contactId}/sources/${sourceId}` });
    await eventually(() => f.host.requestJson({ method: 'GET', path: `/api/contacts/${f.scope.contactId}/sources` }),
      (response) => response.data.sources.find((item) => item.source_id === sourceId)?.status === 'deleted', '实际来源删除Worker未完成。');
    f.installQuit(); f.event.application.quit(); gate.release.resolve(); await generating;
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1, '来源删除后退出未确认。');
    const scope = await f.reopen(); const state = await f.bridge.getState();
    assert.equal(state.savedSession.turns[0].state, 'redacted'); assert.equal(state.savedSession.turns[0].input, null);
    assert.equal(state.savedSession.turns[0].reply, null); assert.equal(state.savedSession.turns[0].interruptionReason, null);
    await assert.rejects(f.bridge.retryInterruptedGeneration({ ...scope, sessionId: actual.session_id,
      turnId: actual.turn_id, inputVersionId: actual.input_version_id }));
    assert.equal((await f.fixture.command('counts')).actual_calls, 0);
  });
});


test('真实prepare已提交但身份回执丢失，退出failclosed且不发长请求或shutdown', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成未知准备回执输入。' });
    const gate = f.gateResponse((item) => item.path.endsWith('/replies/prepare'), true);
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    const actual = await gate.arrived.promise; assert.equal(actual.state, 'running');
    f.installQuit(); f.event.application.quit(); gate.release.resolve(); await generating;
    await eventually(() => f.event.counts(), (value) => value.manager === 1, '未知回执未阻止退出。');
    assert.equal(f.event.counts().confirmed, 0); assert.equal(f.host.getState().phase, 'shutdown-failed');
    assert(!f.observed.some((item) => item.path.endsWith('/interrupt')), '身份未知不能猜input/turn。');
    assert(!f.observed.some((item) => item.path.endsWith('/replies')));
    assert(!f.observed.some((item) => item.path === '/api/runtime/shutdown'));
    assert.equal((await f.fixture.command('counts')).actual_calls, 0);
    const generation = f.host.getConnectionGeneration(); await f.host.connect();
    assert.equal(f.host.getConnectionGeneration(), generation, '退出重试不能悄悄建立另一个认证目标。');
  });
});

test('prepare回执丢失的首次退出失败后，明确退出重试读取原实际身份并中断且零模型', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成准备回执丢失后再退出。' });
    const gate = f.gateResponse((item) => item.path.endsWith('/replies/prepare'), true);
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    const actual = await gate.arrived.promise;
    f.installQuit(); f.event.application.quit(); gate.release.resolve(); await generating;
    await eventually(() => f.event.counts(), (value) => value.manager === 1, '首次未知回执退出未失败。');
    assert.equal(f.event.counts().confirmed, 0);
    const generation = f.host.getConnectionGeneration();
    const beforeRetry = f.observed.length;
    f.event.application.quit();
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1 || value.manager === 2, '退出重试未得到结果。');
    assert.equal(f.event.counts().confirmed, 1, '认证恢复后应按原requestKey读取实际回执再中断，不能永久阻塞退出。');
    const retried = f.observed.slice(beforeRetry);
    assert(retried.some((item) => item.method === 'GET' && item.path.endsWith(actual.session_id)));
    assert.equal(retried.filter((item) => item.path.endsWith('/interrupt')).length, 1);
    assert(!retried.some((item) => item.path.endsWith('/replies/prepare') || item.path.endsWith('/replies')));
    assert.equal((await f.fixture.command('counts')).actual_calls, 0);
    assert.notEqual(generation, undefined);
    await f.reopen();
    const saved = (await f.bridge.getState()).savedSession;
    assert.equal(saved.turns.length, 1); assert.equal(saved.turns[0].turnId, actual.turn_id);
    assert.equal(saved.turns[0].inputVersionId, actual.input_version_id);
    assert.equal(saved.turns[0].state, 'failed'); assert.equal(saved.turns[0].interruptionReason, 'app_quit');
    assert.equal(saved.turns[0].reply, null); assert.equal((await f.fixture.command('counts')).actual_calls, 0);
  });
});


test('prepare身份ACK丢失且公开生成已结束后再退出，仍保留未知归属并阻止shutdown', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成先结束传输的未知准备输入。' });
    const gate = f.gateResponse((item) => item.path.endsWith('/replies/prepare'), true);
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    const actual = await gate.arrived.promise; assert.equal(actual.state, 'running');
    gate.release.resolve(); await generating;
    assert.equal((await f.bridge.getState()).phase, 'failed');
    const path = `/api/contacts/${f.scope.contactId}/assistant-sessions/${actual.session_id}`;
    const beforeQuit = await f.host.requestJson({ method: 'GET', path });
    assert.equal(beforeQuit.data.current_input_version_id, actual.input_version_id);
    assert.equal(beforeQuit.data.turns[0].state, 'running');
    f.installQuit(); f.event.application.quit();
    await eventually(() => f.event.counts(), (value) => value.manager + value.confirmed > 0, '退出未得到可见结果。');
    assert.equal(f.event.counts().confirmed, 0, 'HTTP已结束仍不能把未知后端生成当作结束。');
    assert.equal(f.event.counts().manager, 1); assert.equal(f.host.getState().phase, 'shutdown-failed');
    assert(!f.observed.some((item) => item.path.endsWith('/interrupt')), '未知实际身份不能猜turn/input。');
    assert(!f.observed.some((item) => item.path.endsWith('/replies')));
    assert(!f.observed.some((item) => item.path === '/api/runtime/shutdown'));
    const afterQuit = await f.host.requestJson({ method: 'GET', path });
    assert.equal(afterQuit.data.turns[0].state, 'running');
    assert.equal(afterQuit.data.current_input_version_id, actual.input_version_id);
    assert.equal((await f.fixture.command('counts')).actual_calls, 0);
  });
});

test('已知prepare身份的长HTTP断开且模型仍运行，公开生成结束后退出仍实际中断并可明确重试', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成客户端先断开的运行草稿。' });
    await f.fixture.plan({ text: '断开后的旧模型结果不能复活。', count: 1 }); await f.fixture.command('hold');
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    await eventually(() => f.fixture.command('counts'), (value) => value.entered, '模型未实际运行。');
    const sessionId = (await f.bridge.getState()).savedSession.sessionId;
    const path = `/api/contacts/${f.scope.contactId}/assistant-sessions/${sessionId}`;
    const actual = (await f.host.requestJson({ method: 'GET', path })).data.turns[0];
    assert.equal(actual.state, 'running');
    f.disconnectResponse((item) => item.path === `${path}/replies`); await generating;
    assert.equal((await f.bridge.getState()).phase, 'failed');
    assert.equal((await f.fixture.command('counts')).completed_calls, 0, '客户端失败时后端模型仍须保持在途。');
    const interrupted = f.gateResponse((item) => item.path === `${path}/interrupt`);
    f.installQuit(); f.event.application.quit();
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1 || f.observed.some((item) => item.path === `${path}/interrupt`), '未观察退出裁定。');
    assert.equal(f.event.counts().confirmed, 0, '客户端断开不能提前确认后端退出。');
    const stopped = await interrupted.arrived.promise;
    assert.equal(stopped.turn_id, actual.turn_id); assert.equal(stopped.input_version_id, actual.input_version_id);
    assert.equal(stopped.state, 'failed'); assert.equal(stopped.interruption_reason, 'app_quit');
    assert(!f.observed.some((item) => item.path === '/api/runtime/shutdown'), '真实interrupt ACK到达前不能shutdown。');
    interrupted.release.resolve();
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1, 'interrupt确认后未退出。');
    await f.fixture.command('release');
    await eventually(() => f.fixture.command('counts'), (value) => value.completed_calls === 1, '旧模型未完成收尾。');
    const scope = await f.reopen(); const saved = (await f.bridge.getState()).savedSession;
    assert.equal(saved.turns[0].state, 'failed'); assert.equal(saved.turns[0].interruptionReason, 'app_quit');
    assert.equal(saved.turns[0].reply, null); assert.equal((await f.fixture.command('counts')).actual_calls, 1);
    await f.fixture.plan({ text: '用户明确恢复断开前原输入。', count: 1 });
    await f.bridge.retryInterruptedGeneration({ ...scope, sessionId, turnId: actual.turn_id, inputVersionId: actual.input_version_id });
    await f.bridge.readSavedSession(scope);
    const resumed = (await f.bridge.getState()).savedSession;
    assert.equal(resumed.turns.length, 2); assert.equal(resumed.turns[1].state, 'completed');
    assert.notEqual(resumed.turns[1].requestKey, actual.request_key);
    assert.equal((await f.fixture.command('counts')).actual_calls, 2);
  });
});

test('实际Host断连重连后退出仍中断原认证generation的未完成作业，不把旧身份套到新连接', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成原认证连接运行中的草稿。' });
    await f.fixture.plan({ text: '原连接的迟到候选不能复活。', count: 1 }); await f.fixture.command('hold');
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    await eventually(() => f.fixture.command('counts'), (value) => value.entered, '原模型没有实际运行。');
    const original = f.replies.pendingGenerationReceipts()[0];
    assert(original); const originalGeneration = f.host.getConnectionGeneration();
    const lost = f.gateResponse((item) => item.method === 'GET' && item.path === '/api/runtime/status', true);
    await lost.arrived.promise; lost.release.resolve();
    await eventually(() => f.host.getState(), (value) => value.phase === 'disconnected', 'Host未观察到真实断连。');
    await generating;
    await f.host.connect();
    assert.notEqual(f.host.getConnectionGeneration(), originalGeneration);
    assert.equal(f.host.getState().phase, 'connected');
    f.installQuit(); f.event.application.quit();
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1 || value.manager === 1, '重连后的退出没有结果。');
    assert.equal(f.event.counts().confirmed, 1, '不能因连接代数变化永久保留未停止的旧作业。');
    await f.fixture.command('release'); await f.reopen();
    const saved = (await f.bridge.getState()).savedSession;
    assert.equal(saved.turns[0].turnId, original.turnId);
    assert.equal(saved.turns[0].inputVersionId, original.inputVersionId);
    assert.equal(saved.turns[0].state, 'failed'); assert.equal(saved.turns[0].interruptionReason, 'app_quit');
    assert.equal(saved.turns[0].reply, null); assert.equal((await f.fixture.command('counts')).actual_calls, 1);
  });
});


test('正常模型失败已提交但HTTP尚在途时退出按实际无租约终态完成，不伪造app_quit', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成正常失败回包在途草稿。' });
    await f.fixture.plan({ fault: 'failure' });
    const failed = f.gateResponse((item) => item.path.endsWith('/replies'));
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    await failed.arrived.promise;
    const actual = f.replies.pendingGenerationReceipts()[0]; assert(actual);
    const path = `/api/contacts/${f.scope.contactId}/assistant-sessions/${actual.sessionId}`;
    const before = (await f.host.requestJson({ method: 'GET', path })).data;
    assert.equal(before.turns[0].state, 'failed'); assert.equal(before.turns[0].interruption_reason, null);
    f.installQuit(); f.event.application.quit();
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1 || value.manager === 1, '正常失败在途的退出没有结果。');
    failed.release.resolve(); await generating;
    assert.equal(f.event.counts().confirmed, 1, '权威正常failed且无运行租约不能永久阻塞退出。');
    await f.reopen();
    const after = (await f.bridge.getState()).savedSession;
    assert.equal(after.turns[0].turnId, actual.turnId); assert.equal(after.turns[0].state, 'failed');
    assert.equal(after.turns[0].interruptionReason, null); assert.equal(after.turns[0].reply, null);
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
  });
});


test('实际模型failed允许普通新请求并保留已完成结果，退出复验原运行租约而不改失败分类', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成模型正常失败的原输入。' });
    await f.fixture.plan({ fault: 'failure' }); await f.bridge.generate({ ...f.scope, newRequest: true });
    assert.equal((await f.bridge.getState()).phase, 'failed');
    const sessionId = (await f.bridge.getState()).savedSession.sessionId;
    const path = `/api/contacts/${f.scope.contactId}/assistant-sessions/${sessionId}`;
    const failed = (await f.host.requestJson({ method: 'GET', path })).data;
    assert.equal(failed.turns[0].state, 'failed'); assert.equal(failed.turns[0].interruption_reason, null);
    assert.equal(failed.turns[0].generation_active, false, '实际请求及最新 attempt 均已终止。');
    assert.deepEqual(f.replies.pendingGenerationReceipts(), [], '实际终态复验成功后释放退出身份。');
    f.contacts.setDraft({ ...f.scope, text: '用户明确新请求不替换已failed任务。' });
    await f.fixture.plan({ text: '正常失败后新请求的唯一完成候选。', count: 1 });
    const beforeNew = f.observed.length;
    await f.bridge.generate({ ...f.scope, newRequest: true });
    assert.equal((await f.bridge.getState()).phase, 'ready', '已结束的模型失败不能误走运行中替换。');
    const nextPrepare = f.observed.slice(beforeNew).find((item) => item.path.endsWith('/prepare'));
    assert.equal(nextPrepare.path, `${path}/replies/prepare`); assert.equal(nextPrepare.status, 200);
    const completed = (await f.host.requestJson({ method: 'GET', path })).data;
    assert.equal(completed.turns.length, 2); assert.equal(completed.turns[0].state, 'failed');
    assert.equal(completed.turns[0].interruption_reason, null); assert.equal(completed.turns[1].state, 'completed');
    assert.equal(completed.current_input_version_id, completed.turns[1].input_version_id);
    f.installQuit(); f.event.application.quit();
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1 || value.manager > 0, '终态退出未完成。');
    assert.equal(f.event.counts().confirmed, 1); assert.equal(f.event.counts().manager, 0);
    assert.equal(f.observed.filter((item) => item.path.endsWith('/interrupt')).length, 0, '已可靠复验的终态无需再中断。');
    assert.equal((await f.fixture.command('counts')).actual_calls, 2);
    await f.reopen(); const saved = (await f.bridge.getState()).savedSession;
    assert.equal(saved.turns[0].interruptionReason, null); assert.equal(saved.turns[1].state, 'completed');
    assert.equal(saved.turns[1].reply.candidates[0].text, '正常失败后新请求的唯一完成候选。');
    assert.equal((await f.fixture.command('counts')).actual_calls, 2);
  });
});

test('连续三十三次正常失败实际复验后释放身份，仍可显式新请求', { timeout: 120000 }, async () => {
  await withPublicFixture(async (f) => {
    for (let attempt = 1; attempt <= 33; attempt++) {
      if (attempt > 1) await f.bridge.newSavedSession(f.scope);
      f.contacts.setDraft({ ...f.scope, text: `第${attempt}次明确发起的合成失败输入。` });
      await f.fixture.plan({ fault: 'failure' });
      await f.bridge.generate({ ...f.scope, newRequest: true });
      assert.equal((await f.bridge.getState()).phase, 'failed');
      assert.equal((await f.fixture.command('counts')).actual_calls, attempt,
        '已结束的失败身份不能占用八项执行及排队额度。');
      const state = await f.bridge.getState();
      assert.deepEqual(f.replies.pendingGenerationReceipts(), [],
        `第${attempt}次已结束的实际租约不能累积；当前错误=${state.errorCode ?? 'none'}。`);
    }
    f.contacts.setDraft({ ...f.scope, text: '失败之后明确新发起的独立合成输入。' });
    await f.fixture.plan({ text: '连续失败后仍可正常完成。', count: 1 });
    await f.bridge.generate({ ...f.scope, newRequest: true });
    assert.equal((await f.bridge.getState()).result.candidates[0].original.text, '连续失败后仍可正常完成。');
    f.installQuit(); f.event.application.quit();
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1, '保留的失败身份退出尚未核对完成。');
    assert.equal(f.observed.filter((item) => item.path.endsWith('/interrupt')).length, 0);
    assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
    assert.equal((await f.fixture.command('counts')).actual_calls, 34);
  });
});

test('旧后端缺少实际租约状态时保留失败退出身份，退出才复验', async () => {
  await withPublicFixture(async (f) => {
    const endpoint = `/api/contacts/${f.scope.contactId}/assistant-sessions/${(await f.bridge.getState()).savedSession.sessionId}`;
    const reading = f.gateResponse((item) => item.method === 'GET' && item.path === endpoint, false,
      (payload) => ({ ...payload, turns: payload.turns.map(({ generation_active, ...turn }) => turn) }));
    f.contacts.setDraft({ ...f.scope, text: '旧协议失败响应的合成输入。' });
    await f.fixture.plan({ fault: 'failure' });
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    try {
      const actual = await reading.arrived.promise;
      assert.equal(actual.turns[0].generation_active, false);
      reading.release.resolve(); await generating;
      assert.equal(f.replies.pendingGenerationReceipts().length, 1, '字段缺失不能猜测实际租约已终止。');
      f.installQuit(); f.event.application.quit();
      await eventually(() => f.event.counts(), (value) => value.confirmed === 1, '旧协议退出复验尚未完成。');
      assert.equal(f.observed.filter((item) => item.path.endsWith('/interrupt')).length, 1);
      assert.equal((await f.fixture.command('counts')).actual_calls, 1);
    } finally { reading.release.resolve(); await generating; }
  });
});

for (const invalidation of ['connection', 'source']) {
  test(`实际终态复验回包在${invalidation}变化后不能释放旧身份或恢复失效正文`, async (t) => {
    const f = await budgetPublicFixture(t), scope = await f.connect();
    await f.bridge.setMode({ ...scope, mode: 'reply_to_message' });
    const message = (await f.bridge.getState()).messages.items[0];
    await f.bridge.selectMessage({ ...scope, messageId: message.messageId });
    await f.bridge.updateDirection({ ...scope, direction: '只回应本次合成消息。' });
    const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${(await f.bridge.getState()).savedSession.sessionId}`;
    const arrived = deferred(), released = deferred(); let held = false;
    f.delivery.after = async (request) => {
      if (!held && request.method === 'GET' && request.path === endpoint) {
        held = true; arrived.resolve(); await released.promise;
      }
    };
    await f.command('plan', { plan: { fault: 'failure' } });
    const generating = f.bridge.generate({ ...scope, newRequest: true });
    try {
      await arrived.promise;
      if (invalidation === 'connection') f.disconnect();
      else {
        const sources = await f.request(`/api/contacts/${scope.contactId}/sources`);
        const id = sources.sources[0].source_id;
        await f.request(`/api/contacts/${scope.contactId}/sources/${id}`, undefined, 'DELETE');
        await eventually(() => f.request(`/api/contacts/${scope.contactId}/sources`),
          (value) => value.sources.find((source) => source.source_id === id)?.status === 'deleted', '合成来源删除未完成。');
        await f.replies.revalidateDeletedSource(scope.contactId);
      }
      released.resolve(); await generating; f.delivery.after = undefined;
      assert.equal((await f.bridge.getState()).result, null);
      if (invalidation === 'connection') {
        assert.equal(f.replies.pendingGenerationReceipts().length, 1, '旧认证响应不能结算新连接中的停止归属。');
        let interrupts = 0;
        await f.replies.beginGenerationClosing(async (receipt) => {
          interrupts += 1;
          await f.request(`${endpoint}/interrupt`, { request_key: receipt.requestKey, input_version_id: receipt.inputVersionId });
        });
        assert.equal(interrupts, 1);
      } else {
        const saved = await f.request(endpoint);
        assert.ok(saved.turns.every((turn) => turn.state === 'redacted' && turn.input === null && turn.reply === null));
        await f.bridge.readSavedSession(scope);
        assert.ok((await f.bridge.getState()).savedSession.turns.every((turn) => turn.input === null && turn.reply === null));
      }
      assert.equal((await f.command('metrics')).model_calls, 1);
    } finally { released.resolve(); await generating; f.delivery.after = undefined; }
  });
}

test('prepare ACK丢失后同key取得实际回执可清除旧未知归属，唯一完成后正常退出', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成同key恢复准备身份的草稿。' });
    const lost = f.gateResponse((item) => item.path.endsWith('/replies/prepare'), true);
    const original = f.bridge.generate({ ...f.scope, newRequest: true });
    const actual = await lost.arrived.promise; lost.release.resolve(); await original;
    assert.equal((await f.bridge.getState()).phase, 'failed');
    const recovered = f.gateResponse((item) => item.path.endsWith('/replies/prepare'));
    await f.fixture.plan({ text: '恢复原actual身份后的唯一完成。', count: 1 });
    const retrying = f.bridge.generate({ ...f.scope, newRequest: false });
    assert.deepEqual(await recovered.arrived.promise, actual, '同key只能恢复原实际turn/input身份。');
    recovered.release.resolve(); await retrying;
    assert.equal((await f.bridge.getState()).phase, 'ready');
    const saved = (await f.host.requestJson({ method: 'GET',
      path: `/api/contacts/${f.scope.contactId}/assistant-sessions/${actual.session_id}` })).data;
    assert.equal(saved.turns.length, 1); assert.equal(saved.turns[0].state, 'completed');
    assert.equal(saved.turns[0].turn_id, actual.turn_id); assert.equal(saved.current_input_version_id, actual.input_version_id);
    f.installQuit(); f.event.application.quit();
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1 || value.manager > 0, '同key恢复后退出未完成。');
    assert.equal(f.event.counts().confirmed, 1, '实际回执已消除同key未知归属，不能永久阻塞退出。');
    assert.equal(f.event.counts().manager, 0); assert(!f.observed.some((item) => item.path.endsWith('/interrupt')));
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
  });
});

test('实际prepare因已撤销绑定明确409且未领取turn，退出不保留未知运行阻塞', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成明确拒绝的准备输入。' });
    await f.fixture.command('revoke', { contact_id: f.scope.contactId });
    await f.bridge.generate({ ...f.scope, newRequest: true });
    assert.equal((await f.bridge.getState()).phase, 'failed');
    const prepare = f.observed.find((item) => item.path.endsWith('/replies/prepare'));
    assert.equal(prepare.status, 409);
    const saved = (await f.host.requestJson({ method: 'GET',
      path: `/api/contacts/${f.scope.contactId}/assistant-sessions/${(await f.bridge.getState()).savedSession.sessionId}` })).data;
    assert.equal(saved.turns.length, 0); assert.equal(saved.current_input_version_id, null);
    f.installQuit(); f.event.application.quit();
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1 || value.manager > 0, '明确拒绝后退出未完成。');
    assert.equal(f.event.counts().confirmed, 1, '未领取的明确409不能永久保留未知运行。');
    assert.equal(f.event.counts().manager, 0); assert(!f.observed.some((item) => item.path.endsWith('/interrupt')));
    assert.equal((await f.fixture.command('counts')).actual_calls, 0);
  });
});

test('长HTTP断开后服务端完成，同key重放取得completed后新请求沿普通prepare且无重复退出身份', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成已知身份断开后完成草稿。' });
    await f.fixture.plan({ text: '断开后服务端已可靠保存的原候选。', count: 1 }); await f.fixture.command('hold');
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    await eventually(() => f.fixture.command('counts'), (value) => value.entered, '原模型未实际运行。');
    const sessionId = (await f.bridge.getState()).savedSession.sessionId;
    const path = `/api/contacts/${f.scope.contactId}/assistant-sessions/${sessionId}`;
    f.disconnectResponse((item) => item.path === `${path}/replies`); await generating;
    assert.equal((await f.bridge.getState()).phase, 'failed');
    await f.fixture.command('release');
    const saved = await eventually(async () => (await f.host.requestJson({ method: 'GET', path })).data,
      (value) => value.turns[0]?.state === 'completed', '断开后原C结果未可靠完成。');
    await f.bridge.generate({ ...f.scope, newRequest: false });
    assert.equal((await f.bridge.getState()).phase, 'ready'); assert.equal((await f.fixture.command('counts')).actual_calls, 1);
    f.contacts.setDraft({ ...f.scope, text: '已可靠完成后用户明确的新草稿。' });
    await f.fixture.plan({ text: '同key完成消歧后的新候选。', count: 1 });
    const beforeNew = f.observed.length; await f.bridge.generate({ ...f.scope, newRequest: true });
    assert.equal((await f.bridge.getState()).phase, 'ready', '旧已完成身份不能误作运行中替换。');
    const prepared = f.observed.slice(beforeNew).find((item) => item.path.endsWith('/prepare'));
    assert.equal(prepared.path, `${path}/replies/prepare`); assert.equal(prepared.status, 200);
    const newer = (await f.host.requestJson({ method: 'GET', path })).data;
    assert.equal(newer.turns.length, 2); assert.equal(newer.turns[0].turn_id, saved.turns[0].turn_id);
    assert.equal(newer.turns.filter((turn) => turn.state === 'completed').length, 2);
    f.installQuit(); f.event.application.quit();
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1 || value.manager > 0, '同key终态退出未完成。');
    assert.equal(f.event.counts().confirmed, 1); assert(!f.observed.some((item) => item.path.endsWith('/interrupt')));
    assert.equal((await f.fixture.command('counts')).actual_calls, 2);
  });
});

test('中断恢复已领取新turn后正常模型失败，普通同key重试复用原turn并保留CAS约定', async () => {
  await withPublicFixture(async (f) => {
    const interrupted = await reserveAndQuit(f);
    const scope = await f.reopen();
    f.contacts.setDraft({ ...scope, text: '当前未保存草稿保持独立，不替换原恢复输入。' });
    await f.bridge.updateOptions({ ...scope, options: { tone: 'warm', instruction: '当前未保存要求保持独立。', includeRelationshipContext: true } });
    const editing = { draft: f.contacts.getState().draft, options: (await f.bridge.getState()).options };
    await f.fixture.plan({ fault: 'failure' });
    await f.bridge.retryInterruptedGeneration({ ...scope, sessionId: interrupted.session_id,
      turnId: interrupted.turn_id, inputVersionId: interrupted.input_version_id });
    assert.equal((await f.bridge.getState()).phase, 'failed');
    const path = `/api/contacts/${scope.contactId}/assistant-sessions/${interrupted.session_id}`;
    const failed = (await f.host.requestJson({ method: 'GET', path })).data;
    assert.equal(failed.turns.length, 2); assert.equal(failed.turns[1].state, 'failed');
    assert.equal(failed.turns[1].interruption_reason, null); assert.notEqual(failed.turns[1].request_key, interrupted.request_key);
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
    await f.fixture.plan({ text: '同恢复key失败重试后的唯一保存结果。', count: 1 });
    await f.bridge.generate({ ...scope, newRequest: false });
    assert.equal((await f.bridge.getState()).phase, 'ready', 'CAS保留不能阻止已领取的同key正常失败重试。');
    const completed = (await f.host.requestJson({ method: 'GET', path })).data;
    assert.equal(completed.turns.length, 2); assert.equal(completed.turns[0].interruption_reason, 'app_quit');
    assert.equal(completed.turns[1].turn_id, failed.turns[1].turn_id);
    assert.equal(completed.turns[1].request_key, failed.turns[1].request_key);
    assert.equal(completed.turns[1].input_version_id, failed.turns[1].input_version_id);
    assert.equal(completed.turns[1].state, 'completed'); assert.equal(completed.current_input_version_id, failed.current_input_version_id);
    assert.equal((await f.fixture.command('counts')).actual_calls, 2);
    assert.equal(f.contacts.getState().draft, editing.draft); assert.deepEqual((await f.bridge.getState()).options, editing.options);
  });
});

test('原绑定撤销后恢复仍只读，明确中断重试经原准备门禁拒绝且零模型', async () => {
  await withPublicFixture(async (f) => {
    const actual = await reserveAndQuit(f);
    const scope = await f.reopen(); await f.fixture.command('revoke', { contact_id: scope.contactId });
    await f.bridge.retryInterruptedGeneration({ ...scope, sessionId: actual.session_id,
      turnId: actual.turn_id, inputVersionId: actual.input_version_id });
    const state = await f.bridge.getState(); assert.equal(state.phase, 'failed');
    assert.equal(state.result, null); assert.equal((await f.fixture.command('counts')).actual_calls, 0);
    const saved = await f.host.requestJson({ method: 'GET',
      path: `/api/contacts/${scope.contactId}/assistant-sessions/${actual.session_id}` });
    assert.equal(saved.data.turns.length, 1); assert.equal(saved.data.turns[0].interruption_reason, 'app_quit');
  });
});

for (const mode of ['rewrite_draft', 'initiate_conversation', 'reply_to_message']) test(`真实${mode}模型运行中退出后恢复中断，迟到不保存且零自动续跑`, async () => {
  await withPublicFixture(async (f) => {
    if (mode === 'rewrite_draft') f.contacts.setDraft({ ...f.scope, text: '合成实际运行中退出草稿。' });
    else {
      await f.bridge.setMode({ ...f.scope, mode });
      await f.bridge.updateSkill({ ...f.scope, skill: { mode: 'disabled', versionId: null } });
      if (mode === 'initiate_conversation') await f.bridge.updatePurpose({ ...f.scope, purpose: '合成实际运行中退出目的。' });
      else {
        await f.bridge.loadMessages({ ...f.scope, older: false });
        await f.bridge.selectMessage({ ...f.scope, messageId: (await f.bridge.getState()).messages.items[0].messageId });
        await f.bridge.updateDirection({ ...f.scope, direction: '合成实际运行中退出方向。' });
      }
    }
    await f.fixture.plan({ text: '运行旧候选不能保存。', count: 1 }); await f.fixture.command('hold');
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    await eventually(() => f.fixture.command('counts'), (value) => value.entered, '实际模型未进入。');
    f.installQuit(); f.event.application.quit();
    await eventually(() => f.event.counts(), (value) => value.confirmed === 1, '实际运行退出尚未确认。');
    await generating; await f.fixture.command('release');
    await eventually(() => f.fixture.command('counts'), (value) => value.completed_calls === 1, '旧实际模型未收尾。');
    await f.reopen(); const state = await f.bridge.getState();
    assert.equal(state.savedSession.turns[0].interruptionReason, 'app_quit');
    assert.equal(state.savedSession.turns[0].reply, null); assert.equal(state.savedSession.turns[0].state, 'failed');
    assert(!JSON.stringify(state).includes('运行旧候选不能保存。'));
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
  });
});

async function prepareBudgetRejectionHasNoModelLease(t, unknown) {
  const f = await budgetPublicFixture(t); await f.configure({ capacity: 101, unknown });
  const scope = await f.connect(), initial = await f.bridge.getState();
  const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${initial.savedSession.sessionId}`;
  const text = '预算复验故障后同键重试的合成草稿。';
  const options = { tone: 'concise', instruction: '保留本次合成要求。', includeRelationshipContext: false };
  f.contacts.setDraft({ ...scope, text }); await f.bridge.updateOptions({ ...scope, options });
  let preparations = 0, longRequests = 0, verificationReads = 0;
  f.delivery.after = (request) => {
    if (request.method === 'POST' && request.path.endsWith('/replies/prepare')) preparations += 1;
    else if (request.method === 'POST' && request.path.endsWith('/replies')) longRequests += 1;
    else if (request.method === 'GET' && request.path === endpoint) verificationReads += 1;
  };
  try { await f.bridge.generate({ ...scope, newRequest: true }); }
  finally { f.delivery.after = undefined; }
  assert.equal(preparations, 1); assert.equal(longRequests, 0);
  assert.equal(verificationReads, 1, 'prepare预算拒绝仍须读取真实保存的失败输入。');
  const failed = await f.bridge.getState(), persisted = await f.request(endpoint);
  assert.equal(failed.phase, 'failed'); assert.equal(failed.canRetry, false);
  assert.equal(failed.errorCode, unknown ? 'input_budget_unavailable' : 'input_budget_exceeded');
  assert.equal(failed.inputBudgetNotice.decision.state, unknown ? 'unavailable' : 'exceeded');
  assert.equal(persisted.turns.length, 1); assert.equal(persisted.turns[0].state, 'failed');
  const actual = persisted.turns[0];
  assert.equal(persisted.current_input_version_id, actual.input_version_id);
  const receipts = f.replies.pendingGenerationReceipts(); assert.equal(receipts.length, 1);
  assert.equal(receipts[0].turnId, actual.turn_id); assert.equal(receipts[0].requestKey, actual.request_key);
  assert.equal(f.contacts.getState().draft, text); assert.deepEqual(failed.options, options);

  await f.bridge.generate({ ...scope, newRequest: false });
  const retried = await f.bridge.getState(), after = await f.request(endpoint);
  assert.equal(retried.phase, 'failed'); assert.equal(retried.errorCode, failed.errorCode);
  assert.equal(retried.canRetry, false); assert.equal(after.turns.length, 1);
  assert.equal(after.turns[0].turn_id, actual.turn_id); assert.equal(after.turns[0].request_key, actual.request_key);
  assert.equal(after.current_input_version_id, actual.input_version_id);
  let interrupts = 0; await f.replies.beginGenerationClosing(async (actual) => {
    interrupts += 1; await ports.interruptAssistantGeneration(f.backend, actual);
  });
  assert.equal(interrupts, 1, '没有当前租约证明时，退出仍按实际保存身份核对。');
  assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
  assert.equal(f.contacts.getState().draft, text); assert.deepEqual(retried.options, options);
  assert.equal((await f.command('metrics')).model_calls, 0);
}

test('prepare预算超限保留真实失败输入，同键显式再试及退出保持零模型', async (t) => {
  await prepareBudgetRejectionHasNoModelLease(t, false);
});

test('prepare预算能力未知保留真实失败输入，同键显式再试及退出保持零模型', async (t) => {
  await prepareBudgetRejectionHasNoModelLease(t, true);
});

for (const kind of ['connection', 'response']) test(`prepare预算拒绝后的唯一复验${kind}故障保持未知身份，首次退出失败后明确重试恢复原实际身份`, async (t) => {
  const f = await budgetPublicFixture(t); await f.configure({ capacity: 101 });
  const scope = await f.connect(), initial = await f.bridge.getState();
  const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${initial.savedSession.sessionId}`;
  const text = '预算复验故障仍可可靠退出的合成草稿。';
  f.contacts.setDraft({ ...scope, text });
  let rejected = false, reads = 0;
  f.delivery.after = (request) => {
    if (request.method === 'POST' && request.path.endsWith('/replies/prepare')) rejected = true;
    else if (rejected && request.method === 'GET' && request.path === endpoint && ++reads === 1) {
      throw new f.BackendRequestFailure(kind, kind === 'response' ? 503 : undefined);
    }
  };
  try { await f.bridge.generate({ ...scope, newRequest: true }); }
  finally { f.delivery.after = undefined; }
  const failed = await f.bridge.getState();
  assert.equal(reads, 1); assert.equal(failed.phase, 'failed');
  assert.equal(failed.errorCode, kind === 'connection' ? 'connection' : 'unavailable');
  assert.equal(failed.inputBudgetNotice, undefined);
  assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
  const persisted = await f.request(endpoint); assert.equal(persisted.turns.length, 1);
  let interrupts = 0, recoveries = 0; const closingRequests = [];
  const interrupt = async (actual) => {
    interrupts += 1; assert.equal(actual.turnId, persisted.turns[0].turn_id);
    assert.equal(actual.requestKey, persisted.turns[0].request_key);
    assert.equal(actual.inputVersionId, persisted.turns[0].input_version_id);
    await ports.interruptAssistantGeneration(f.backend, actual);
  };
  const recover = (identity) => { recoveries += 1; return ports.recoverAssistantGenerationReceipt(f.backend, identity); };
  f.delivery.after = (request) => closingRequests.push({ method: request.method, path: request.path });
  try {
    await assert.rejects(f.replies.beginGenerationClosing(interrupt, recover), /本次生成身份尚未确认/);
    assert.equal(interrupts, 0); assert.equal(recoveries, 0, '首次退出仍须保留未知准备身份。');
    assert.deepEqual(f.replies.pendingGenerationReceipts(), []);

    await f.replies.beginGenerationClosing(interrupt, recover);

    assert.equal(recoveries, 1);
    assert(closingRequests.some((request) => request.method === 'GET' && request.path === endpoint));
    assert.equal(closingRequests.filter((request) => request.method === 'POST' && request.path === endpoint + '/interrupt').length, 1);
    assert(!closingRequests.some((request) => request.path.endsWith('/replies/prepare') || request.path.endsWith('/replies')),
      '明确退出重试只读原身份再中断，不能重新准备或生成。');
  } finally { f.delivery.after = undefined; }
  assert.equal(interrupts, 1); assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
  assert.deepEqual(await f.request(endpoint), persisted, '退出确认保留原预算失败输入、分类和 CURRENT。');
  assert.equal(f.contacts.getState().draft, text); assert.equal((await f.command('metrics')).model_calls, 0);
});

for (const leave of ['hidden', 'new_session']) {
  test(`prepare预算409在${leave}离开视图后晚到，核对实际失败身份但不发布到当前SID`, async (t) => {
    const f = await budgetPublicFixture(t); await f.configure({ capacity: 101 });
    const scope = await f.connect(), initial = await f.bridge.getState();
    const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${initial.savedSession.sessionId}`;
    f.contacts.setDraft({ ...scope, text: '离开视图后预算拒绝的合成草稿。' });
    const rejected = deferred(), release = deferred(); let verificationReads = 0;
    f.delivery.after = async (request) => {
      if (request.method === 'POST' && request.path.endsWith('/replies/prepare')) { rejected.resolve(); await release.promise; }
      else if (request.method === 'GET' && request.path === endpoint) verificationReads += 1;
    };
    const generating = f.bridge.generate({ ...scope, newRequest: true });
    try {
      await rejected.promise;
      const actual = await f.request(endpoint);
      assert.equal(actual.turns.length, 1); assert.equal(actual.turns[0].state, 'failed');
      assert.equal(actual.current_input_version_id, actual.turns[0].input_version_id);
      assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
      if (leave === 'hidden') f.replies.notifyHelperLifecycle('hidden');
      else await f.bridge.newSavedSession(scope);
      const before = await f.bridge.getState();
      if (leave === 'new_session') assert.notEqual(before.savedSession.sessionId, actual.session_id);
      release.resolve(); await generating;
      assert.equal(verificationReads, 1, '离开视图后仍只复验一次原失败输入。');
      const { revision: beforeRevision, generationJobs: beforeJobs, ...beforeView } = before;
      const { revision: afterRevision, generationJobs: afterJobs, ...afterView } = await f.bridge.getState();
      assert.deepEqual(afterView, beforeView, '只允许更新后台作业元数据，不回写已离开的业务视图。');
      const receipt = f.replies.pendingGenerationReceipts()[0]; assert(receipt);
      assert.equal(receipt.turnId, actual.turns[0].turn_id);
      let interrupts = 0; await f.replies.beginGenerationClosing(async (actual) => {
        interrupts += 1; await ports.interruptAssistantGeneration(f.backend, actual);
      });
      assert.equal(interrupts, 1); assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
      const saved = await f.request(endpoint);
      assert.equal(saved.turns.length, 1); assert.equal(saved.turns[0].request_key, receipt.requestKey);
      assert.equal(saved.current_input_version_id, receipt.inputVersionId); assert.equal(saved.turns[0].state, 'failed');
      assert.equal((await f.command('metrics')).model_calls, 0);
    } finally { release.resolve(); await generating; f.delivery.after = undefined; }
  });
}


test('旧业务失败已送达而同key实际C重试仍运行，历史failed不能释放退出停止身份', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成旧业务失败与同键运行租约的草稿。' });
    await f.fixture.plan({ fault: 'failure' });
    const failed = f.gateResponse((item) => item.path.endsWith('/replies'));
    const original = f.bridge.generate({ ...f.scope, newRequest: true });
    await failed.arrived.promise;
    const receipt = f.replies.pendingGenerationReceipts()[0]; assert(receipt);
    const path = `/api/contacts/${f.scope.contactId}/assistant-sessions/${receipt.sessionId}`;
    const before = (await f.host.requestJson({ method: 'GET', path })).data;
    assert.equal(before.turns[0].state, 'failed');
    assert.equal(before.turns[0].interruption_reason, null);
    await f.fixture.plan({ text: '同键重试的迟到候选不能在退出后复活。', count: 1 });
    await f.fixture.command('hold');
    const retry = f.host.requestJson({ method: 'POST', path: `${path}/replies`,
      body: { contact_id: f.scope.contactId, idempotency_key: receipt.requestKey, content: before.turns[0].input.content }
    }).then((result) => ({ result }), (error) => ({ error }));
    try {
      await eventually(() => f.fixture.command('counts'),
        (value) => value.actual_calls === 2 && value.entered, '同key第二次C模型没有实际进入。');
      const historical = (await f.host.requestJson({ method: 'GET', path })).data;
      assert.equal(historical.turns[0].state, 'failed', '实际重试已运行，A历史仍可保持failed。');
      assert.equal(historical.turns[0].generation_active, true, '历史 failed 必须同时报告实际 C 运行租约。');
      assert.equal(historical.turns[0].request_key, receipt.requestKey);
      failed.release.resolve(); await original;
      assert.equal((await f.bridge.getState()).phase, 'failed');
      f.installQuit(); f.event.application.quit();
      await eventually(() => f.event.counts(), (value) => value.confirmed === 1 || value.manager > 0, '实际租约退出没有结果。');
      assert.equal(f.event.counts().confirmed, 1);
      assert.equal(f.observed.filter((item) => item.path === `${path}/interrupt`).length, 1,
        '历史failed不能替代原事务的C最新运行租约裁定。');
      await f.fixture.command('release'); await retry;
      await eventually(() => f.fixture.command('counts'), (value) => value.completed_calls === 2, '同键迟到模型未收尾。');
      await f.reopen();
      const saved = (await f.bridge.getState()).savedSession;
      assert.equal(saved.turns.length, 1); assert.equal(saved.turns[0].turnId, receipt.turnId);
      assert.equal(saved.turns[0].state, 'failed'); assert.equal(saved.turns[0].interruptionReason, 'app_quit');
      assert.equal(saved.turns[0].reply, null); assert.equal((await f.fixture.command('counts')).actual_calls, 2);
    } finally { failed.release.resolve(); await f.fixture.command('release'); await original; await retry; }
  });
});


test('同键已实际运行而本次准备因撤销绑定409，拒绝不能直接释放退出归属', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成同key既有运行与准备拒绝的输入。' });
    await f.fixture.plan({ text: '同key迟到候选不能绕过退出归属。', count: 1 });
    await f.fixture.command('hold');
    const requestGate = f.gateRequest((item) => item.path.endsWith('/replies/prepare'));
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    const attempted = await requestGate.arrived.promise;
    const client = new ports.JsonClient(f.connection);
    const running = client.perform({ method: 'POST', path: attempted.path.replace(/\/prepare$/, ''),
      body: attempted.body, timeoutMs: 25_000 }).then((value) => ({ value }), (error) => ({ error }));
    try {
      await eventually(() => f.fixture.command('counts'),
        (counts) => counts.actual_calls === 1 && counts.entered, '同key必须实际进入受控C模型。');
      await f.fixture.command('revoke', { contact_id: f.scope.contactId });
      requestGate.release.resolve(); await generating;
      const refused = f.observed.find((item) => item.path === attempted.path);
      assert.equal(refused.status, 409, '必须是原真实prepare业务拒绝，不能伪造负回包。');
      assert.equal((await f.bridge.getState()).phase, 'failed');
      assert.equal((await f.fixture.command('counts')).actual_calls, 1);
      f.installQuit(); f.event.application.quit();
      await eventually(() => f.event.counts(), (counts) => counts.confirmed + counts.manager > 0, '退出未得到可见裁定。');
      assert.equal(f.event.counts().confirmed, 0, '泛409没有证明同key既有运行结束，不能直接关闭Host。');
      assert.equal(f.event.counts().manager, 1);
      assert(!f.observed.some((item) => item.path === '/api/runtime/shutdown'));
      assert(!f.observed.some((item) => item.path.endsWith('/interrupt')), '没有实际turn/input回执不能猜身份。');
    } finally {
      requestGate.release.resolve(); await f.fixture.command('release'); await generating; await running; client.cancelPending();
    }
  });
});

test('真实零领取证明响应丢失后同key再证明，释放本次及已结束传输的未知旧句柄', async () => {
  await withPublicFixture(async (f) => {
    f.contacts.setDraft({ ...f.scope, text: '合成零领取证明与同key未知旧句柄。' });
    await f.fixture.command('revoke', { contact_id: f.scope.contactId });
    const lost = f.gateResponse((item) => item.path.endsWith('/replies/prepare'), true);
    const generating = f.bridge.generate({ ...f.scope, newRequest: true });
    const rejected = await lost.arrived.promise;
    assert.equal(rejected.no_generation.state, 'not_reserved');
    assert.equal(rejected.no_generation.contact_id, f.scope.contactId);
    lost.release.resolve(); await generating;
    assert.equal((await f.bridge.getState()).phase, 'failed');
    await f.bridge.generate({ ...f.scope, newRequest: false });
    assert.equal((await f.bridge.getState()).phase, 'failed');
    assert.equal((await f.fixture.command('counts')).actual_calls, 0);
    f.installQuit(); f.event.application.quit();
    await eventually(() => f.event.counts(), (counts) => counts.confirmed + counts.manager > 0, '同key证明未完成退出裁定。');
    assert.equal(f.event.counts().confirmed, 1, '已提交同key证明须清本次及无实际回执、transport已结束的旧身份。');
    assert.equal(f.event.counts().manager, 0);
    assert(!f.observed.some((item) => item.path.endsWith('/interrupt')));
    assert(!f.observed.some((item) => item.path.endsWith('/replies')));
    assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
  });
});
