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
  let subscriptions = 0;
  const backendListeners = new Set();
  const messageListeners = new Set();
  const backend = { getConnectionGeneration: () => generation, requestJson,
    onStateChanged(listener) { backendListeners.add(listener); return () => backendListeners.delete(listener); },
    subscribeMessages(callbacks, signal) { subscriptions++; messageListeners.add(callbacks); signal.addEventListener('abort', () => messageListeners.delete(callbacks), { once: true }); },
    emitMessage(event) { for (const listener of messageListeners) listener.message(event); },
    emitConnected() { for (const listener of messageListeners) listener.connected(); },
    interruptMessages() { for (const listener of messageListeners) listener.interrupted(); },
    subscriptionCount: () => subscriptions,
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
function historyPage(available, input) {
  const before = new URLSearchParams(input.path.split('?')[1]).get('before');
  const start = before ? available.findIndex(item => item.message_id === before) + 1 : 0;
  const messages = available.slice(start, start + 20);
  return { generation: 7, data: { messages,
    next_cursor: available.length > start + 20 ? messages.at(-1).message_id : null } };
}

const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

test('聊天事件断流后自动重订阅，连接及重连核对最新消息', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = message('旧消息'), newest = message('断流期间已入库的新消息', '2026-11-03T12:00:00Z');
  let latest = old, reads = 0;
  const setup = harness(async () => { reads++; return { generation: 7, data: { messages: [latest], next_cursor: null } }; });
  await setup.select();
  const history = new ContactHistoryController(setup.backend, setup.contacts); t.after(() => history.dispose());
  const scope = setup.contacts.getState();
  await history.load({ contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: false });
  setup.backend.emitConnected(); t.mock.timers.tick(120); await flush();
  assert.equal(reads, 2, '连接完成应主动核对加载期间遗漏的消息');
  setup.backend.interruptMessages(); latest = newest;
  t.mock.timers.tick(5000); await flush();
  assert.equal(setup.backend.subscriptionCount(), 2, '断流后应重新建立事件订阅');
  setup.backend.emitConnected(); t.mock.timers.tick(120); await flush();
  assert.equal(history.getState().messages.items[0].messageId, newest.message_id);
  assert.ok(history.getState().messages.items.some(item => item.messageId === old.message_id));
});

test('无新消息事件的历史补齐也定期核对最近一页，保留较早分页并响应即时事件', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cursor = randomUUID(), old = message('较早分页'), initial = message('原最近消息', '2026-11-02T12:00:00Z');
  const newest = message('没有事件的后台补齐', '2026-11-03T12:00:00Z');
  let latest = [initial]; const calls = [];
  const setup = harness(async input => {
    calls.push(input);
    return { generation: 7, data: input.path.includes('before=')
      ? { messages: [old], next_cursor: null } : { messages: latest, next_cursor: cursor } };
  });
  await setup.select();
  const history = new ContactHistoryController(setup.backend, setup.contacts); t.after(() => history.dispose());
  const scope = setup.contacts.getState();
  await history.load({ contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: false });
  await history.load({ contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: true });
  latest = [newest, initial];
  t.mock.timers.tick(4999); await flush(); assert.equal(calls.length, 2);
  t.mock.timers.tick(1); t.mock.timers.tick(120); await flush();
  assert.equal(calls.length, 3, '每轮只读取最近20条，不扫描所有历史或联系人');
  assert.deepEqual(history.getState().messages.items.map(item => item.messageId), [newest, initial, old].map(item => item.message_id));
  assert.equal(history.getState().messages.nextCursor, null, '后台核对不能覆盖已加载较早页的游标');
  const immediate = message('收到事件后立即更新', '2026-11-03T12:01:00Z'); latest = [immediate, ...latest];
  setup.backend.emitMessage({ contactId: setup.contactIds[0], messageId: immediate.message_id, change: 'created' });
  t.mock.timers.tick(120); await flush();
  assert.equal(history.getState().messages.items[0].messageId, immediate.message_id);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.method === 'GET' && /\/history-messages\?limit=20/.test(call.path)));
});

for (const initialCount of [0, 3, 20]) test(`初始${initialCount}条历史自动补齐后恢复更早消息分页`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const complete = Array.from({ length: 40 }, (_, index) => message(`补齐消息${index}`,
    `2026-11-03T12:${String(59 - index).padStart(2, '0')}:00Z`));
  let available = complete.slice(0, initialCount);
  const setup = harness(async input => historyPage(available, input));
  await setup.select();
  const history = new ContactHistoryController(setup.backend, setup.contacts); t.after(() => history.dispose());
  const scope = setup.contacts.getState();
  const request = { contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: false };
  await history.load(request);
  assert.equal(history.getState().messages.nextCursor, null);
  available = complete;
  t.mock.timers.tick(5000); t.mock.timers.tick(120); await flush();
  assert.equal(history.getState().messages.items.length, 20);
  assert.equal(history.getState().messages.nextCursor, complete[19].message_id);
  await history.load({ ...request, older: true });
  assert.deepEqual(history.getState().messages.items.map(item => item.messageId), complete.map(item => item.message_id));
  assert.equal(history.getState().messages.nextCursor, null);
});

test('已翻到底后刷新重叠首页不重复分页，超过一页的新消息仍可补齐缺口', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const complete = Array.from({ length: 70 }, (_, index) => ({ ...message(`连续消息${index}`),
    ordering: 'verified', display_position: String(70 - index) }));
  let available = complete.slice(30); const calls = [];
  const setup = harness(async input => { calls.push(input); return historyPage(available, input); });
  await setup.select();
  const history = new ContactHistoryController(setup.backend, setup.contacts); t.after(() => history.dispose());
  const scope = setup.contacts.getState();
  const request = { contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: false };
  await history.load(request); await history.load({ ...request, older: true });
  assert.equal(history.getState().messages.nextCursor, null);

  available = complete.slice(25);
  t.mock.timers.tick(5000); t.mock.timers.tick(120); await flush();
  assert.equal(history.getState().messages.nextCursor, null, '重叠页可以沿已读边界证明仍已到底');
  const reads = calls.length;
  await history.load({ ...request, older: true });
  assert.equal(calls.length, reads, '已到底不应重新请求已加载旧页');

  available = complete;
  t.mock.timers.tick(5000); t.mock.timers.tick(120); await flush();
  assert.equal(history.getState().messages.nextCursor, complete[19].message_id, '不重叠的最近页必须保留中间缺口入口');
  await history.load({ ...request, older: true });
  assert.equal(history.getState().messages.nextCursor, null, '补读与旧范围重叠后复用其已到底证据');
  assert.deepEqual(history.getState().messages.items.map(item => item.messageId), complete.map(item => item.message_id));
});

test('较早历史插入超过一页后沿新边界补齐缺口并保留已加载最旧消息', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const complete = Array.from({ length: 70 }, (_, index) => ({ ...message(`历史消息${index}`),
    ordering: 'verified', display_position: String(70 - index) }));
  let available = [...complete.slice(0, 10), ...complete.slice(40)];
  const setup = harness(async input => historyPage(available, input));
  await setup.select();
  const history = new ContactHistoryController(setup.backend, setup.contacts); t.after(() => history.dispose());
  const scope = setup.contacts.getState();
  const request = { contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: false };
  await history.load(request); await history.load({ ...request, older: true });
  available = complete;
  t.mock.timers.tick(5000); t.mock.timers.tick(120); await flush();
  assert.equal(history.getState().messages.nextCursor, complete[19].message_id);
  assert.ok(history.getState().messages.items.some(item => item.messageId === complete[69].message_id));
  await history.load({ ...request, older: true });
  assert.equal(history.getState().messages.nextCursor, complete[39].message_id);
  await history.load({ ...request, older: true });
  assert.equal(history.getState().messages.nextCursor, null);
  assert.deepEqual(history.getState().messages.items.map(item => item.messageId), complete.map(item => item.message_id));
});

for (const allLoaded of [false, true]) test(`未知时间补齐后${allLoaded ? '已到底不循环' : '仍能访问尚未加载的旧页'}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const knownCount = allLoaded ? 40 : 20;
  const known = Array.from({ length: knownCount }, (_, index) => ({ ...message(`有时间消息${index}`,
    `2026-11-03T12:${String(59 - index).padStart(2, '0')}:00Z`),
    ordering: 'verified', display_position: String(knownCount - index) }));
  const unknown = Array.from({ length: allLoaded ? 1 : 41 }, (_, index) => ({ ...message(`未知时间消息${index}`, null),
    ordering: 'unknown', display_position: String(100 - index) }));
  let available = [...known, ...unknown];
  const setup = harness(async input => historyPage(available, input));
  await setup.select();
  const history = new ContactHistoryController(setup.backend, setup.contacts); t.after(() => history.dispose());
  const request = { contactId: setup.contactIds[0], scopeRevision: setup.contacts.getState().scopeRevision, older: false };
  await history.load(request); await history.load({ ...request, older: true });
  if (allLoaded) await history.load({ ...request, older: true });
  assert.equal(history.getState().messages.items.length, allLoaded ? 41 : 40);

  const moved = unknown[allLoaded ? 0 : 10];
  available = [{ ...moved, occurred_at: '2026-11-03T13:00:00Z', ordering: 'verified' },
    ...known, ...unknown.filter(item => item !== moved)];
  t.mock.timers.tick(5000); t.mock.timers.tick(120); await flush();
  assert.equal(history.getState().messages.items[0].messageId, moved.message_id);
  const visited = new Set();
  for (let page = 0; page < 4 && history.getState().messages.nextCursor !== null; page++) {
    const cursor = history.getState().messages.nextCursor;
    assert.ok(!visited.has(cursor), '时间补齐后不能反复请求同一更早页');
    visited.add(cursor);
    await history.load({ ...request, older: true });
  }
  assert.equal(history.getState().messages.nextCursor, null);
  assert.deepEqual(history.getState().messages.items.map(item => item.messageId), available.map(item => item.message_id),
    '应读到所有旧消息，不能将环伪装为已到底而隐藏未读范围');
});

test('定期核对串行读取，切换联系人、来源失效或释放后停止旧范围核对', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release, held = false; const calls = [];
  const setup = harness(async input => {
    calls.push(input);
    if (held) await new Promise(resolve => { release = resolve; });
    return { generation: 7, data: { messages: [message('合成范围消息')], next_cursor: null } };
  });
  await setup.select();
  const history = new ContactHistoryController(setup.backend, setup.contacts); t.after(() => history.dispose());
  let scope = setup.contacts.getState();
  t.mock.timers.tick(5000); await flush(); assert.equal(calls.length, 0, '未打开聊天历史时不读取正文');
  await history.load({ contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: false });
  held = true; t.mock.timers.tick(5000); t.mock.timers.tick(120); await flush();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(15_000); await flush();
  assert.equal(calls.length, 2, '后台核对未返回时不得并发读取或反复取消');
  assert.equal(calls[1].signal.aborted, false);
  setup.contacts.selectContact({ contactId: setup.contactIds[1], scopeRevision: scope.scopeRevision });
  assert.equal(calls[1].signal.aborted, true); held = false; release(); await flush();
  assert.deepEqual(history.getState().messages.items, []);
  t.mock.timers.tick(5000); await flush(); assert.equal(calls.length, 2);
  scope = setup.contacts.getState();
  await history.load({ contactId: setup.contactIds[1], scopeRevision: scope.scopeRevision, older: false });
  history.invalidate('来源删除中'); t.mock.timers.tick(10_000); await flush();
  assert.equal(calls.length, 3); assert.deepEqual(history.getState().messages.items, []);
  await history.load({ contactId: setup.contactIds[1], scopeRevision: scope.scopeRevision, older: false });
  history.dispose(); t.mock.timers.tick(10_000); await flush(); assert.equal(calls.length, 4);
});

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
  assert.match(calls[0].path, /history-messages\?limit=20$/);
  assert.ok(calls[1].path.endsWith(`&before=${olderCursor}`));
  assert.equal(state.messages.phase, 'ready');
  assert.equal(state.messages.items.length, 40);
  assert.equal(state.messages.nextCursor, null);
  assert.ok(state.messages.items.some(item => item.text === '旧页0'));
  history.dispose();
});

test('当前聊天中的图片状态变更通过消息事件刷新历史投影', async () => {
  const messageId = randomUUID(); let current = { state: 'pending', file_id: null, mime_type: null };
  const setup = harness(async () => ({ generation: 7, data: { messages: [{
    message_id: messageId, speaker: 'contact', message_type: 'image', text: null, media_placeholder: '[图片]',
    occurred_at: '2026-10-31T12:00:00Z', quoted: null, ordering: 'verified', display_position: '1', image_media: current,
  }], next_cursor: null } }));
  await setup.select();
  const history = new ContactHistoryController(setup.backend, setup.contacts);
  const scope = setup.contacts.getState();
  await history.load({ contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: false });
  current = { state: 'original', file_id: randomUUID(), mime_type: 'image/png' };
  setup.backend.emitMessage({ contactId: setup.contactIds[0], messageId, change: 'updated' });
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(history.getState().messages.items[0].imageMedia.state, 'original');
  history.dispose();
});

test('引用快照从占位更新为内容时刷新并替换同一消息 ID', async () => {
  const replyId = randomUUID(), targetId = randomUUID();
  let quote = null;
  const setup = harness(async () => ({ generation: 7, data: { messages: [{ ...message('这是本次回复正文'),
    message_id: replyId, message_type: 'quote', quoted: quote }], next_cursor: null } }));
  await setup.select();
  const history = new ContactHistoryController(setup.backend, setup.contacts);
  const scope = setup.contacts.getState();
  await history.load({ contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: false });
  quote = { text: '补齐后的引用快照', target_message_id: targetId, sender: '合成联系人0',
    sender_role: 'contact', message_type: 'text', state: 'resolved' };
  setup.backend.emitMessage({ contactId: setup.contactIds[0], messageId: replyId, change: 'updated' });
  await new Promise(resolve => setTimeout(resolve, 180));
  const updated = history.getState().messages.items;
  assert.equal(updated.length, 1);
  assert.equal(updated[0].messageId, replyId);
  assert.equal(updated[0].text, '这是本次回复正文');
  assert.equal(updated[0].quoted.text, '补齐后的引用快照');
  assert.equal(updated[0].quoted.state, 'resolved');
  history.dispose();
});

test('已加载的较早页中图片状态变化时按该页游标刷新并保留消息顺序', async () => {
  const cursor = randomUUID(), targetId = randomUUID(), calls = [];
  let imageState = { state: 'pending', file_id: null, mime_type: null };
  const newest = Array.from({ length: 20 }, (_, index) => ({ ...message(`新消息${index}`),
    message_id: randomUUID(), ordering: 'verified', display_position: String(100 - index) }));
  const older = [{ ...message(null), message_id: targetId, message_type: 'image', media_placeholder: '[图片]',
    ordering: 'verified', display_position: '80', image_media: imageState }];
  const setup = harness(async input => {
    calls.push(input);
    return { generation: 7, data: input.path.includes('before=')
      ? { messages: older.map(item => ({ ...item, image_media: imageState })), next_cursor: null }
      : { messages: newest, next_cursor: cursor } };
  });
  await setup.select();
  const history = new ContactHistoryController(setup.backend, setup.contacts);
  const scope = setup.contacts.getState();
  await history.load({ contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: false });
  await history.load({ contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: true });
  imageState = { state: 'original', file_id: randomUUID(), mime_type: 'image/png' };
  setup.backend.emitMessage({ contactId: setup.contactIds[0], messageId: targetId, change: 'updated' });
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.ok(calls.at(-1).path.endsWith(`&before=${cursor}`));
  const items = history.getState().messages.items;
  assert.equal(items.length, 21);
  assert.equal(items.find(item => item.messageId === targetId).imageMedia.state, 'original');
  assert.ok(items.findIndex(item => item.messageId === targetId) > items.findIndex(item => item.messageId === newest[0].message_id));
  history.dispose();
});

test('首页新增多条消息后仍按图片原始游标刷新较早页', async () => {
  const firstCursor = randomUUID(), secondCursor = randomUUID(), targetId = randomUUID(), calls = [];
  let imageState = { state: 'pending', file_id: null, mime_type: null };
  const withPosition = (messageId, text, position) => ({ ...message(text), message_id: messageId,
    ordering: 'verified', display_position: String(position) });
  const originalHome = Array.from({ length: 20 }, (_, index) => withPosition(randomUUID(), `原首页${index}`, 100 - index));
  const insertedHome = Array.from({ length: 20 }, (_, index) => withPosition(randomUUID(), `新首页${index}`, 120 - index));
  const older = Array.from({ length: 20 }, (_, index) => ({
    ...withPosition(index === 10 ? targetId : randomUUID(), `较早页${index}`, 80 - index),
    ...(index === 10 ? { message_type: 'image', media_placeholder: '[图片]', image_media: imageState } : {}),
  }));
  const setup = harness(async input => {
    calls.push(input);
    const before = new URLSearchParams(input.path.split('?')[1]).get('before');
    if (before === firstCursor) return { generation: 7,
      data: { messages: older.map(item => item.message_id === targetId ? { ...item, image_media: imageState } : item), next_cursor: secondCursor } };
    if (before) return { generation: 7, data: { messages: [], next_cursor: null } };
    return { generation: 7, data: { messages: calls.length === 1 ? originalHome : insertedHome, next_cursor: firstCursor } };
  });
  await setup.select();
  const history = new ContactHistoryController(setup.backend, setup.contacts);
  const scope = setup.contacts.getState();
  await history.load({ contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: false });
  await history.load({ contactId: setup.contactIds[0], scopeRevision: scope.scopeRevision, older: true });
  setup.backend.emitMessage({ contactId: setup.contactIds[0], messageId: insertedHome[0].message_id, change: 'created' });
  await new Promise(resolve => setTimeout(resolve, 180));
  const afterInsert = history.getState().messages.items;
  assert.equal(afterInsert.length, 60);
  assert.ok(afterInsert.findIndex(item => item.messageId === targetId) >= 40);

  imageState = { state: 'original', file_id: randomUUID(), mime_type: 'image/png' };
  setup.backend.emitMessage({ contactId: setup.contactIds[0], messageId: targetId, change: 'updated' });
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.ok(calls.at(-1).path.endsWith(`&before=${firstCursor}`));
  const refreshed = history.getState().messages.items;
  assert.equal(refreshed.find(item => item.messageId === targetId).imageMedia.state, 'original');
  assert.equal(refreshed.length, 60);
  assert.equal(refreshed[0].messageId, insertedHome[0].message_id);
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
