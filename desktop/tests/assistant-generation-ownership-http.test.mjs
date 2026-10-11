import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { test, after } from 'node:test';
import { build } from 'esbuild';

const production = await build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { readContactDirectory } from './src/main/contacts/directory';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { createReplyBridge } from './src/preload/reply';
  export { JsonClient, BackendRequestFailure } from './src/main/backend/json-client';
  export { readConnection } from './src/main/backend/connection';
  export { withRewriteFixture } from './tests/rewrite-backend-fixture';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const bundleDirectory = await mkdtemp('/private/tmp/notalone-a16-bundle-');
await writeFile(path.join(bundleDirectory, 'production.mjs'), production.outputFiles[0].text);
const ports = await import(path.join(bundleDirectory, 'production.mjs'));
after(() => rm(bundleDirectory, { recursive: true, force: true }));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function eventually(read, accept, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await read();
    if (accept(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(label);
}

// 合成宿主与消息流不启动 App；所有业务 RPC 经生产 JsonClient 访问实际 PG 后端。
async function withPublicFixture(use) {
  await ports.withRewriteFixture('notalone-a16-http-', async (fixture) => {
    console.log(`A16 migration actual=${fixture.data.migration_count}, repeat=${fixture.data.migration_repeat}`);
    createInterface({ input: fixture.child.stdout }).on('line', (line) => {
      const value = JSON.parse(line);
      if (value.cleanup || value.model_counts) console.log(`A16 ${JSON.stringify(value)}`);
    });
    const connection = await ports.readConnection(fixture.infoPath);
    let client = new ports.JsonClient(connection);
    let generation = 7;
    const backendListeners = new Set(), handlers = new Map(), listeners = new Map(), requests = [];
    const responseGates = [];
    const backend = {
      getConnectionGeneration: () => generation,
      onStateChanged: (listener) => { backendListeners.add(listener); return () => backendListeners.delete(listener); },
      subscribeMessages: (observer) => observer.connected(),
      requestJson: async (request) => {
        const captured = generation;
        const observed = { path: request.path, method: request.method, signal: request.signal,
          requestKey: request.body?.idempotency_key ?? request.body?.replacement?.idempotency_key,
          runningKey: request.body?.running_request_key,
          bodyHash: request.body === undefined ? null : createHash('sha256').update(JSON.stringify(request.body.replacement ?? request.body)).digest('hex') };
        requests.push(observed);
        let response;
        try { response = await client.perform(request); observed.status = response.status; }
        catch (error) {
          observed.failure = { kind: error.kind, status: error.status, code: error.code, reason: error.reason };
          const gate = responseGates.find((item) => item.rejected && !item.entered && item.matches(request));
          if (gate) { gate.entered = true; gate.arrived.resolve(observed.failure); await gate.release.promise; }
          throw error;
        }
        const gate = responseGates.find((item) => !item.rejected && !item.entered && item.matches(request));
        if (gate) { gate.entered = true; gate.arrived.resolve(response.data); await gate.release.promise; }
        if (captured !== generation) throw new ports.BackendRequestFailure('cancelled');
        return { generation: captured, data: response.data };
      },
    };
    const commands = {
      handle: (channel, handler, role) => { assert(!handlers.has(channel)); handlers.set(channel, { handler, role }); },
      publish: (channel, state) => { for (const listener of listeners.get(channel) ?? []) listener(undefined, state); },
    };
    const contacts = new ports.ContactSession(() => ports.readContactDirectory(backend));
    contacts.setConnection(generation); await contacts.refreshContacts();
    const replies = ports.installReplyBridge(commands, backend, contacts);
    const bridge = ports.createReplyBridge({
      invoke: async (channel, ...args) => { const rpc = handlers.get(channel); assert(rpc); return rpc.handler(...args); },
      on: (channel, listener) => { const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set); },
      removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
    });
    const selectContact = async (contactId) => {
      contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
      const scope = { contactId, scopeRevision: contacts.getState().scopeRevision };
      await bridge.readSavedSession(scope);
      return scope;
    };
    const gateResponse = (matches, rejected = false) => {
      const gate = { matches, rejected, entered: false, arrived: deferred(), release: deferred() };
      responseGates.push(gate); return gate;
    };
    const start = async (scope, mode = 'rewrite_draft') => {
      const before = requests.length;
      if (mode === 'rewrite_draft') contacts.setDraft({ ...scope, text: '合成原草稿：我稍后回复。' });
      else {
        await bridge.setMode({ ...scope, mode });
        if (mode === 'initiate_conversation') await bridge.updatePurpose({ ...scope, purpose: '合成主动目的：问候近况。' });
        else {
          await bridge.loadMessages({ ...scope, older: false });
          const state = await bridge.getState();
          await bridge.selectMessage({ ...scope, messageId: state.messages.items[0].messageId });
          await bridge.updateDirection({ ...scope, direction: '合成直接意愿：表示愿意等待。' });
        }
      }
      const sessionId = (await bridge.getState()).savedSession.sessionId;
      await fixture.plan({ text: '只归原会话的合成候选。', count: 1 }); await fixture.command('hold');
      const promise = bridge.generate({ ...scope, newRequest: true });
      await eventually(() => fixture.command('counts'), (counts) => counts.entered, '公开生成未到达实际模型。');
      const request = requests.slice(before).find((item) => item.path.endsWith('/replies'));
      assert(request, '必须访问原候选生成长链。');
      return { promise, request, sessionId };
    };
    const rawSession = (contactId, sessionId) => backend.requestJson({ method: 'GET',
      path: `/api/contacts/${contactId}/assistant-sessions/${sessionId}` }).then((response) => response.data);
    try { await use({ fixture, bridge, replies, contacts, selectContact, start, requests, gateResponse,
      rawSession, backend, contactA: fixture.data.contact_ids[0], contactB: fixture.data.contact_ids[1],
      changeConnection: async () => {
        generation += 1; client.cancelPending(); for (const listener of backendListeners) listener(); contacts.setConnection(undefined);
        await fixture.command('restart'); client = new ports.JsonClient(await ports.readConnection(fixture.infoPath));
        contacts.setConnection(generation); await contacts.refreshContacts();
      } }); }
    finally {
      for (const gate of responseGates) gate.release.resolve();
      console.log(`A16 observed ${JSON.stringify(await fixture.command('counts'))}`);
      await fixture.command('release'); client.cancelPending();
    }
  }, undefined, path.resolve('tests/fixtures/assistant-generation-ownership.py'));
}

test('关闭未确认方向探索后，原HTTP晚回包不能恢复活跃建议，重显只读历史', async () => {
  await withPublicFixture(async (f) => {
    const scope = await f.selectContact(f.contactA);
    await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
    await f.bridge.updatePurpose({ ...scope, purpose: '了解近况，尚未确认意愿。' });
    await f.fixture.plan({ explore: { understanding: '关闭后不应恢复的合成理解。' } });
    await f.fixture.command('hold');
    const exploring = f.bridge.explore(scope);
    await eventually(() => f.fixture.command('counts'), (counts) => counts.entered,
      '公开探索未到达实际模型。');
    f.replies.notifyHelperLifecycle('hidden');
    await f.fixture.command('release'); await exploring;
    const state = await f.bridge.getState();
    assert.equal(state.exploration.result, null, '关闭的任务不能发布迟到建议。');
    assert.notEqual(state.exploration.phase, 'waiting');
    f.replies.notifyHelperLifecycle('focused');
    await eventually(() => f.bridge.getState(), (value) => value.savedSession?.phase === 'ready',
      '重显未完成既有会话读取。');
    assert.equal((await f.bridge.getState()).exploration.result, null,
      '仅重显窗口不能重新授权旧探索任务。');
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
  });
});

test('公开生成切换联系人后继续，C唯一保存原SID，迟到A不覆盖B，返回A只GET恢复', async () => {
  await withPublicFixture(async (f) => {
    const scopeA = await f.selectContact(f.contactA);
    const job = await f.start(scopeA);
    await f.selectContact(f.contactB);
    assert.equal(job.request.signal.aborted, false, '离开联系人只离开视图，不取消原模型请求。');
    await f.fixture.command('release'); await job.promise;
    const saved = await eventually(() => f.rawSession(f.contactA, job.sessionId),
      (value) => value.turns[0]?.state === 'completed', '原会话结果未可靠保存。');
    assert.equal(saved.turns.length, 1); assert.equal(saved.turns[0].reply.candidates.length, 1);
    assert.equal(saved.turns[0].reply.candidates[0].text, '只归原会话的合成候选。');
    const stateB = await f.bridge.getState(); assert.equal(stateB.contactId, f.contactB);
    assert(!JSON.stringify(stateB).includes('只归原会话的合成候选。'));
    const before = await f.fixture.command('counts');
    await f.selectContact(f.contactA);
    const stateA = await f.bridge.getState();
    assert.equal(stateA.savedSession.turns[0].reply.candidates[0].text, '只归原会话的合成候选。');
    assert.equal((await f.fixture.command('counts')).actual_calls, before.actual_calls);
    assert.equal(before.actual_calls, 1);
    const prepare = f.requests.find((item) => item.path === job.request.path + '/prepare');
    assert(prepare, '公开正常生成必须获取实际prepare回执。');
    assert.equal(prepare.bodyHash, job.request.bodyHash);
    console.log('A16 tracer actual models=1, completed turns=1, recovery models=0');
  });
});

test('同联系人运行中可新开并选择另SID，原生成继续且新视图零旧正文，选回只恢复', async () => {
  await withPublicFixture(async (f) => {
    const scope = await f.selectContact(f.contactA);
    const job = await f.start(scope);
    await f.bridge.newSavedSession(scope);
    const newState = await f.bridge.getState();
    const otherId = newState.savedSession.sessionId;
    assert.notEqual(otherId, job.sessionId);
    assert.equal(job.request.signal.aborted, false, '新开助手会话不取消原生成。');
    await f.bridge.selectSavedSession({ ...scope, sessionId: job.sessionId });
    await f.bridge.selectSavedSession({ ...scope, sessionId: otherId });
    assert.equal(job.request.signal.aborted, false, '选择另一助手会话只改变视图。');
    await f.fixture.command('release'); await job.promise;
    const original = await f.rawSession(f.contactA, job.sessionId);
    assert.equal(original.turns[0].state, 'completed');
    assert.equal(original.turns.length, 1);
    assert.equal((await f.rawSession(f.contactA, otherId)).turns.length, 0);
    const other = await f.bridge.getState(); assert.equal(other.savedSession.sessionId, otherId);
    assert(!JSON.stringify(other).includes('只归原会话的合成候选。'));
    await f.bridge.selectSavedSession({ ...scope, sessionId: job.sessionId });
    assert.equal((await f.bridge.getState()).savedSession.turns[0].state, 'completed');
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
    console.log('A16 same-contact actual models=1, original turns=1, new turns=0, selection models=0');
  });
});

test('受控宿主hide和close只离开视图，重显只读取已完成，closing另有无正文回执接口', async () => {
  await withPublicFixture(async (f) => {
    const scope = await f.selectContact(f.contactA);
    const job = await f.start(scope);
    f.replies.notifyHelperLifecycle('hidden');
    f.replies.notifyHelperLifecycle('closed');
    assert.equal(job.request.signal.aborted, false, '隐藏或关闭小窗不能中止应用中的生成。');
    const receipts = f.replies.pendingGenerationReceipts();
    assert.equal(receipts.length, 1);
    assert.deepEqual(Object.keys(receipts[0]).sort(), ['connectionGeneration', 'contactId', 'inputVersionId',
      'requestKey', 'sessionId', 'state', 'turnId'].sort());
    assert.equal(receipts[0].sessionId, job.sessionId);
    await f.fixture.command('release'); await job.promise;
    assert(!(await f.bridge.getState()).result, '后台完成不能把结果直接发布到已离开的视图。');
    f.replies.notifyHelperLifecycle('focused');
    const state = await eventually(() => f.bridge.getState(),
      (value) => value.savedSession.turns[0]?.state === 'completed', '重显未从真实保存结果恢复。');
    assert.equal(state.savedSession.sessionId, job.sessionId);
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
    assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
    console.log('A16 host hide/close signal active, completed turns=1, reopen models=0, native=false');
  });
});

for (const mode of ['reply_to_message', 'initiate_conversation']) {
  test(`明确用户输入${mode}同样持有实际回执并在切换后唯一保存，恢复零模型`, async () => {
    await withPublicFixture(async (f) => {
      const scope = await f.selectContact(f.contactA);
      const job = await f.start(scope, mode);
      const receipt = f.replies.pendingGenerationReceipts()[0];
      const running = await f.rawSession(f.contactA, job.sessionId);
      assert.equal(receipt.sessionId, running.session_id);
      assert.equal(receipt.turnId, running.turns[0].turn_id);
      assert.equal(receipt.inputVersionId, running.turns[0].input_version_id);
      assert.equal(receipt.requestKey, running.turns[0].request_key);
      assert.equal(running.turns[0].input.content.type, mode);
      await f.selectContact(f.contactB);
      assert.equal(job.request.signal.aborted, false);
      await f.fixture.command('release'); await job.promise;
      assert(!(await f.bridge.getState()).result);
      assert(!JSON.stringify(await f.bridge.getState()).includes('只归原会话的合成候选。'));
      await f.selectContact(f.contactA);
      assert.equal((await f.bridge.getState()).savedSession.turns[0].state, 'completed');
      assert.equal((await f.fixture.command('counts')).actual_calls, 1);
      const prepare = f.requests.find((request) => request.path === job.request.path + '/prepare');
      assert.equal(prepare.bodyHash, job.request.bodyHash);
      console.log(`A16 ${mode} actual models=1, unique saved=1, recovery models=0`);
    });
  });
}

test('B09确认方向的候选领取实际回执，关闭后只保存原SID且重显零追加模型', async () => {
  await withPublicFixture(async (f) => {
    const scope = await f.selectContact(f.contactA);
    await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
    await f.bridge.updatePurpose({ ...scope, purpose: '想了解合成近况，尚未确定意愿。' });
    await f.fixture.plan({ explore: { understanding: '只确认本次合成意愿。', question: null } });
    await f.bridge.explore(scope);
    const exploration = (await f.bridge.getState()).exploration.result;
    assert(exploration);
    await f.fixture.plan({ count: 1, message_groups: [['只归原已确认会话。', '不增加其他安排。']] });
    await f.fixture.command('hold');
    const confirming = f.bridge.selectDirection({ ...scope, suggestionId: exploration.directions[0].suggestionId,
      inputVersion: exploration.inputVersion });
    try {
      await eventually(() => f.fixture.command('counts'), (counts) => counts.entered,
        '方向确认的候选未到达实际模型。');
      const running = await f.rawSession(f.contactA, exploration.sessionId);
      const receipts = f.replies.pendingGenerationReceipts();
      assert.equal(receipts.length, 1, '已确认候选须由唯一A作业持有实际准备回执。');
      assert.equal(receipts[0].sessionId, exploration.sessionId);
      assert.equal(receipts[0].turnId, running.turns[0].turn_id);
      assert.equal(receipts[0].inputVersionId, running.turns[0].input_version_id);
      assert.equal(receipts[0].requestKey, running.turns[0].request_key);
      f.replies.notifyHelperLifecycle('closed');
      await f.fixture.command('release'); await confirming;
      const saved = await f.rawSession(f.contactA, exploration.sessionId);
      assert.equal(saved.turns.length, 1); assert.equal(saved.turns[0].state, 'completed');
      assert.deepEqual(saved.turns[0].reply.candidates[0].messages.map((message) => message.text),
        ['只归原已确认会话。', '不增加其他安排。']);
      assert.equal((await f.bridge.getState()).result, null, '已关闭视图不能发布完成候选。');
      f.replies.notifyHelperLifecycle('focused');
      await eventually(() => f.bridge.getState(), (state) => state.savedSession?.turns[0]?.state === 'completed',
        '重显未读取原已确认候选。');
      assert.equal((await f.fixture.command('counts')).actual_calls, 2);
      assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
    } finally { await f.fixture.command('release'); await confirming; }
  });
});

async function preparedStrategyCandidate(f, action, mode) {
  const scope = await f.selectContact(f.contactA);
  await f.bridge.setMode({ ...scope, mode });
  if (mode === 'initiate_conversation') {
    await f.bridge.updatePurpose({ ...scope, purpose: '合成目的：了解近况，尚未决定意愿。' });
  } else {
    await f.bridge.loadMessages({ ...scope, older: false });
    const state = await f.bridge.getState();
    await f.bridge.selectMessage({ ...scope, messageId: state.messages.items[0].messageId });
  }
  await f.fixture.plan({ explore: { understanding: '只确认本次合成意愿。',
    question: action === 'answer' ? { text: '本次是否不增加其他承诺？', impact: 'commitment' } : null } });
  await f.bridge.explore(scope);
  let exploration = (await f.bridge.getState()).exploration.result;
  assert(exploration);
  if (action === 'answer') {
    await f.bridge.selectDirection({ ...scope, suggestionId: exploration.directions[0].suggestionId,
      inputVersion: exploration.inputVersion });
    exploration = (await f.bridge.getState()).exploration.result;
    assert(exploration?.confirmedIntent); assert(exploration.question);
    assert.equal(f.replies.pendingGenerationReceipts().length, 0, '仍有关键问题时不领取候选。');
    await f.fixture.plan({ explore: { understanding: '回答只补足本次承诺信息。', question: null } });
  }
  await f.fixture.plan({ count: 1, message_groups: [['本次合成已确认说法。', '不增加其他安排。']] });
  const gate = action === 'answer' ? f.gateResponse((request) => request.path.endsWith('/prepare-answer')) : null;
  if (!gate) await f.fixture.command('hold');
  const before = f.requests.length;
  const executing = action === 'answer'
    ? f.bridge.answerClarification({ ...scope, answer: '不增加其他承诺。',
      questionId: exploration.question.questionId, inputVersion: exploration.inputVersion })
    : f.bridge.selectDirection({ ...scope, suggestionId: exploration.directions[0].suggestionId,
      inputVersion: exploration.inputVersion });
  if (gate) {
    await gate.arrived.promise;
    await f.fixture.command('hold'); gate.release.resolve();
  }
  await eventually(() => f.fixture.command('counts'), (counts) => counts.entered, '已确认候选未进入实际模型。');
  return { scope, exploration, executing, before };
}

test('B09晚准备回执必须在原唯一作业退出等待中绑定并实际中断，不能提前排空', async () => {
  await withPublicFixture(async (f) => {
    const scope = await f.selectContact(f.contactA);
    await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
    await f.bridge.updatePurpose({ ...scope, purpose: '合成目的：只确认本次立场。' });
    await f.fixture.plan({ explore: { question: null } });
    await f.bridge.explore(scope);
    const explored = (await f.bridge.getState()).exploration.result;
    assert(explored);
    const gate = f.gateResponse((request) => request.path.endsWith('/prepare-confirm'));
    const confirming = f.bridge.selectDirection({ ...scope, suggestionId: explored.directions[0].suggestionId,
      inputVersion: explored.inputVersion });
    const prepared = await gate.arrived.promise;
    assert.equal(prepared.kind, 'prepared');
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
    const receipts = [];
    let closed = false;
    const closing = Promise.resolve(f.replies.beginGenerationClosing(async (receipt) => {
      receipts.push(receipt);
      const response = await f.backend.requestJson({ method: 'POST',
        path: `/api/contacts/${scope.contactId}/assistant-sessions/${receipt.sessionId}/interrupt`,
        body: { request_key: receipt.requestKey, input_version_id: receipt.inputVersionId } });
      assert.equal(response.data.state, 'failed');
      assert.equal(response.data.interruption_reason, 'app_quit');
    })).then(() => { closed = true; });
    try {
      await Promise.resolve(); await Promise.resolve();
      assert.equal(closed, false, '实际prepare在服务端领取但回执未到Main，退出不能提前完成。');
      gate.release.resolve();
      await confirming; await closing;
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].requestKey, prepared.generation.request_key);
      const saved = await f.rawSession(scope.contactId, explored.sessionId);
      assert.equal(saved.current_input_version_id, prepared.generation.input_version_id);
      assert.equal(saved.turns[0].state, 'failed');
      assert.equal(saved.turns[0].interruption_reason, 'app_quit');
      assert.equal(saved.turns[0].reply, null);
      assert.equal((await f.fixture.command('counts')).actual_calls, 1);
      assert.equal((await f.bridge.getState()).result, null);
    } finally { gate.release.resolve(); await confirming; await closing; }
  });
});

for (const mode of ['reply_to_message', 'initiate_conversation']) {
  for (const action of ['confirm', 'answer']) {
    for (const departure of ['close', 'switch']) {
      if (mode === 'initiate_conversation' && action === 'confirm' && departure === 'close') continue;
      test(`B09 ${mode} ${action}候选在${departure}后继续原SID，实际回执与持久重读一致`, async () => {
        await withPublicFixture(async (f) => {
          const { scope, exploration, executing, before } = await preparedStrategyCandidate(f, action, mode);
          try {
            const running = await f.rawSession(f.contactA, exploration.sessionId);
            const receipt = f.replies.pendingGenerationReceipts()[0];
            assert.equal(f.replies.pendingGenerationReceipts().length, 1);
            assert.equal(receipt.sessionId, exploration.sessionId);
            assert.equal(receipt.turnId, running.turns[0].turn_id);
            assert.equal(receipt.inputVersionId, running.turns[0].input_version_id);
            assert.equal(receipt.requestKey, running.turns[0].request_key);
            const execution = f.requests.slice(before).find((request) => request.path.endsWith('/' + action));
            const prepare = f.requests.slice(before).find((request) => request.path.endsWith('/prepare-' + action));
            assert.equal(prepare.bodyHash, execution.bodyHash, '准备与执行保持同一原输入和操作键。');
            assert.equal((await f.bridge.getState()).exploration.phase, 'ready');
            let newSession;
            if (departure === 'close') f.replies.notifyHelperLifecycle('closed');
            else {
              await f.bridge.newSavedSession(scope);
              newSession = (await f.bridge.getState()).savedSession.sessionId;
              assert.notEqual(newSession, exploration.sessionId);
            }
            assert.equal(execution.signal.aborted, false, '离开视图不能中止原已确认候选。');
            await f.fixture.command('release'); await executing;
            const saved = await f.rawSession(f.contactA, exploration.sessionId);
            assert.equal(saved.turns.length, 1); assert.equal(saved.turns[0].state, 'completed');
            assert.deepEqual(saved.turns[0].reply.candidates[0].messages.map((message) => message.text),
              ['本次合成已确认说法。', '不增加其他安排。']);
            assert.equal((await f.bridge.getState()).result, null, '原候选不能发布到离开的视图。');
            if (departure === 'close') {
              f.replies.notifyHelperLifecycle('focused');
              await eventually(() => f.bridge.getState(), (state) => state.savedSession?.turns[0]?.state === 'completed',
                '重显未读取原已确认候选。');
            } else {
              assert.equal((await f.bridge.getState()).savedSession.sessionId, newSession);
              assert.equal((await f.rawSession(f.contactA, newSession)).turns.length, 0);
              await f.bridge.selectSavedSession({ ...scope, sessionId: exploration.sessionId });
            }
            assert.equal((await f.bridge.getState()).savedSession.turns[0].state, 'completed');
            assert.equal((await f.fixture.command('counts')).actual_calls, action === 'answer' ? 3 : 2);
            assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
          } finally { await f.fixture.command('release'); await executing; }
        });
      });
    }
  }
}

test('prepare实际回执在途时离开A，晚到后仍用原key/body/SID生成且不发布B', async () => {
  await withPublicFixture(async (f) => {
    const scopeA = await f.selectContact(f.contactA);
    const sessionId = (await f.bridge.getState()).savedSession.sessionId;
    f.contacts.setDraft({ ...scopeA, text: '合成prepare在途原草稿。' });
    await f.fixture.plan({ text: '合成prepare晚到原会话结果。', count: 1 });
    const gate = f.gateResponse((request) => request.path.endsWith('/replies/prepare'));
    const promise = f.bridge.generate({ ...scopeA, newRequest: true });
    const actual = await gate.arrived.promise;
    assert.deepEqual(Object.keys(actual).sort(), ['session_id', 'turn_id', 'request_key', 'input_version_id', 'state'].sort());
    assert.equal((await f.fixture.command('counts')).actual_calls, 0, 'prepare只产生真实身份，无模型调用。');
    const prepare = f.requests.find((request) => request.path.endsWith('/replies/prepare'));
    await f.selectContact(f.contactB);
    assert.equal(prepare.signal.aborted, false);
    gate.release.resolve(); await promise;
    const long = f.requests.find((request) => request.path.endsWith('/replies'));
    assert.equal(long.path, `/api/contacts/${f.contactA}/assistant-sessions/${sessionId}/replies`);
    assert.equal(prepare.bodyHash, long.bodyHash);
    const saved = await f.rawSession(f.contactA, sessionId);
    assert.equal(saved.turns[0].turn_id, actual.turn_id);
    assert.equal(saved.turns[0].request_key, actual.request_key);
    assert.equal(saved.turns[0].input_version_id, actual.input_version_id);
    assert.equal(saved.turns[0].state, 'completed');
    assert(!JSON.stringify(await f.bridge.getState()).includes('合成prepare晚到原会话结果。'));
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
    console.log('A16 late prepare actual fields=5, prepare models=0, long models=1, wrong SID=0');
  });
});

test('当前B收到A来源删除通知仍取消后台A，实际PG不保存晚到候选或恢复正文', async () => {
  await withPublicFixture(async (f) => {
    const scopeA = await f.selectContact(f.contactA);
    const job = await f.start(scopeA, 'reply_to_message');
    await f.selectContact(f.contactB);
    const sources = await f.backend.requestJson({ method: 'GET', path: `/api/contacts/${f.contactA}/sources` });
    assert.equal(sources.data.sources.length, 1);
    await f.backend.requestJson({ method: 'DELETE',
      path: `/api/contacts/${f.contactA}/sources/${sources.data.sources[0].source_id}` });
    await f.replies.revalidateDeletedSource(f.contactA);
    assert.equal(job.request.signal.aborted, true, '来源通知必须找到后台原联系人作业。');
    await f.fixture.command('release'); await job.promise;
    const saved = await eventually(() => f.rawSession(f.contactA, job.sessionId),
      (value) => value.turns[0]?.state === 'redacted', '实际来源删除未清除原会话依赖。');
    assert.equal(saved.turns[0].reply, null); assert.equal(saved.turns[0].input, null);
    assert(!JSON.stringify(saved).includes('只归原会话的合成候选。'));
    assert(!JSON.stringify(await f.bridge.getState()).includes('只归原会话的合成候选。'));
    await f.selectContact(f.contactA);
    assert.equal((await f.bridge.getState()).savedSession.turns[0].state, 'redacted');
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
    console.log('A16 source invalidation background signal aborted, actual redacted=1, valid candidates=0');
  });
});

test('C已可靠完成后新CURRENT存在，旧历史200仍保留完成但不能发布为当前候选', async () => {
  await withPublicFixture(async (f) => {
    const scope = await f.selectContact(f.contactA);
    const gate = f.gateResponse((request) => request.path.endsWith('/replies'));
    const job = await f.start(scope);
    await f.fixture.command('release');
    const completed = await gate.arrived.promise;
    assert.equal(completed.state, 'completed');
    const discussion = await f.backend.requestJson({ method: 'POST',
      path: `/api/contacts/${f.contactA}/assistant-sessions/${job.sessionId}/inputs`, body: { content: {
        type: 'purpose_exploration', purpose_hint: '已保存完成后的合成新CURRENT。', correction: '',
        requirements: '', answer: '', confirmed_intent: '', skill_mode: 'disabled', skill_version_id: null,
      } } });
    const newInput = discussion.data.input_version_id;
    assert.notEqual(newInput, completed.input_version_id);
    gate.release.resolve(); await job.promise;
    const saved = await f.rawSession(f.contactA, job.sessionId);
    assert.equal(saved.turns[0].state, 'completed');
    assert.equal(saved.current_input_version_id, newInput);
    const visible = await f.bridge.getState();
    assert.equal(visible.result, null, '历史完成200不能发布为新CURRENT候选。');
    assert.equal(visible.savedSession.currentInputVersionId, newInput);
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
    console.log('A16 completed-wins preserved=1, new CURRENT retained, stale UI publish=0, models=1');
  });
});

test('同SID旧读取晚到不能覆盖已经完成的当前结果', async () => {
  await withPublicFixture(async (f) => {
    const scope = await f.selectContact(f.contactA);
    const job = await f.start(scope);
    const gate = f.gateResponse((request) => request.method === 'GET'
      && request.path === `/api/contacts/${f.contactA}/assistant-sessions/${job.sessionId}`);
    const reading = f.bridge.readSavedSession(scope);
    const old = await gate.arrived.promise;
    assert.equal(old.turns[0].state, 'running');
    await f.fixture.command('release'); await job.promise;
    const completed = await f.bridge.getState();
    assert.equal(completed.phase, 'ready'); assert.equal(completed.savedSession.phase, 'idle');
    gate.release.resolve(); await reading;
    const afterRead = await f.bridge.getState();
    assert.equal(afterRead.phase, 'ready'); assert.equal(afterRead.savedSession.phase, 'idle');
    assert.deepEqual(afterRead.savedSession.turns, []);
    assert.equal(afterRead.result.replyRequestId, completed.result.replyRequestId);
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
    console.log('A16 old GET running discarded, current completed preserved, models=1');
  });
});

test('生成完成恰逢目录刷新在途，放行目录后仍显示当前候选且不永久等待', async () => {
  await withPublicFixture(async (f) => {
    const scope = await f.selectContact(f.contactA);
    const job = await f.start(scope);
    const catalogGate = f.gateResponse((request) => request.method === 'GET'
      && request.path === `/api/contacts/${f.contactA}/assistant-sessions`);
    const listing = f.bridge.listSavedSessions(scope);
    const catalog = await catalogGate.arrived.promise;
    assert.equal(catalog.current_session_id, job.sessionId);
    assert.equal((await f.bridge.getState()).sessionCatalog.phase, 'loading');
    assert.equal(job.request.signal.aborted, false, '目录刷新保持当前会话的生成。');
    await f.fixture.command('release'); await job.promise;
    const saved = await f.rawSession(f.contactA, job.sessionId);
    assert.equal(saved.turns[0].state, 'completed');
    assert.equal(saved.turns[0].reply.candidates.length, 1);
    catalogGate.release.resolve(); await listing;
    const visible = await f.bridge.getState();
    assert.equal(visible.sessionCatalog.phase, 'ready');
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
    assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
    console.log('A16 catalog overlap actual completed=1, catalog released, models=1');
    assert.equal(visible.phase, 'ready', '目录刷新不能丢弃当前生成完成并留下永久等待。');
    assert.equal(visible.result.candidates[0].original.text, '只归原会话的合成候选。');
    assert.equal(visible.result.assistantSessionId, job.sessionId);
  });
});

test('离开后撤销原绑定仍由实际后端拒绝提交，读取原失败不会新增模型', async () => {
  await withPublicFixture(async (f) => {
    const scope = await f.selectContact(f.contactA);
    const job = await f.start(scope);
    await f.selectContact(f.contactB);
    await f.fixture.command('revoke', { contact_id: f.contactA });
    await f.fixture.command('release'); await job.promise;
    const saved = await eventually(() => f.rawSession(f.contactA, job.sessionId),
      (value) => value.turns[0]?.state === 'failed', '撤销绑定后仍保存了有效候选。');
    assert.equal(saved.turns[0].reply, null);
    const restoredScope = await f.selectContact(f.contactA);
    await f.bridge.selectSavedSession({ ...restoredScope, sessionId: job.sessionId });
    assert.equal((await f.bridge.getState()).savedSession.turns[0].reply, null);
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
    console.log('A16 revoked scope actual failed=1, valid candidate=0, recovery models=0');
  });
});

test('选回原SID删除会找到离开的原作业，晚到结果不能恢复实际删除的会话', async () => {
  await withPublicFixture(async (f) => {
    const scope = await f.selectContact(f.contactA);
    const job = await f.start(scope);
    await f.bridge.newSavedSession(scope);
    await f.bridge.selectSavedSession({ ...scope, sessionId: job.sessionId });
    await f.bridge.deleteSavedSession({ ...scope, sessionId: job.sessionId, confirmed: true });
    assert.equal(job.request.signal.aborted, true);
    await f.fixture.command('release'); await job.promise;
    await assert.rejects(f.rawSession(f.contactA, job.sessionId), (error) => error.status === 404 && error.code === 'not_found');
    assert.equal((await f.bridge.getState()).result, null);
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
    console.log('A16 session delete actual404, background signal aborted, models=1');
  });
});

test('实际连接更换取消旧作业并隔离UI，可靠保存仍从原SID读取且不新增模型', async () => {
  await withPublicFixture(async (f) => {
    const scope = await f.selectContact(f.contactA);
    const job = await f.start(scope);
    await f.selectContact(f.contactB);
    await f.changeConnection();
    assert.equal(job.request.signal.aborted, true);
    await f.fixture.command('release'); await job.promise;
    assert.equal((await f.bridge.getState()).result, null);
    const saved = await eventually(() => f.rawSession(f.contactA, job.sessionId),
      (value) => value.turns[0]?.state === 'completed', '原后端可靠保存结果未能读取。');
    assert.equal(saved.turns.length, 1);
    await f.selectContact(f.contactA);
    assert.equal((await f.bridge.getState()).savedSession.turns[0].state, 'completed');
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
    console.log('A16 connection changed, UI publish=0, original reliable complete=1, reconnect models=0; interrupt hook pending17');
  });
});

test('实际running回执可经公开新请求进入唯一14 replace prepare，后续同新body/key原长链', async () => {
  await withPublicFixture(async (f) => {
    const scope = await f.selectContact(f.contactA);
    const old = await f.start(scope);
    const originalReceipt = f.replies.pendingGenerationReceipts()[0];
    const gate = f.gateResponse((request) => request.path.endsWith('/replace/prepare'));
    await f.fixture.plan({ text: '合成替换后的唯一有效候选。', count: 1 });
    const replacement = f.bridge.generate({ ...scope, newRequest: true });
    const actual = await eventually(async () => gate.entered ? gate.arrived.promise : null,
      (value) => value !== null, '公开新请求未进入实际replace prepare。');
    assert.equal(actual.state, 'running'); assert.notEqual(actual.request_key, originalReceipt.requestKey);
    const saved = await f.rawSession(f.contactA, old.sessionId);
    assert.equal(saved.turns.find((turn) => turn.request_key === originalReceipt.requestKey).state, 'failed');
    assert.equal(saved.current_input_version_id, actual.input_version_id);
    assert.equal(old.request.signal.aborted, true, '明确替换取消旧作业；视图离开不使用这条路径。');
    gate.release.resolve(); await f.fixture.command('release');
    await old.promise; await replacement;
    const completed = await f.rawSession(f.contactA, old.sessionId);
    assert.equal(completed.turns.filter((turn) => turn.state === 'completed').length, 1);
    assert.equal(completed.turns.filter((turn) => turn.reply !== null).length, 1);
    const prepare = f.requests.find((request) => request.path.endsWith('/replace/prepare'));
    const long = f.requests.find((request) => request.path.endsWith('/replies') && request.requestKey === actual.request_key);
    assert.equal(prepare.runningKey, originalReceipt.requestKey);
    assert.equal(prepare.requestKey, long.requestKey); assert.equal(prepare.bodyHash, long.bodyHash);
    assert.equal((await f.fixture.command('counts')).actual_calls, 2);
    console.log('A16 replacement actual old failed=1, new completed=1, models=2, duplicated authority=0');
  });
});

test('返回原SID替换失败后可用新请求重试，已离开视图A的迟到收尾不能阻塞生成', async () => {
  await withPublicFixture(async (f) => {
    const scope = await f.selectContact(f.contactA);
    const old = await f.start(scope);
    const original = f.replies.pendingGenerationReceipts()[0];
    const oldFailure = f.gateResponse((request) => request.path.endsWith('/replies')
      && request.body?.idempotency_key === original.requestKey, true);
    const preparingB = f.gateResponse((request) => request.path.endsWith('/replace/prepare'));
    let replacementB, retry;
    try {
      await f.bridge.newSavedSession(scope);
      const otherSessionId = (await f.bridge.getState()).savedSession.sessionId;
      assert.notEqual(otherSessionId, old.sessionId);
      assert.equal(old.request.signal.aborted, false, '离开原SID不能取消原生成。');
      await f.bridge.selectSavedSession({ ...scope, sessionId: old.sessionId });
      assert.equal(old.request.signal.aborted, false, '返回原SID只恢复，不取消或自动生成。');
      assert.equal((await f.fixture.command('counts')).actual_calls, 1);
      f.contacts.setDraft({ ...scope, text: '合成返回原会话后的新草稿。' });
      await f.fixture.plan({ fault: 'failure' });
      replacementB = f.bridge.generate({ ...scope, newRequest: true });
      const actualB = await eventually(async () => preparingB.entered ? preparingB.arrived.promise : null,
        (value) => value !== null, '返回原SID后的新请求未进入实际替换prepare。');
      assert.deepEqual(Object.keys(actualB).sort(), ['session_id', 'turn_id', 'request_key', 'input_version_id', 'state'].sort());
      assert.equal(actualB.state, 'running');
      assert.equal(actualB.session_id, old.sessionId);
      const replaced = await f.rawSession(f.contactA, old.sessionId);
      assert.equal(replaced.turns.find((turn) => turn.request_key === original.requestKey).state, 'failed');
      assert.equal(replaced.current_input_version_id, actualB.input_version_id);
      assert.equal((await f.fixture.command('counts')).actual_calls, 1, '实际prepare不调用模型。');
      // 原A模型和传输仍由边界夹具控制；B使用实际模型失败，不手写失效行。
      await f.fixture.command('release');
      await eventually(() => oldFailure.entered, Boolean, '原A失败或取消异常未到达受控传输边界。');
      preparingB.release.resolve(); await replacementB;
      assert.equal((await f.bridge.getState()).phase, 'failed');
      const failed = await f.rawSession(f.contactA, old.sessionId);
      assert.equal(failed.turns.find((turn) => turn.request_key === actualB.request_key).state, 'failed');
      assert.equal(failed.turns.filter((turn) => turn.reply !== null).length, 0);
      assert(f.replies.pendingGenerationReceipts().some((receipt) => receipt.requestKey === original.requestKey),
        '原A传输异常仍在等待收尾，重试必须排除其已失效的实际回执。');
      await f.fixture.plan({ text: '合成返回原会话重试后的唯一候选。', count: 1 });
      const beforeRetry = f.requests.length;
      retry = f.bridge.generate({ ...scope, newRequest: true });
      await retry;
      const nextPrepare = f.requests.slice(beforeRetry).find((request) => request.path.endsWith('/prepare'));
      assert(nextPrepare, '显式重试必须获取新的实际回执。');
      console.log(`A16 returned replacement failure retry HTTP=${nextPrepare.status ?? nextPrepare.failure?.status}, old transport unfinished, models=${(await f.fixture.command('counts')).actual_calls}`);
      assert.equal(nextPrepare.status, 200, '替换失败后的新请求不能再次替换已经failed的原A。');
      assert.equal(nextPrepare.path, old.request.path + '/prepare');
      assert.notEqual(nextPrepare.requestKey, original.requestKey);
      assert.notEqual(nextPrepare.requestKey, actualB.request_key);
      assert.equal(old.request.signal.aborted, true, '明确替换须取消已离开视图的同归属A。');
      const completed = await f.rawSession(f.contactA, old.sessionId);
      const current = completed.turns.find((turn) => turn.request_key === nextPrepare.requestKey);
      assert.equal(completed.turns.length, 3);
      assert.equal(completed.turns.filter((turn) => turn.state === 'completed').length, 1);
      assert.equal(current.state, 'completed');
      assert.equal(completed.current_input_version_id, current.input_version_id);
      assert.equal(current.reply.candidates[0].text, '合成返回原会话重试后的唯一候选。');
      assert.equal((await f.bridge.getState()).phase, 'ready');
      assert.equal((await f.rawSession(f.contactA, otherSessionId)).turns.length, 0);
      assert.equal((await f.fixture.command('counts')).actual_calls, 3);
    } finally {
      preparingB.release.resolve(); oldFailure.release.resolve();
      await f.fixture.command('release');
      await Promise.all([old.promise, replacementB, retry].filter(Boolean));
    }
  });
});

test('连续两次公开替换选取实际运行B回执，已取消尚未收尾A不能被再次替换', async () => {
  await withPublicFixture(async (f) => {
    const scope = await f.selectContact(f.contactA);
    const old = await f.start(scope);
    const original = f.replies.pendingGenerationReceipts()[0];
    const oldFailure = f.gateResponse((request) => request.path.endsWith('/replies')
      && request.body?.idempotency_key === original.requestKey, true);
    const preparingB = f.gateResponse((request) => request.path.endsWith('/replace/prepare'));
    let preparingC, replacementB, replacementC;
    try {
      await f.fixture.plan({ text: '合成最新替换的唯一有效候选。', count: 1 });
      replacementB = f.bridge.generate({ ...scope, newRequest: true });
      const actualB = await preparingB.arrived.promise;
      assert.deepEqual(Object.keys(actualB).sort(), ['session_id', 'turn_id', 'request_key', 'input_version_id', 'state'].sort());
      assert.equal(actualB.state, 'running');
      assert.notEqual(actualB.request_key, original.requestKey);
      assert.equal((await oldFailure.arrived.promise).kind, 'cancelled');
      preparingB.release.resolve();
      const longB = await eventually(() => f.requests.find((request) => request.path.endsWith('/replies')
        && request.requestKey === actualB.request_key), Boolean, 'B实际长HTTP请求尚未开始。');
      const runningB = await f.rawSession(f.contactA, old.sessionId);
      assert.equal(runningB.turns.find((turn) => turn.request_key === actualB.request_key).state, 'running');
      assert.equal(runningB.turns.find((turn) => turn.request_key === original.requestKey).state, 'failed');
      const receipts = f.replies.pendingGenerationReceipts();
      assert(receipts.some((receipt) => receipt.requestKey === original.requestKey), 'A取消异常仍在传输边界等待收尾。');
      assert(receipts.some((receipt) => receipt.requestKey === actualB.request_key));
      assert.equal(longB.signal.aborted, false);
      const beforeC = f.requests.length;
      preparingC = f.gateResponse((request) => request.path.endsWith('/replace/prepare'));
      replacementC = f.bridge.generate({ ...scope, newRequest: true });
      await eventually(async () => preparingC.entered || (await f.bridge.getState()).phase === 'failed',
        Boolean, 'C实际替换HTTP未返回。');
      const prepareC = f.requests.slice(beforeC).find((request) => request.path.endsWith('/replace/prepare'));
      assert(prepareC);
      console.log(`A16 double replace C HTTP=${prepareC.status ?? prepareC.failure?.status}, A cancelled and unfinished, B actual running`);
      assert.equal(prepareC.runningKey, actualB.request_key, '第二次替换必须使用实际运行B的回执，而非已取消A。');
      const actualC = await preparingC.arrived.promise;
      assert.equal(actualC.state, 'running');
      assert.notEqual(actualC.request_key, actualB.request_key);
      assert.equal(actualC.session_id, old.sessionId);
      const savedC = await f.rawSession(f.contactA, old.sessionId);
      assert.equal(savedC.current_input_version_id, actualC.input_version_id);
      assert.equal(savedC.turns.find((turn) => turn.request_key === actualB.request_key).state, 'failed');
      assert.equal(longB.signal.aborted, true);
      preparingC.release.resolve(); oldFailure.release.resolve();
      await f.fixture.command('release');
      await Promise.all([old.promise, replacementB, replacementC]);
      const completed = await f.rawSession(f.contactA, old.sessionId);
      assert.equal(completed.turns.length, 3);
      assert.equal(completed.turns.filter((turn) => turn.state === 'failed').length, 2);
      assert.equal(completed.turns.filter((turn) => turn.state === 'completed').length, 1);
      assert.equal(completed.turns.filter((turn) => turn.reply !== null).length, 1);
      assert.equal(completed.current_input_version_id, actualC.input_version_id);
      const longC = f.requests.find((request) => request.path.endsWith('/replies')
        && request.requestKey === actualC.request_key);
      assert.equal(prepareC.requestKey, longC.requestKey); assert.equal(prepareC.bodyHash, longC.bodyHash);
      assert.equal((await f.bridge.getState()).phase, 'ready');
      assert.equal((await f.fixture.command('counts')).actual_calls, 2);
      console.log('A16 double replacement A failed=1, B failed=1, C unique completed=1, models=2, no guessed identity');
    } finally {
      oldFailure.release.resolve(); preparingB.release.resolve(); preparingC?.release.resolve();
      await f.fixture.command('release');
      await Promise.allSettled([old.promise, replacementB, replacementC].filter(Boolean));
    }
  });
});

test('无active绑定且默认SID尚未知的公开生成仍有明确失败状态，零模型且不留悬空作业', async () => {
  await withPublicFixture(async (f) => {
    await f.fixture.command('revoke', { contact_id: f.contactA });
    const scope = await f.selectContact(f.contactA);
    f.contacts.setDraft({ ...scope, text: '范围已撤销的合成草稿。' });
    await f.bridge.generate({ ...scope, newRequest: true });
    const state = await f.bridge.getState();
    assert.equal(state.phase, 'failed'); assert.equal(state.errorCode, 'rejected');
    assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
    assert.equal((await f.fixture.command('counts')).actual_calls, 0);
    console.log('A16 unknown SID rejected with visible state, models=0, dangling jobs=0');
  });
});

test('默认SID在途时离开视图，晚到后仍发往A且不改变B等待状态', async () => {
  await withPublicFixture(async (f) => {
    const scope = await f.selectContact(f.contactA);
    await f.bridge.deleteSavedSession({ ...scope, sessionId: (await f.bridge.getState()).savedSession.sessionId, confirmed: true });
    f.contacts.setDraft({ ...scope, text: '合成默认SID在途草稿。' });
    await f.fixture.plan({ text: '合成未知SID解析后原A结果。', count: 1 });
    const gate = f.gateResponse((request) => request.path.endsWith('/assistant-session/default'));
    const generating = f.bridge.generate({ ...scope, newRequest: true });
    const actual = await gate.arrived.promise;
    await f.selectContact(f.contactB);
    gate.release.resolve(); await generating;
    const visible = await f.bridge.getState();
    assert.equal(visible.contactId, f.contactB); assert.equal(visible.phase, 'idle');
    assert(!JSON.stringify(visible).includes('合成未知SID解析后原A结果。'));
    const saved = await f.rawSession(f.contactA, actual.session_id);
    assert.equal(saved.turns[0].state, 'completed');
    assert.equal((await f.fixture.command('counts')).actual_calls, 1);
    console.log('A16 late default actual SID bound to A, B waiting mutation=0, models=1');
  });
});

test('closing在prepare晚到时只交付实际无正文回执供17使用，并停止候选长请求', async () => {
  await withPublicFixture(async (f) => {
    const scope = await f.selectContact(f.contactA);
    f.contacts.setDraft({ ...scope, text: '仅用于合成closing回执测试。' });
    const gate = f.gateResponse((request) => request.path.endsWith('/replies/prepare'));
    const generating = f.bridge.generate({ ...scope, newRequest: true });
    const actual = await gate.arrived.promise;
    const delivered = [];
    f.replies.beginGenerationClosing((receipt) => delivered.push(receipt));
    assert.equal(delivered.length, 0, '在实际回执到达前不能猜turn/input。');
    gate.release.resolve(); await generating;
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].turnId, actual.turn_id);
    assert.equal(delivered[0].inputVersionId, actual.input_version_id);
    assert.equal(delivered[0].requestKey, actual.request_key);
    assert.deepEqual(Object.keys(delivered[0]).sort(), ['connectionGeneration', 'contactId', 'sessionId',
      'requestKey', 'turnId', 'inputVersionId', 'state'].sort());
    assert.equal(f.requests.filter((request) => request.path.endsWith('/replies')).length, 0);
    assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
    assert.equal((await f.fixture.command('counts')).actual_calls, 0);
    console.log('A16 closing seam delivered actual metadata once, long requests=0, models=0; interrupt writer belongs17');
  });
});

test('首轮模型失败后的同键重试已实际运行时，显式新请求仍可唯一替换且failed回执不冒充running', async () => {
  await withPublicFixture(async (f) => {
    const scope = await f.selectContact(f.contactA);
    f.contacts.setDraft({ ...scope, text: '合成失败后同键重试草稿。' });
    const firstPrepare = f.gateResponse((request) => request.path.endsWith('/replies/prepare'));
    await f.fixture.plan({ fault: 'failure' });
    const first = f.bridge.generate({ ...scope, newRequest: true });
    let retry, replacement, retryBody, cachedReplay, fresh, earlyRetry, earlyReplacement, earlyReplacementBody;
    let retryPrepare, replacementPrepare, completedPrepare, cachedResult, dispatchGate, originalRequestJson;
    try {
      const original = await firstPrepare.arrived.promise;
      assert.equal(original.state, 'running');
      firstPrepare.release.resolve(); await first;
      assert.equal((await f.bridge.getState()).phase, 'failed');
      assert.equal((await f.fixture.command('counts')).actual_calls, 1);
      const failed = await f.rawSession(f.contactA, original.session_id);
      assert.equal(failed.turns.length, 1); assert.equal(failed.turns[0].state, 'failed');
      assert.equal(failed.turns[0].reply, null);
      retryPrepare = f.gateResponse((request) => {
        if (!request.path.endsWith('/replies/prepare') || request.body?.idempotency_key !== original.request_key) return false;
        retryBody = request.body; return true;
      });
      await f.fixture.plan({ text: '合成旧重试候选不可复活。', count: 1 });
      await f.fixture.command('hold');
      retry = f.bridge.generate({ ...scope, newRequest: false });
      const retried = await retryPrepare.arrived.promise;
      assert.deepEqual(retried, { ...original, state: 'failed' }, '同键prepare必须保留实际failed快照和原身份。');
      assert.equal((await f.fixture.command('counts')).actual_calls, 1, 'failed prepare不能启动模型。');
      const beforeUnknown = f.requests.length;
      await f.bridge.generate({ ...scope, newRequest: true });
      assert.equal(f.requests.length, beforeUnknown, 'prepare回执仍在传输途中时，未知身份必须保持关闭。');
      retryPrepare.release.resolve();
      await eventually(() => f.fixture.command('counts'),
        (counts) => counts.entered && counts.actual_calls === 2, '同键重试未实际进入第二次模型调用。');
      const retryLong = f.requests.find((request) => request.path.endsWith('/replies')
        && request.requestKey === original.request_key && request !== f.requests.find((item) => item.path.endsWith('/replies')));
      assert(retryLong, '同键重试须沿原候选长请求。');
      assert.equal(f.replies.pendingGenerationReceipts()[0].state, 'failed', '本地不能伪造服务端running状态。');
      const canonical = await f.backend.requestJson({ method: 'POST', path: retryLong.path + '/prepare', body: retryBody });
      assert.deepEqual(canonical.data, original, '真实在途重试的canonical状态由后端原prepare核验。');
      const stillFailed = await f.rawSession(f.contactA, original.session_id);
      assert.equal(stillFailed.turns[0].state, 'failed', '实际重试租约不重写历史failed turn。');
      await f.fixture.plan({ text: '合成同键重试替换后的唯一候选。', count: 1 });
      const beforeNew = f.requests.length;
      replacementPrepare = f.gateResponse((request) => request.path.endsWith('/replace/prepare'));
      let replacementFinished = false;
      replacement = f.bridge.generate({ ...scope, newRequest: true });
      replacement.finally(() => { replacementFinished = true; });
      await eventually(async () => replacementPrepare.entered || replacementFinished, Boolean, '显式新请求未返回实际替换状态。');
      const actualPrepare = f.requests.slice(beforeNew).find((request) => request.path.endsWith('/prepare'));
      console.log(`A16 failed retry replacement prepare=${actualPrepare?.status ?? actualPrepare?.failure?.status ?? 'none'}, new requests=${f.requests.length - beforeNew}, models=${(await f.fixture.command('counts')).actual_calls}`);
      assert(actualPrepare, '实际同键retry长请求在途时，显式newRequest不能被waiting门禁静默丢弃。');
      assert.equal(actualPrepare.path, retryLong.path.replace(/\/replies$/, '/replace/prepare'));
      assert.equal(actualPrepare.runningKey, original.request_key);
      assert.equal(actualPrepare.status, 200);
      const updated = await replacementPrepare.arrived.promise;
      assert.equal(updated.state, 'running'); assert.notEqual(updated.request_key, original.request_key);
      assert.equal(updated.session_id, original.session_id);
      assert.equal(retryLong.signal.aborted, true, '明确替换精确取消原同键retry作业。');
      const replaced = await f.rawSession(f.contactA, original.session_id);
      assert.equal(replaced.current_input_version_id, updated.input_version_id);
      assert.equal(replaced.turns.find((turn) => turn.request_key === original.request_key).reply, null);
      await f.fixture.command('release'); await retry;
      replacementPrepare.release.resolve(); await replacement;
      const saved = await f.rawSession(f.contactA, original.session_id);
      assert.equal(saved.turns.length, 2);
      assert.equal(saved.turns.filter((turn) => turn.state === 'failed').length, 1);
      assert.equal(saved.turns.filter((turn) => turn.state === 'completed').length, 1);
      assert.equal(saved.turns.filter((turn) => turn.reply !== null).length, 1);
      assert.equal(saved.current_input_version_id, updated.input_version_id);
      assert.equal(saved.turns.find((turn) => turn.state === 'completed').reply.candidates[0].text,
        '合成同键重试替换后的唯一候选。');
      const visible = await f.bridge.getState();
      assert.equal(visible.phase, 'ready'); assert.equal(visible.result.inputVersionId, updated.input_version_id);
      assert(!JSON.stringify(visible).includes('合成旧重试候选不可复活。'));
      const newLong = f.requests.find((request) => request.path.endsWith('/replies') && request.requestKey === updated.request_key);
      assert.equal(actualPrepare.bodyHash, newLong.bodyHash);
      assert.equal((await f.fixture.command('counts')).actual_calls, 3);
      console.log('A16 failed retry actual models=3, original turn failed unchanged, new unique completed=1, CURRENT=new, guessed identity=0');

      completedPrepare = f.gateResponse((request) => request.path.endsWith('/replies/prepare')
        && request.body?.idempotency_key === updated.request_key);
      cachedResult = f.gateResponse((request) => request.path.endsWith('/replies')
        && request.body?.idempotency_key === updated.request_key);
      cachedReplay = f.bridge.generate({ ...scope, newRequest: false });
      assert.deepEqual(await completedPrepare.arrived.promise, { ...updated, state: 'completed' });
      completedPrepare.release.resolve();
      await cachedResult.arrived.promise;
      assert.equal(f.replies.pendingGenerationReceipts()[0].state, 'completed');
      assert.equal((await f.fixture.command('counts')).actual_calls, 3, '同键completed重放不新增模型。');
      await f.fixture.plan({ text: '合成completed重放后的新CURRENT候选。', count: 1 });
      const beforeFresh = f.requests.length;
      fresh = f.bridge.generate({ ...scope, newRequest: true }); await fresh;
      const freshPrepare = f.requests.slice(beforeFresh).find((request) => request.path.endsWith('/prepare'));
      console.log(`A16 completed replay fresh prepare=${freshPrepare?.status ?? freshPrepare?.failure?.status ?? 'none'}, models=${(await f.fixture.command('counts')).actual_calls}`);
      assert(freshPrepare, '已知completed重放在途仍允许显式新请求沿普通prepare推进。');
      assert.equal(freshPrepare.path, retryLong.path + '/prepare', 'completed回执不得冒充可替换的运行租约。');
      assert.equal(freshPrepare.status, 200); assert.notEqual(freshPrepare.requestKey, updated.request_key);
      cachedResult.release.resolve(); await cachedReplay;
      const afterReplay = await f.rawSession(f.contactA, original.session_id);
      const latest = afterReplay.turns.find((turn) => turn.request_key === freshPrepare.requestKey);
      assert.equal(afterReplay.turns.length, 3);
      assert.equal(afterReplay.turns.find((turn) => turn.request_key === updated.request_key).state, 'completed');
      assert.equal(afterReplay.current_input_version_id, latest.input_version_id);
      assert.equal((await f.bridge.getState()).result.inputVersionId, latest.input_version_id);
      assert.equal((await f.bridge.getState()).result.candidates[0].original.text, '合成completed重放后的新CURRENT候选。');
      assert.equal((await f.fixture.command('counts')).actual_calls, 4);
      console.log('A16 completed replay models=0, explicit fresh models=1, previous completion preserved, CURRENT never rewound');

      const beforeFailure = f.requests.length;
      await f.fixture.plan({ fault: 'failure' });
      await f.bridge.generate({ ...scope, newRequest: true });
      assert.equal((await f.bridge.getState()).phase, 'failed');
      const earlyFailedPrepare = f.requests.slice(beforeFailure).find((request) => request.path.endsWith('/replies/prepare'));
      const beforeEarly = await f.rawSession(f.contactA, original.session_id);
      assert.equal(beforeEarly.turns.find((turn) => turn.request_key === earlyFailedPrepare.requestKey).state, 'failed');
      dispatchGate = { arrived: deferred(), release: deferred() };
      originalRequestJson = f.backend.requestJson;
      // 只在传输边界延迟实际发送；后端仍按原租约验证，不预填DB或改写回执。
      f.backend.requestJson = async (request) => {
        if (request.path.endsWith('/replace/prepare') && request.body?.running_request_key === earlyFailedPrepare.requestKey) {
          earlyReplacementBody = request.body;
        }
        if (request.path.endsWith('/replies') && request.body?.idempotency_key === earlyFailedPrepare.requestKey) {
          dispatchGate.arrived.resolve(); await dispatchGate.release.promise;
        }
        return originalRequestJson(request);
      };
      earlyRetry = f.bridge.generate({ ...scope, newRequest: false });
      await dispatchGate.arrived.promise;
      assert.equal(f.replies.pendingGenerationReceipts()[0].state, 'failed');
      const beforeEarlyReplace = f.requests.length;
      earlyReplacement = f.bridge.generate({ ...scope, newRequest: true }); await earlyReplacement;
      const rejected = f.requests.slice(beforeEarlyReplace).find((request) => request.path.endsWith('/replace/prepare'));
      assert(rejected); assert.equal(rejected.runningKey, earlyFailedPrepare.requestKey);
      assert.equal(rejected.failure.status, 409); assert.equal(rejected.failure.code, 'assistant_session_rejected');
      // JsonClient保留既有reason白名单；用相同实际正文公开重读后端稳定拒绝，不扩大UI字段。
      assert.deepEqual(await f.fixture.request(rejected.path, earlyReplacementBody), { status: 409,
        data: { error: 'assistant_session_rejected', reason: 'generation_not_running' } });
      assert.deepEqual(await f.rawSession(f.contactA, original.session_id), beforeEarly,
        '尚未领取重试租约时，canonical替换必须关闭且不能追加输入或倒退CURRENT。');
      dispatchGate.release.resolve(); await earlyRetry;
      f.backend.requestJson = originalRequestJson; originalRequestJson = undefined;
      assert.equal((await f.fixture.command('counts')).actual_calls, 5, '过早替换与尚未发送的旧重试均不能进入额外模型。');
      console.log('A16 early retry dispatch canonical replace HTTP409 generation_not_running, session unchanged, extra models=0');
    } finally {
      firstPrepare.release.resolve(); retryPrepare?.release.resolve(); replacementPrepare?.release.resolve();
      completedPrepare?.release.resolve(); cachedResult?.release.resolve();
      dispatchGate?.release.resolve();
      if (originalRequestJson) f.backend.requestJson = originalRequestJson;
      await f.fixture.command('release');
      await Promise.allSettled([first, retry, replacement, cachedReplay, fresh, earlyRetry, earlyReplacement].filter(Boolean));
    }
  });
});
