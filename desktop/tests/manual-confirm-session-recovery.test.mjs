import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `
  export { BackendHost } from './src/main/backend/host';
  export { ContactSession } from './src/main/contacts/session';
  export { installForegroundBridge } from './src/main/foreground/bridge';
  export { ReplySession } from './src/main/reply/session';
  export { BackendRequestFailure } from './src/main/backend/json-client';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { BackendHost, ContactSession, installForegroundBridge, ReplySession, BackendRequestFailure } = module.exports;
const contactId = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-000000000002';
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(setImmediate); };

async function fixture(t, holdFirstRead = false, holdSessionRead = false) {
  const calls = [];
  let confirmed = false, rejectFirst, releaseSession;
  const sessionRead = new Promise((resolve) => { releaseSession = resolve; });
  const firstRead = new Promise((resolve) => { rejectFirst = resolve; });
  const host = new BackendHost('/unused/synthetic-manual-recovery');
  // 只替换传输边界，不连接运行时；手动范围仍由真实 Host 的可信确认状态添加。
  host.generation = 7;
  host.state = { phase: 'connected' };
  host.target = { subscribeMessages() {}, async requestJson(options) {
    calls.push({ path: options.path, manualContactId: options.manualContactId ?? null });
    if (options.path.endsWith('/manual-confirmation')) { confirmed = true; return { confirmed: true }; }
    if (options.path.endsWith('/assistant-session/default')) {
      if (!confirmed || options.manualContactId !== contactId) {
        if (holdFirstRead) await firstRead;
        throw new BackendRequestFailure('response', 409, 'assistant_session_rejected');
      }
      return { session_id: sessionId };
    }
    if (options.path.endsWith('/selections')) return { selection: null };
    if (options.path === `/api/contacts/${contactId}/assistant-sessions/${sessionId}`) {
      if (holdSessionRead) await sessionRead;
      return { session_id: sessionId, current_input_version_id: null, turns: [], inputs: [] };
    }
    throw new Error(`未预期请求：${options.path}`);
  } };
  const contacts = new ContactSession(async () => ({ generation: 7,
    contacts: [{ contactId, displayName: '合成手动联系人', messageCount: 0, sourceCount: 0 }] }));
  contacts.setConnection(7); await contacts.refreshContacts();
  const handlers = new Map();
  const foreground = installForegroundBridge({ handle: (name, handler) => handlers.set(name, handler), publish() {} }, host, contacts);
  t.after(() => foreground.dispose());
  const replies = new ReplySession(contacts, host, () => foreground.getGenerationBlock());
  foreground.onStateChanged(() => replies.refreshGenerationEligibility());
  contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
  await settle();
  return { calls, contacts, foreground, replies, rejectFirst, releaseSession,
    revoke: () => { host.clearManualInput(contactId); const finish = foreground.beginReadingScopeChange(); finish(); },
    confirm: () => handlers.get('contacts:confirm-manual')({ contactId, scopeRevision: contacts.getState().scopeRevision }) };
}

for (const pending of [false, true]) {
  test(`已选联系人手动确认后恢复讨论，旧读取${pending ? '仍在途' : '已经失败'}`, async (t) => {
    const f = await fixture(t, pending);
    assert.equal(f.replies.getState().savedSession.phase, pending ? 'loading' : 'failed');
    assert.equal(f.calls[0].manualContactId, null);
    const revision = f.contacts.getState().scopeRevision;
    await f.confirm();
    f.replies.notifyHelperLifecycle('focused');
    await settle();
    assert.equal(f.foreground.getState().confirmation, 'manual-confirmed');
    assert.equal(f.contacts.getState().scopeRevision, revision);
    assert.equal(f.replies.getState().savedSession.phase, 'ready');
    assert.equal(f.replies.getState().savedSession.sessionId, sessionId);
    f.rejectFirst(); await settle();
    assert.equal(f.replies.getState().savedSession.phase, 'ready');
    const reads = f.calls.filter((call) => call.path.endsWith('/assistant-session/default'));
    assert.deepEqual(reads.map((call) => call.manualContactId), [null, contactId]);
    const count = f.calls.length;
    f.replies.refreshGenerationEligibility();
    await f.confirm(); await settle();
    assert.equal(f.calls.length, count + 1, '重复确认仅保留确认请求，不重新读取已就绪讨论');
    assert(f.calls.every((call) => !call.path.endsWith('/replies')), '恢复只读讨论，不生成候选');
  });
}


test('手动确认后的最终讨论读取在资格撤销后成功迟到，不恢复讨论；再次确认可重读', async (t) => {
  const f = await fixture(t, false, true);
  await f.confirm(); await settle();
  const finalRead = f.calls.find((call) => call.path === `/api/contacts/${contactId}/assistant-sessions/${sessionId}`);
  assert.equal(finalRead?.manualContactId, contactId, '撤销发生在带手动范围的最终 GET 已发出之后');
  assert.equal(f.replies.getState().savedSession.phase, 'loading');
  const revision = f.contacts.getState().scopeRevision;
  // 经可信宿主撤销手动范围，再由现有读取范围变更入口撤销生成资格；联系人和连接均不变化。
  f.revoke();
  assert.equal(f.contacts.getState().scopeRevision, revision);
  assert.equal(f.replies.getState().generationBlock, 'foreground-confirmation-required');
  f.releaseSession(); await settle();
  assert.notEqual(f.replies.getState().savedSession.phase, 'ready');
  assert.deepEqual(f.replies.getState().savedSession.turns, []);
  assert.equal(f.replies.getState().result, null);
  await f.confirm(); await settle();
  assert.equal(f.replies.getState().savedSession.phase, 'ready');
});
