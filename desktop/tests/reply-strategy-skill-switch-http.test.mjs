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
  test(`${scene}原Skill序列含旧confirm409后明确采用第二版本`, async () => {
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
        try {
          const [first, second] = (await fixture.command('strategy_skills')).skills;
          contacts.setConnection(backend.getConnectionGeneration()); await contacts.refreshContacts();
          contacts.selectContact({ contactId: fixture.data.contact_ids[0], scopeRevision: contacts.getState().scopeRevision });
          const scope = { contactId: fixture.data.contact_ids[0], scopeRevision: contacts.getState().scopeRevision };
          await bridge.readSavedSession(scope); await bridge.setMode({ ...scope, mode: scene });
          if (scene === 'reply_to_message') {
            await bridge.loadMessages({ ...scope, older: false });
            await bridge.selectMessage({ ...scope, messageId: (await bridge.getState()).messages.items[0].messageId });
          } else await bridge.updatePurpose({ ...scope, purpose: '想了解近况，尚未决定本次意愿。' });
          const explore = async () => { await fixture.plan({ explore: {} }); await bridge.explore(scope); };
          const confirm = async (prefix, skill) => {
            if (skill) await fixture.plan({ read_skill: skill.name });
            await fixture.plan({ count: 1, prefix });
            const result = (await bridge.getState()).exploration.result;
            const option = result.directions.find((item) => item.title === '愿意等待'); assert(option);
            await bridge.selectDirection({ ...scope, inputVersion: result.inputVersion, suggestionId: option.suggestionId });
          };
          const generate = async (prefix, skill) => {
            if (skill) await fixture.plan({ read_skill: skill.name });
            await fixture.plan({ count: 1, prefix }); await bridge.generate({ ...scope, newRequest: true });
          };
          const candidate = async (prefix) => assert.equal((await bridge.getState()).result.candidates[0].original.text, `${prefix}（说法1）。`);
          await explore(); assert.equal((await bridge.getState()).exploration.result.usedSkill, null);
          await bridge.updateSkill({ ...scope, skill: { mode: 'user', versionId: first.version_id } });
          await explore(); assert.equal((await bridge.getState()).exploration.result.usedSkill.versionId, first.version_id);
          await confirm('固定第一实际版本', first); await candidate('固定第一实际版本');
          assert.equal((await fixture.command('observations')).payloads.length, 4);
          await generate('普通生成沿用第一版本', first); await candidate('普通生成沿用第一版本');
          await explore(); const closingFirst = (await bridge.getState()).exploration.result;
          await bridge.updateSkill({ ...scope, skill: { mode: 'disabled', versionId: null } });
          await explore(); assert.equal((await bridge.getState()).exploration.result.usedSkill, null);
          await confirm('关闭后通用确认'); await candidate('关闭后通用确认');
          await generate('关闭后普通仍不自动选回'); await candidate('关闭后普通仍不自动选回');
          assert.equal((await fixture.command('observations')).payloads.length, 10);
          await bridge.updateSkill({ ...scope, skill: { mode: 'user', versionId: second.version_id } });
          await explore(); const secondExploration = (await bridge.getState()).exploration.result;
          assert.equal(secondExploration.usedSkill.versionId, second.version_id);
          const rejected = await fixture.request(`/api/contacts/${scope.contactId}/assistant-sessions/${closingFirst.sessionId}/explorations/${closingFirst.taskId}/confirm`, {
            input_version_id: closingFirst.inputVersion, suggestion_id: closingFirst.directions[0].suggestionId });
          assert.equal(rejected.status, 409);
          const secondRequestStart = requests.length, started = performance.now(); await confirm('更换后只用第二实际版本', second);
          const completedMs = performance.now() - started, state = await bridge.getState();
          const observations = await fixture.command('observations');
          const saved = await fixture.request(`/api/contacts/${scope.contactId}/assistant-sessions/${secondExploration.sessionId}`);
          const capture = { scene, data_kind: 'synthetic', quality_verified: false, native_executed: false,
            first, second, stale_confirm: rejected, second_exploration: secondExploration, public_state: state,
            actual_requests: requests, proxy_requests: proxy.explorationRequests, proxy_results: proxy.explorationResults,
            actual_model_observations: observations, saved, second_confirm_ms: completedMs,
            second_confirm_requests: requests.slice(secondRequestStart), control_completed: false };
          if (captureDirectory) await writeFile(`${captureDirectory}-${scene}.json`, JSON.stringify(capture, null, 2) + '\n');
          await candidate('更换后只用第二实际版本');
          assert(completedMs < 5000); assert.equal(observations.payloads.length, 13);
          assert.equal(state.result.usedSkill.versionId, second.version_id);
          assert.equal(saved.status, 200); assert.equal(saved.data.current_input_version_id, state.result.inputVersionId);
          assert.deepEqual(observations.skill_reads.at(-1), [observations.skill_reads.at(-1)[0]]);
          assert(observations.skill_reads.at(-1)[0].includes(second.marker));
          capture.control_completed = true;
          if (captureDirectory) await writeFile(`${captureDirectory}-${scene}.json`, JSON.stringify(capture, null, 2) + '\n');
        } finally {
          assert.equal(await backend.stop(() => replies.beginGenerationClosing(
            (receipt) => ports.interruptAssistantGeneration(backend, receipt),
            (preparation) => ports.recoverAssistantGenerationReceipt(backend, preparation))), true);
        }
      }); } finally { await proxy.close(); }
    }, () => { cleaned = true; });
    assert.equal(cleaned, true);
  });
}
