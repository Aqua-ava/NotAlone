import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { build } from 'esbuild';
const bundled = await build({ entryPoints: ['src/main/reply/assistant-message-notices.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false });
const { AssistantMessageNotices } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
const first = '00000000-0000-4000-8000-000000000011';
const second = '00000000-0000-4000-8000-000000000012';
const third = '00000000-0000-4000-8000-000000000013';
const scope = { connectionGeneration: 7, contactId: a, scopeRevision: 3, sessionId: 'session-a' };
function fixture() {
  const requests = [], streams = [], effects = [], sessions = new Map();
  let generation = 7;
  const notices = new AssistantMessageNotices({
    getConnectionGeneration: () => generation,
    subscribeMessages: (callbacks, signal) => streams.push({ ...callbacks, signal }),
    requestJson: (request) => new Promise((resolve, reject) => requests.push({ ...request, resolve, reject })),
  }, (contactId) => sessions.get(contactId) ?? [], (state, effect) => effects.push({ state, effect }));
  notices.setScope(scope); streams[0].connected();
  return { notices, requests, streams, effects, sessions,
    event: (messageId = first, contactId = a) => streams.at(-1).message({ contactId, messageId }),
    generation: (value) => { generation = value; },
    page: async (index, ids, speaker = 'contact') => {
      requests[index].resolve({ generation, data: { messages: ids.map((message_id) => ({ message_id,
        speaker, message_type: 'text', text: '合成消息', media_placeholder: null, occurred_at: null, quoted: null })), next_cursor: null } });
      await setImmediate();
    },
  };
}

test('确认刷新同时确认私有提醒，完整恢复和切回都不复活', async () => {
  const f = fixture(); f.event(); await f.page(0, [first]);
  assert.equal(f.notices.getState().changed, true);
  f.notices.confirmRefresh(f.notices.captureRefresh()); await f.notices.restore();
  f.notices.setScope({ ...scope, contactId: b, sessionId: 'session-b', scopeRevision: 4 });
  f.notices.setScope({ ...scope, scopeRevision: 5 }); await f.notices.restore();
  assert.equal(f.notices.getState().changed, false); assert.equal(f.requests.length, 1);
});

test('旧刷新只能确认原提醒，断流重连产生的新缺口保留', async () => {
  const f = fixture(); f.event(); await f.page(0, [first]);
  const ticket = f.notices.captureRefresh();
  f.streams[0].interrupted(); f.notices.reconnect(); f.streams[1].connected();
  f.notices.confirmRefresh(ticket);
  assert.deepEqual(f.notices.getState(), { phase: 'connected', changed: false, needsRefresh: true });
  f.notices.confirmRefresh(f.notices.captureRefresh()); assert.equal(f.notices.getState().needsRefresh, false);
});

test('刷新期间新事件正在核验，旧刷新不能取消它或确认新提醒', async () => {
  const f = fixture(); f.event(); await f.page(0, [first]);
  const ticket = f.notices.captureRefresh(); f.event(second); f.notices.confirmRefresh(ticket);
  assert.equal(f.requests[1].signal.aborted, false); await f.page(1, [second, first]);
  assert.equal(f.notices.captureAdoption().messageId, second);
});

test('旧结合完成只确认旧提醒，后到事件核验和缺口各自保留', async () => {
  const f = fixture(); f.event(); await f.page(0, [first]); const adopting = f.notices.captureAdoption();
  f.event(second); assert.equal(f.notices.captureAdoption(), undefined);
  f.notices.confirmAdoption(adopting); assert.equal(f.requests[1].signal.aborted, false);
  await f.page(1, [second, first]); assert.equal(f.notices.captureAdoption().messageId, second);
  f.streams[0].interrupted(); f.notices.confirmAdoption(adopting);
  assert.equal(f.notices.getState().changed, true); assert.equal(f.notices.getState().needsRefresh, true);
});

test('最新窗口未命中保留待核对记录，返回后再次核验才授予结合资格', async () => {
  const f = fixture(); f.event(); await f.page(0, [second]);
  assert.equal(f.notices.captureAdoption(), undefined);
  assert.deepEqual(f.notices.getState(), { phase: 'connected', changed: false, needsRefresh: true });
  f.notices.setScope({ ...scope, contactId: b, sessionId: 'session-b', scopeRevision: 4 });
  f.notices.setScope({ ...scope, scopeRevision: 5 });
  const restoring = f.notices.restore(); await f.page(1, [first]); await restoring;
  assert.equal(f.notices.captureAdoption().messageId, first);
});

test('消息读取失败保留连接和待核对状态，明确重读可以恢复', async () => {
  const f = fixture(); f.event(); f.requests[0].reject(new Error('合成传输失败')); await setImmediate();
  assert.deepEqual(f.notices.getState(), { phase: 'connected', changed: false, needsRefresh: true });
  const restoring = f.notices.restore(); await f.page(1, [first]); await restoring;
  assert.equal(f.notices.captureAdoption().messageId, first); assert.equal(f.streams.length, 1);
});

test('后到消息核验中或失败时不展示旧结合资格，重读可恢复新提醒', async () => {
  const f = fixture(); f.event(); await f.page(0, [first]);
  f.event(second);
  assert.equal(f.notices.getState().changed, false, '核验期间不能展示无有效票据的结合操作。');
  f.requests[1].reject(new Error('合成读取失败')); await setImmediate();
  assert.deepEqual(f.notices.getState(), { phase: 'connected', changed: false, needsRefresh: true });
  assert.equal(f.notices.captureAdoption(), undefined);
  const restoring = f.notices.restore(); await f.page(2, [second, first]); await restoring;
  assert.equal(f.notices.getState().changed, true);
  assert.equal(f.notices.captureAdoption().messageId, second);
});

test('完整重读遇到同一在途事件时共享核验，仍报告活动探索所需的消息变化', async () => {
  const f = fixture(); f.event();
  const restoring = f.notices.restore();
  await f.page(0, [first]);
  assert.equal(f.requests.length, 1);
  await restoring;
  assert.equal(f.effects.filter((entry) => entry.effect === 'verified').length, 1);
});

test('连续事件仅一个核验在途，完成后只核验最后待处理标识', async () => {
  const f = fixture(); f.event(); for (let index = 0; index < 30; index++) f.event(second); f.event(third);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].signal.aborted, false);
  await f.page(0, [first]); assert.equal(f.requests.length, 2); assert.equal(f.notices.getState().changed, false);
  await f.page(1, [third, second, first]); assert.equal(f.notices.captureAdoption().messageId, third);
  assert.equal(f.requests.length, 2); assert.equal(f.effects.filter((entry) => entry.effect === 'verified').length, 1);
});

test('本人消息也提醒；后台只记已知会话标识，切回才读取正文', async () => {
  const f = fixture(); f.event(); await f.page(0, [first], 'user'); assert.equal(f.notices.getState().changed, true);
  f.sessions.set(b, ['session-b']); f.event(second, b); assert.equal(f.requests.length, 1);
  f.notices.setScope({ ...scope, contactId: b, sessionId: 'session-b', scopeRevision: 4 });
  const restoring = f.notices.restore(); await f.page(1, [second], 'user'); await restoring;
  assert.equal(f.notices.captureAdoption().messageId, second);
});

test('助手会话尚未解析时仍可提示真实消息，但不能结合到未确认的会话', async () => {
  const f = fixture(); f.notices.setScope({ ...scope, sessionId: null });
  f.event(); await f.page(0, [first]);
  assert.equal(f.notices.getState().changed, true);
  assert.equal(f.notices.captureAdoption(), undefined);
});

for (const change of [{ sessionId: 'session-other' }, { contactId: b, scopeRevision: 4 }, { connectionGeneration: 8 }]) {
  test('范围变化使旧核验、刷新和结合票据失效：' + Object.keys(change)[0], async () => {
    const f = fixture(); f.event(); await f.page(0, [first]);
    const refresh = f.notices.captureRefresh(), adoption = f.notices.captureAdoption(); f.event(second);
    if (change.connectionGeneration) f.generation(change.connectionGeneration);
    f.notices.setScope({ ...scope, ...change }); assert.equal(f.requests[1].signal.aborted, true);
    await f.page(1, [second]); f.notices.confirmRefresh(refresh); f.notices.confirmAdoption(adoption);
    assert.equal(f.notices.getState().changed, false); assert.equal(f.notices.captureAdoption(), undefined);
    assert.equal(f.streams.length, change.sessionId ? 1 : 2);
  });
}

test('删除范围取消在途核验并清除保留记录，晚返回不能恢复', async () => {
  const f = fixture(); f.event(); f.notices.forget(a, scope.sessionId);
  assert.equal(f.requests[0].signal.aborted, true); await f.page(0, [first]); await f.notices.restore();
  assert.equal(f.notices.getState().changed, false); assert.equal(f.requests.length, 1);
});

test('后台保留记录有32项上限，未知会话不读不记', async () => {
  const f = fixture(); f.event(first, b); assert.equal(f.requests.length, 0);
  f.sessions.set(b, Array.from({ length: 33 }, (_, index) => `session-${index}`)); f.event(first, b);
  f.notices.setScope({ ...scope, contactId: b, sessionId: 'session-0', scopeRevision: 4 });
  await f.notices.restore(); assert.equal(f.requests.length, 0);
  f.notices.setScope({ ...scope, contactId: b, sessionId: 'session-1', scopeRevision: 4 });
  const restoring = f.notices.restore(); await f.page(0, [first]); await restoring;
  assert.equal(f.notices.getState().changed, true);
});
