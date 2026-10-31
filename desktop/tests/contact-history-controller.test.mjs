import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

const bundled = await build({ stdin: { contents: "export { ContactHistoryController } from './src/main/contact-history/controller'; export { installContactHistoryBridge } from './src/main/contact-history/bridge'; export { ContactSession } from './src/main/contacts/session';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false });
const { ContactHistoryController, installContactHistoryBridge, ContactSession } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

function harness(requestJson) {
  let generation = 7;
  const backendListeners = new Set();
  const backend = { getConnectionGeneration: () => generation, requestJson,
    onStateChanged(listener) { backendListeners.add(listener); return () => backendListeners.delete(listener); },
    setGeneration(value) { generation = value; for (const listener of backendListeners) listener({}); } };
  const contactIds = [randomUUID(), randomUUID()];
  const contacts = new ContactSession(async () => ({ generation: 7, contacts: contactIds.map((contactId, i) => ({
    contactId, displayName: `合成联系人${i}`, messageCount: 0, sourceCount: 0,
  })) }));
  contacts.setConnection(7);
  return { backend, contacts, contactIds, async select(index = 0) {
    await contacts.refreshContacts();
    const state = contacts.getState();
    contacts.selectContact({ contactId: contactIds[index], scopeRevision: state.scopeRevision });
  } };
}

function message(text, occurredAt = '2026-10-30T12:00:00.000Z') {
  return { message_id: randomUUID(), speaker: 'contact', message_type: 'text', text,
    media_placeholder: null, occurred_at: occurredAt, quoted: null };
}

test('联系人切换后迟到的旧范围页面不会重新显示旧联系人正文', async () => {
  let release;
  let enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const request = new Promise(resolve => { release = resolve; });
  const setup = harness(async () => { enteredResolve(); return request; });
  await setup.select(0);
  const history = new ContactHistoryController(setup.backend, setup.contacts);
  const oldScope = setup.contacts.getState();
  const pending = history.load({ contactId: setup.contactIds[0], scopeRevision: oldScope.scopeRevision, older: false });
  await entered;
  setup.contacts.selectContact({ contactId: setup.contactIds[1], scopeRevision: oldScope.scopeRevision });
  release({ generation: 7, data: { messages: [message('旧联系人合成聊天')], next_cursor: null } });
  await pending;
  assert.equal(history.getState().contactId, setup.contactIds[1]);
  assert.deepEqual(history.getState().messages.items, []);
  history.dispose();
});

test('聊天历史按后端游标分页并合并为只读消息列表', async () => {
  const olderCursor = randomUUID();
  const newest = Array.from({ length: 20 }, (_, i) => message(`新页${i}`, `2026-10-${String(30 - i).padStart(2, '0')}T12:00:00.000Z`));
  const older = Array.from({ length: 20 }, (_, i) => message(`旧页${i}`, `2026-09-${String(30 - i).padStart(2, '0')}T12:00:00.000Z`));
  const calls = [];
  const setup = harness(async input => {
    calls.push(input);
    return { generation: 7, data: input.path.includes('before=')
      ? { messages: older, next_cursor: null }
      : { messages: newest, next_cursor: olderCursor } };
  });
  await setup.select();
  const history = new ContactHistoryController(setup.backend, setup.contacts);
  const scope = setup.contacts.getState();
  await history.load({ contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: false });
  await history.load({ contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: true });
  const state = history.getState();
  assert.equal(calls.length, 2);
  assert.match(calls[0].path, /messages\?limit=20$/);
  assert.ok(calls[1].path.endsWith(`&before=${olderCursor}`));
  assert.equal(state.messages.phase, 'ready');
  assert.equal(state.messages.items.length, 40);
  assert.equal(state.messages.nextCursor, null);
  assert.ok(state.messages.items.some(item => item.text === '旧页0'));
  history.dispose();
});

test('页面失败清空可能不完整的结果并给出重试状态', async () => {
  const setup = harness(async () => { throw new Error('synthetic read failure'); });
  await setup.select();
  const history = new ContactHistoryController(setup.backend, setup.contacts);
  const scope = setup.contacts.getState();
  await history.load({ contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: false });
  const state = history.getState();
  assert.equal(state.messages.phase, 'failed');
  assert.deepEqual(state.messages.items, []);
  assert.match(state.error, /重试/);
  history.dispose();
});

test('删除失效会撤下消息并阻止旧读取恢复；断联会丢弃联系人范围', async () => {
  let release;
  let enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const request = new Promise(resolve => { release = resolve; });
  const setup = harness(async () => { enteredResolve(); return request; });
  await setup.select();
  const history = new ContactHistoryController(setup.backend, setup.contacts);
  const scope = setup.contacts.getState();
  const pending = history.load({ contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: false });
  await entered;
  history.invalidate('来源删除中');
  release({ generation: 7, data: { messages: [message('已删除来源的旧正文')], next_cursor: null } });
  await pending;
  assert.deepEqual(history.getState().messages.items, []);
  assert.equal(history.getState().error, '来源删除中');
  setup.backend.setGeneration(undefined);
  assert.equal(history.getState().contactId, null);
  assert.deepEqual(history.getState().messages.items, []);
  history.dispose();
});

test('bridge 命令仅注册给管理窗口并严格校验分页参数', async () => {
  const setup = harness(async () => ({ generation: 7, data: { messages: [], next_cursor: null } }));
  await setup.select();
  const handlers = new Map(), publications = [];
  const commands = {
    handle(channel, handler, role) { handlers.set(channel, { handler, role }); },
    publish(channel, state, role) { publications.push({ channel, state, role }); },
  };
  const controller = installContactHistoryBridge(commands, setup.backend, setup.contacts);
  for (const channel of ['contact-history:get-state', 'contact-history:load']) assert.equal(handlers.get(channel).role, 'manager');
  assert.deepEqual((await handlers.get('contact-history:get-state').handler()).messages.items, []);
  assert.throws(() => handlers.get('contact-history:get-state').handler({}), /不可用/);
  const scope = setup.contacts.getState();
  assert.throws(() => handlers.get('contact-history:load').handler({ contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: false, extra: true }), /不可用/);
  assert.throws(() => handlers.get('contact-history:load').handler({ contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: 'false' }), /不可用/);
  await handlers.get('contact-history:load').handler({ contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: false });
  assert.ok(publications.length);
  assert.ok(publications.every(publication => publication.role === 'manager'));
  controller.dispose();
});

test('没有有效联系人时同步快照保持幂等，scope revision变化只发布一次', () => {
  const contacts = new ContactSession(async () => ({ generation: 7, contacts: [] }));
  const backend = { getConnectionGeneration: () => undefined, requestJson: async () => { throw new Error('unused'); },
    onStateChanged: () => () => {} };
  const history = new ContactHistoryController(backend, contacts);
  const events = [];
  history.onStateChanged(state => events.push(state));
  const initial = history.getState();
  assert.equal(initial.revision, 0);
  assert.equal(initial.scopeRevision, contacts.getState().scopeRevision);
  history.getState(); history.getState();
  assert.equal(events.length, 0);
  contacts.invalidateReadingScope();
  const changed = history.getState();
  assert.equal(events.length, 1);
  assert.equal(changed.scopeRevision, contacts.getState().scopeRevision);
  history.getState(); history.getState();
  assert.equal(events.length, 1);
  history.dispose();
});
