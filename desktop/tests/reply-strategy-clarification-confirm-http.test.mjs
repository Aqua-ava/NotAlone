import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';

// 执行目录提供正式生产装配；同目录测试代理只控制回环传输，宿主使用真实BackendHost。
const proxySource = fileURLToPath(new URL('./rewrite-http-proxy.ts', import.meta.url));
const bundle = await build({ stdin: { contents: `
  export { withRewriteFixture } from './tests/rewrite-backend-fixture';
  export { withControllerEnvironment } from './tests/headless/backend-fixture';
  export { RewriteHttpProxy } from ${JSON.stringify(proxySource)};
  export { BackendHost } from './src/main/backend/host';
  export { ContactSession } from './src/main/contacts/session';
  export { readContactDirectory } from './src/main/contacts/directory';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { createReplyBridge } from './src/preload/reply';
  export { JsonClient } from './src/main/backend/json-client';
  export { readConnection } from './src/main/backend/connection';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const ports = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

async function withDialogueHost(use, manySources = false) {
  let cleaned = false;
  await ports.withRewriteFixture('notalone-clarification-confirm-http-', async (fixture) => {
    const proxy = await ports.RewriteHttpProxy.attach(fixture.infoPath);
    try {
      await ports.withControllerEnvironment(fixture, async (userData) => {
        const connection = await ports.readConnection(fixture.infoPath); assert(connection);
        const client = new ports.JsonClient(connection), backend = new ports.BackendHost(userData);
        await backend.connect(); assert.equal(backend.getState().phase, 'connected');
        const contacts = new ports.ContactSession(() => ports.readContactDirectory(backend));
        const handlers = new Map();
        ports.installReplyBridge({ handle: (channel, handler) => handlers.set(channel, handler), publish: () => {} }, backend, contacts);
        const bridge = ports.createReplyBridge({ invoke: (channel, ...args) => Promise.resolve().then(() => handlers.get(channel)(...args)),
          on: () => {}, removeListener: () => {} });
        const requests = [], original = backend.requestJson.bind(backend);
        backend.requestJson = async (request) => {
          if (request.method !== 'POST' || !request.path.includes('/explorations')) return original(request);
          const recorded = { path: request.path, body: structuredClone(request.body) }; requests.push(recorded);
          try { const response = await original(request); recorded.response = structuredClone(response.data); return response; }
          catch (error) { recorded.failure = { kind: error.kind, status: error.status, code: error.code, reason: error.reason }; throw error; }
        };
        try {
          const material = manySources ? await fixture.command('strategy_many_sources') : null;
          contacts.setConnection(backend.getConnectionGeneration()); await contacts.refreshContacts();
          contacts.selectContact({ contactId: fixture.data.contact_ids[0], scopeRevision: contacts.getState().scopeRevision });
          const scope = { contactId: fixture.data.contact_ids[0], scopeRevision: contacts.getState().scopeRevision };
          await bridge.readSavedSession(scope); await bridge.setMode({ ...scope, mode: 'reply_to_message' });
          await bridge.loadMessages({ ...scope, older: false });
          await bridge.selectMessage({ ...scope, messageId: (await bridge.getState()).messages.items[0].messageId });
          await bridge.updateSkill({ ...scope, skill: { mode: 'disabled', versionId: null } });
          await use({ bridge, scope, proxy, requests, fixture, material,
            request: async (endpoint) => (await client.perform({ method: 'GET', path: endpoint })).data });
        } finally { client.cancelPending(); assert.equal(await backend.stop(), true); }
      });
    } finally { await proxy.close(); }
  }, () => { cleaned = true; });
  assert.equal(cleaned, true);
}

test('B05原21来源澄清回答和确认通过真实BackendHost与代理保留探索与确认结果', async () => {
  const target = process.env.NOTALONE_B_CLARIFICATION_CONFIRM_CAPTURE;
  await withDialogueHost(async ({ bridge, scope, proxy, requests, fixture, material, request }) => {
    assert.equal(material.source_ids.length, 21);
    await fixture.plan({ explore: { understanding: '合成目的仍需由用户确认。', cite_all: true,
      question: { text: '这次是否愿意作出新的安排承诺？', impact: 'commitment' } } });
    await bridge.explore(scope);
    assert.equal((await bridge.getState()).exploration.result.understanding, '合成目的仍需由用户确认。');
    assert.equal(requests[0].response.evidence.find((item) => item.evidence_id === material.memory_id).source_ids.length, 21);
    await bridge.updateCorrection({ ...scope, correction: '这次只是了解近况，没有安排承诺。' });
    await fixture.plan({ explore: { understanding: '纠正只更新理解。',
      question: { text: '本次是否只了解近况？', impact: 'ambiguity' } } });
    await bridge.explore(scope);
    const corrected = (await bridge.getState()).exploration.result;
    assert.equal(corrected.understanding, '纠正只更新理解。'); assert(corrected.question);
    await bridge.beginClarificationEdit({ ...scope, questionId: corrected.question.questionId, inputVersion: corrected.inputVersion });
    await fixture.plan({ explore: { understanding: '回答后的目的仍未确认。' } });
    await bridge.answerClarification({ ...scope, questionId: corrected.question.questionId,
      inputVersion: corrected.inputVersion, answer: '只了解近况。' });
    const answered = await bridge.getState();
    assert.equal(answered.exploration.result.understanding, '回答后的目的仍未确认。');
    assert.equal(answered.exploration.result.confirmedIntent, null); assert.equal(answered.result, null);
    assert.equal((await fixture.command('observations')).payloads.length, 3);
    const chosen = answered.exploration.result.directions.find((item) => item.title === '愿意等待'); assert(chosen);
    await fixture.plan({ count: 1, prefix: '本次已确认合成意愿' });
    const before = requests.length, started = performance.now();
    await bridge.selectDirection({ ...scope, suggestionId: chosen.suggestionId, inputVersion: answered.exploration.result.inputVersion });
    assert.equal((await bridge.getState()).result, null);
    assert.equal((await fixture.command('observations')).payloads.length, 3);
    await bridge.generate({ ...scope, newRequest: true });
    const completedMs = performance.now() - started, state = await bridge.getState();
    const observations = await fixture.command('observations');
    const saved = await request(`/api/contacts/${scope.contactId}/assistant-sessions/${answered.exploration.result.sessionId}`);
    const capture = { data_kind: 'synthetic', quality_verified: false, native_executed: false, runtime_provider: 'BackendHost',
      proxy_source: proxySource, before_confirm: answered, after_confirm: state, actual_requests: requests,
      actual_inputs: observations.payloads, actual_calls: observations.payloads.length, saved,
      proxy_results: structuredClone(proxy.explorationResults), proxy_requests: structuredClone(proxy.explorationRequests),
      confirm_completed_ms: completedMs, control_contract_completed: false };
    if (target) await writeFile(target, JSON.stringify(capture, null, 2) + '\n');
    assert.equal(requests.slice(before).filter((item) => item.path.endsWith('/prepare-confirm')).length, 1);
    assert.equal(requests.slice(before).filter((item) => item.path.endsWith('/confirm')).length, 2);
    assert.equal(requests.slice(before)[1].response.kind, 'prepared');
    assert.equal(state.phase, 'ready'); assert.equal(state.result.candidates[0].original.text, '本次已确认合成意愿（说法1）。');
    assert.equal(observations.payloads.length, 4); assert.equal(saved.turns.length, 1);
    assert.equal(saved.current_input_version_id, state.result.inputVersionId);
    assert.equal(saved.turns[0].reply.reply_request_id, state.result.replyRequestId);
    assert.equal(observations.payloads[3].understanding_correction, '这次只是了解近况，没有安排承诺。');
    assert.equal(observations.payloads[3].clarification_answer, '只了解近况。');
    assert(completedMs < 5000, '真实确认完整返回应在原页面五秒观察门禁内');
    assert.equal(proxy.explorationResults.length, 5, '同一真实代理记录三次探索、一次确认与一次生成响应；准备回执不计入');
    assert.deepEqual(proxy.explorationResults.map((item) => item.status), [200, 200, 200, 200, 200]);
    capture.control_contract_completed = true;
    if (target) await writeFile(target, JSON.stringify(capture, null, 2) + '\n');
  }, true);
});

for (const delivery of ['drop', 'hold']) {
  test(`未确认回答的真实探索结果保留${delivery}门禁与同命令零额外模型重放`, async () => {
    await withDialogueHost(async ({ bridge, scope, proxy, requests, fixture }) => {
      await fixture.plan({ explore: { question: { text: '是否只了解近况？', impact: 'ambiguity' } } });
      await bridge.explore(scope);
      const current = (await bridge.getState()).exploration.result;
      await bridge.beginClarificationEdit({ ...scope, questionId: current.question.questionId, inputVersion: current.inputVersion });
      await fixture.plan({ explore: { understanding: '仅补充信息，尚未确认方向。' } });
      proxy.nextExploration = delivery;
      let settled = false;
      const answer = bridge.answerClarification({ ...scope, questionId: current.question.questionId,
        inputVersion: current.inputVersion, answer: '只了解近况。' }).then(() => { settled = true; });
      if (delivery === 'hold') {
        const deadline = performance.now() + 5000;
        while (!proxy.heldCount && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(proxy.heldCount, 1); assert.equal(settled, false);
        assert.equal(proxy.explorationResults.length, 2); proxy.release();
      }
      await answer;
      assert.equal(proxy.nextExploration, 'normal');
      assert.equal((await fixture.command('observations')).payloads.length, 2);
      assert.equal(proxy.explorationResults.length, 2);
      if (delivery === 'drop') {
        const failed = await bridge.getState(); assert.equal(failed.exploration.phase, 'failed');
        assert.equal(failed.exploration.canRetry, true);
      }
      const frozen = requests.at(-1); assert(frozen.path.endsWith('/answer'));
      await bridge.retryExploration(scope);
      assert.deepEqual(requests.at(-1).body, frozen.body); assert.equal(requests.at(-1).path, frozen.path);
      assert.equal((await fixture.command('observations')).payloads.length, 2);
      assert.equal(proxy.explorationResults.length, 3);
      assert.equal((await bridge.getState()).exploration.phase, 'ready');
      assert.equal((await bridge.getState()).exploration.result.confirmedIntent, null);
      assert.equal((await bridge.getState()).result, null);
      assert.deepEqual(proxy.explorationResults[2], proxy.explorationResults[1]);
    });
  });
}
