import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test, after } from 'node:test';
import { build } from 'esbuild';

const production = await build({ stdin: { contents: [
  "export { ForegroundController } from './src/main/foreground/controller';",
  "export { ForegroundPanel } from './src/renderer/ForegroundPanel';",
  "export { createElement } from 'react';",
  "export { renderToStaticMarkup } from 'react-dom/server';",
  "export { ContactSession } from './src/main/contacts/session';",
  "export { readContactDirectory } from './src/main/contacts/directory';",
  "export { JsonClient } from './src/main/backend/json-client';",
  "export { readConnection } from './src/main/backend/connection';",
  "export { withVerifiedForegroundFixture } from './tests/foreground-backend-fixture';",
].join('\n'), resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const bundleDirectory = await mkdtemp(path.join(tmpdir(), 'notalone-single-frame-http-'));
await writeFile(path.join(bundleDirectory, 'production.mjs'), production.outputFiles[0].text);
const ports = await import(path.join(bundleDirectory, 'production.mjs'));
after(() => rm(bundleDirectory, { recursive: true, force: true }));

test('切到带人数群聊隐藏群名并阻断确认，回到已绑定私聊自动恢复且草稿保留', async () => {
  await ports.withVerifiedForegroundFixture(async fixture => {
    const [contactId] = fixture.data.contact_ids;
    const privateName = '合成私聊甲';
    const groupName = '合成讨论组（硕博）';
    await fixture.setCli({ sessions: [
      { username: 'wxid_synthetic_a', display_name: privateName, chat_type: 'private', last_timestamp: 1_700_000_000 },
      { username: 'synthetic_group@chatroom', display_name: groupName, chat_type: 'group', last_timestamp: 1_700_000_000 },
    ], messages: {} });
    assert.equal((await fixture.request('/api/sync/cli-bindings/confirm', { selections: [
      { locator: 'wxid_synthetic_a', contact_id: contactId },
    ] })).status, 200);
    assert.equal((await fixture.request('/api/sync/enable', {})).status, 200);
    const client = new ports.JsonClient(await ports.readConnection(fixture.infoPath));
    const requests = []; let observed;
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
      async requestJson(request) {
        requests.push(request.path);
        const response = await client.perform(request);
        if (request.path.endsWith('/observe')) observed = response.data;
        return { ...response, generation: 1 };
      } };
    const contacts = new ports.ContactSession(() => ports.readContactDirectory(backend));
    contacts.setConnection(1); await contacts.refreshContacts();
    const scheduled = new Map(); let token = 0;
    const clock = { schedule(callback, delay) { const id = ++token; scheduled.set(id, { callback, delay }); return id; },
      cancel(id) { scheduled.delete(id); } };
    const foreground = new ports.ForegroundController(backend, contacts, clock);
    const observe = async name => {
      await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify({
        capture_version: 'automatic-header-v3', display_name: name,
      }));
      await foreground.observeBeforeShow();
      return foreground.getState();
    };
    const render = () => ports.renderToStaticMarkup(ports.createElement(ports.ForegroundPanel,
      { state: foreground.getState(), session: { state: contacts.getState() } }));
    const confirm = () => foreground.confirm({ contactId, contactScopeRevision: contacts.getState().scopeRevision,
      foregroundRevision: foreground.getState().foregroundRevision });
    try {
      foreground.startContinuous();
      await observe(privateName);
      assert.equal(foreground.getState().confirmedContactId, contactId);
      contacts.setDraft({ contactId, scopeRevision: contacts.getState().scopeRevision, text: '保留合成私聊草稿' });
      const tails = await fixture.tails();
      await observe(`${groupName} （28）`);
      assert.equal(observed.phase, 'paused');
      assert.ok(['group_chat_suspected', 'group_chat_unsupported'].includes(observed.reason));
      assert.equal(Object.hasOwn(observed, 'recognized_name'), false);
      assert.equal(foreground.getState().recognizedName, null);
      assert.equal(foreground.getGenerationBlock(), 'foreground-confirmation-required');
      assert.equal(contacts.getState().selectedContactId, contactId);
      assert.equal(contacts.getState().draft, '保留合成私聊草稿');
      assert.ok(render().includes('群聊暂不支持'));
      assert.ok(!render().includes(groupName));
      assert.ok(!render().includes('确认本次联系人'));
      assert.throws(confirm);
      assert.equal(scheduled.size, 1, '保留一轮有界观察以发现返回私聊');
      assert.equal(scheduled.values().next().value.delay, 2000, '群聊暂停不进入技术失败退避');
      foreground.notifyHelperLifecycle('focused');
      assert.equal(scheduled.size, 0);
      assert.ok(render().includes('群聊暂不支持'), '进入助手不能解除群聊暂停');
      assert.throws(confirm);
      foreground.notifyHelperLifecycle('blurred');
      await observe(privateName);
      assert.equal(foreground.getState().confirmation, 'verified-binding');
      assert.equal(foreground.getGenerationBlock(), null);
      assert.equal(contacts.getState().draft, '保留合成私聊草稿');
      assert.deepEqual(await fixture.tails(), tails);
      assert.equal(requests.some(p => /\/(disable|generate|prepare|rewrite)$/.test(p)), false);
    } finally { foreground.dispose(); client.cancelPending(); }
  });
});

test('群聊暂停后的低分观察不能重新开放人工确认或展示群名', async () => {
  await ports.withVerifiedForegroundFixture(async fixture => {
    const [contactId] = fixture.data.contact_ids;
    await fixture.setCli({ sessions: [
      { username: 'synthetic_group@chatroom', display_name: '合成低分讨论组', chat_type: 'group', last_timestamp: 1_700_000_000 },
    ], messages: {} });
    assert.equal((await fixture.request('/api/sync/enable', {})).status, 200);
    const client = new ports.JsonClient(await ports.readConnection(fixture.infoPath));
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
      async requestJson(request) { return { ...await client.perform(request), generation: 1 }; } };
    const contacts = new ports.ContactSession(() => ports.readContactDirectory(backend));
    contacts.setConnection(1); await contacts.refreshContacts();
    const foreground = new ports.ForegroundController(backend, contacts);
    const observe = async (display_name, extra = {}) => {
      await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify({
        capture_version: 'automatic-header-v3', display_name, ...extra,
      }));
      await foreground.observeBeforeShow();
    };
    try {
      await observe('合成低分讨论组 (28)');
      await observe('合成低分讨论组', { display_name_confidence: 0.5 });
      assert.equal(foreground.getState().unsupportedConversation, true);
      assert.equal(foreground.getState().recognizedName, null);
      assert.throws(() => foreground.confirm({ contactId, contactScopeRevision: contacts.getState().scopeRevision,
        foregroundRevision: foreground.getState().foregroundRevision }));
      const html = ports.renderToStaticMarkup(ports.createElement(ports.ForegroundPanel, { state: foreground.getState() }));
      assert.ok(html.includes('群聊暂不支持'));
      assert.ok(!html.includes('合成低分讨论组'));
    } finally { foreground.dispose(); client.cancelPending(); }
  });
});

test('群标题遇CLI候选截断或失败仍暂停且认证HTTP不返回群名', async () => {
  await ports.withVerifiedForegroundFixture(async fixture => {
    await fixture.setCli({ sessions: Array.from({ length: 51 }, (_, index) => ({
      username: `synthetic_group_${index}@chatroom`, display_name: `合成截断讨论组${index}`,
      chat_type: 'group', last_timestamp: 1_700_000_000,
    })), messages: {} });
    assert.equal((await fixture.request('/api/sync/enable', {})).status, 200);
    for (const display_name of ['合成截断讨论组 (28)', '合成截断讨论组0']) {
      await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify({
        capture_version: 'automatic-header-v3', display_name,
      }));
      const observed = await fixture.request('/api/sync/foreground/observe', {});
      assert.equal(observed.status, 200);
      assert.equal(observed.data.phase, 'paused');
      assert.equal(Object.hasOwn(observed.data, 'recognized_name'), false);
      assert.equal(observed.data.contact_id, null);
    }
    await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify({
      capture_version: 'automatic-header-v3', display_name: '合成截断讨论组 (28)',
    }));
    await writeFile(path.join(fixture.directory, 'sessions-failed'), '');
    const failed = await fixture.request('/api/sync/foreground/observe', {});
    assert.equal(failed.status, 200);
    assert.equal(failed.data.phase, 'paused');
    assert.equal(Object.hasOwn(failed.data, 'recognized_name'), false);
    assert.equal(failed.data.contact_id, null);
  });
});
