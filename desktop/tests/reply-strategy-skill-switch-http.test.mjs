import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

// 原Skill页面序列的真实宿主控制；只替换模型，保留正式桥、HTTP与隔离PG。
const bundle = await build({ stdin: { contents: `
  export { withRewriteFixture } from './tests/rewrite-backend-fixture';
  export { withControllerEnvironment } from './tests/headless/backend-fixture';
  export { RewriteHttpProxy } from './tests/rewrite-http-proxy';
  export { BackendHost } from './src/main/backend/host';
  export { ContactSession } from './src/main/contacts/session';
  export { readContactDirectory } from './src/main/contacts/directory';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { createReplyBridge } from './src/preload/reply';
  export { interruptAssistantGeneration, recoverAssistantGenerationReceipt } from './src/main/reply/assistant-generation-interruption';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const ports = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

for (const scene of ['reply_to_message', 'initiate_conversation']) {
  test(`${scene}自动探索隔离旧隐藏设置，显式生成保留版本固定与撤销门`, async () => {
    const captureDirectory = process.env.NOTALONE_B_SKILL_SWITCH_CAPTURE;
    let cleaned = false;
    await ports.withRewriteFixture('notalone-skill-switch-http-', async (fixture) => {
      const proxy = await ports.RewriteHttpProxy.attach(fixture.infoPath);
      try { await ports.withControllerEnvironment(fixture, async (userData) => {
        const backend = new ports.BackendHost(userData); await backend.connect();
        assert.equal(backend.getState().phase, 'connected');
        const contacts = new ports.ContactSession(() => ports.readContactDirectory(backend)), handlers = new Map();
        const replies = ports.installReplyBridge({ handle: (channel, handler) => handlers.set(channel, handler), publish: () => {} }, backend, contacts);
        const bridge = ports.createReplyBridge({ invoke: (channel, ...args) => Promise.resolve().then(() => handlers.get(channel)(...args)),
          on: () => {}, removeListener: () => {} });
        const requests = [], original = backend.requestJson.bind(backend);
        backend.requestJson = async (request) => {
          const recorded = { method: request.method, path: request.path, started_ms: performance.now(),
            ...(request.body === undefined ? {} : { body: structuredClone(request.body) }) }; requests.push(recorded);
          try {
            const response = await original(request);
            recorded.finished_ms = performance.now(); recorded.duration_ms = recorded.finished_ms - recorded.started_ms;
            if (request.method === 'POST') recorded.response = structuredClone(response.data);
            return response;
          } catch (error) {
            recorded.finished_ms = performance.now(); recorded.duration_ms = recorded.finished_ms - recorded.started_ms;
            recorded.failure = { kind: error.kind, status: error.status, code: error.code, reason: error.reason }; throw error;
          }
        };
        let businessFailure;
        try {
          const [first, second, otherContact, otherOwner] = (await fixture.command('strategy_skills')).skills;
          contacts.setConnection(backend.getConnectionGeneration()); await contacts.refreshContacts();
          contacts.selectContact({ contactId: fixture.data.contact_ids[0], scopeRevision: contacts.getState().scopeRevision });
          const scope = { contactId: fixture.data.contact_ids[0], scopeRevision: contacts.getState().scopeRevision };
          await bridge.readSavedSession(scope); await bridge.setMode({ ...scope, mode: scene });
          if (scene === 'reply_to_message') {
            await bridge.loadMessages({ ...scope, older: false });
            await bridge.selectMessage({ ...scope, messageId: (await bridge.getState()).messages.items[0].messageId });
            await bridge.updateDirection({ ...scope, direction: '本次愿意等待，不增加未来约定。' });
          } else await bridge.updatePurpose({ ...scope, purpose: '想了解近况，尚未决定本次意愿。' });
          const explore = async (skill) => {
            await fixture.plan({ select_skill: skill.version_id });
            await fixture.plan({ explore: {} }); await bridge.explore(scope);
            const state = await bridge.getState();
            assert(state.exploration.result, JSON.stringify({ exploration: state.exploration,
              proxyResults: proxy.explorationResults }));
            assert.equal(state.exploration.result.usedSkill.versionId, skill.version_id);
            assert.deepEqual(state.skillChoice, { mode: 'auto', versionId: null });
            assert.equal(state.scene, '');
            return state.exploration.result;
          };
          const generate = async (prefix, skill) => {
            await bridge.updateSkill({ ...scope, skill: skill
              ? { mode: 'user', versionId: skill.version_id } : { mode: 'disabled', versionId: null } });
            if (skill) await fixture.plan({ read_skill: skill.name });
            await fixture.plan({ count: 1, prefix }); await bridge.generate({ ...scope, newRequest: true });
            const state = await bridge.getState();
            assert.equal(state.result?.candidates[0].original.text, `${prefix}（说法1）。`);
            assert.equal(state.result.usedSkill?.versionId ?? null, skill?.version_id ?? null);
            return state;
          };
          await generate('固定第一实际版本', first);
          await generate('本次明确禁用方法');
          const started = performance.now();
          const secondState = await generate('更换后只用第二实际版本', second);
          assert(performance.now() - started < 5000);
          let observations = await fixture.command('observations');
          assert.equal(observations.payloads.length, 5);
          assert.equal(observations.skill_reads.at(-1).length, 1);
          assert(observations.skill_reads.at(-1)[0].includes(second.marker));
          const saved = await fixture.request(`/api/contacts/${scope.contactId}/assistant-sessions/${secondState.result.assistantSessionId}`);
          assert.equal(saved.status, 200);
          assert.equal(saved.data.current_input_version_id, secondState.result.inputVersionId);

          // ADR-074 的自动探索不继承旧界面隐藏的手动方法和场景。
          await bridge.updateSkill({ ...scope, skill: { mode: 'user', versionId: first.version_id } });
          await bridge.updateScene({ ...scope, scene: '旧界面隐藏的合成场景' });
          const secondExploration = await explore(second);
          assert.equal(proxy.explorationRequests.at(-1).skill_version_id ?? null, null);
          assert.equal((await fixture.request(`/api/skills/${second.skill_id}/disable`, {})).status, 200);
          await bridge.updateSkill({ ...scope, skill: { mode: 'disabled', versionId: null } });
          await explore(first);
          observations = await fixture.command('observations');
          assert.equal(observations.payloads.length, 9);
          const catalog = observations.payloads.filter(item => item.input_mode === 'exploration_skill_selection').at(-1).skills;
          assert.deepEqual(catalog.map(item => item.version_id), [first.version_id]);
          const rejected = await fixture.request(`/api/contacts/${scope.contactId}/assistant-sessions/${secondExploration.sessionId}/explorations/${secondExploration.taskId}/confirm`, {
            input_version_id: secondExploration.inputVersion, suggestion_id: secondExploration.directions[0].suggestionId });
          assert.equal(rejected.status, 409);
          // 旧显式入口对不可用版本关闭目录，通用生成仍可继续；实际读取不能越过权限边界。
          if (scene === 'reply_to_message') await bridge.updateDirection({ ...scope, direction: '本人新写的本次意愿：只说明今天可以等待。' });
          else await bridge.updatePurpose({ ...scope, purpose: '本人新写的本次目的：只了解今天近况。' });
          let expectedCalls = 9;
          for (const invalid of [second, otherContact, otherOwner]) {
            await bridge.updateSkill({ ...scope, skill: { mode: 'user', versionId: invalid.version_id } });
            await fixture.plan({ read_skill: invalid.name });
            await fixture.plan({ count: 1, prefix: '不可用方法只走通用表达' });
            await bridge.generate({ ...scope, newRequest: true });
            const current = await bridge.getState();
            assert.equal(current.phase, 'ready');
            assert.equal(current.result.usedSkill ?? null, null);
            assert.equal(current.result.candidates[0].original.text, '不可用方法只走通用表达（说法1）。');
            observations = await fixture.command('observations');
            assert.equal(observations.payloads.length, expectedCalls += 2);
            assert.equal(observations.payloads.at(-1).skill_selection.version_id, invalid.version_id);
            const reads = observations.skill_reads.at(-1);
            assert.equal(reads.length, 1);
            for (const skill of [first, second, otherContact, otherOwner]) assert(!reads[0].includes(skill.marker));
          }
          const capture = { scene, data_kind: 'synthetic', quality_verified: false, native_executed: false,
            first, second, stale_confirm: rejected, second_exploration: secondExploration,
            actual_requests: requests, proxy_requests: proxy.explorationRequests, proxy_results: proxy.explorationResults,
            actual_model_observations: observations, saved, control_completed: true };
          if (captureDirectory) await writeFile(`${captureDirectory}-${scene}.json`, JSON.stringify(capture, null, 2) + '\n');
        } catch (error) { businessFailure = error; throw error; } finally {
          const stopped = await backend.stop(() => replies.beginGenerationClosing(
            (receipt) => ports.interruptAssistantGeneration(backend, receipt),
            (preparation) => ports.recoverAssistantGenerationReceipt(backend, preparation)));
          if (!stopped) {
            const cleanupFailure = new Error('本轮后端收尾未确认。');
            if (businessFailure) throw new AggregateError([businessFailure, cleanupFailure], '业务断言与收尾均失败。');
            throw cleanupFailure;
          }
        }
      }); } finally { await proxy.close(); }
    }, () => { cleaned = true; });
    assert.equal(cleaned, true);
  });
}
