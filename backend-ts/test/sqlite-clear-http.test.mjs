import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SqliteHistoryClearHttp, clearQueryAllowed, projectClearStatus, projectResyncStatus } from '../src/history/sqlite/clear-http.ts';
import { createWechatHistoryChannel } from '../src/history/sqlite/wechat-channel.ts';
import { owner, fixture, identity, record, buildCandidate } from './sqlite-clear-support.mjs';

async function serve(t, handler) {
  const server = createServer(async (req, res) => { if (!await handler.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('清空/重读HTTP只投影状态与原因，不泄露边界证明或渠道范围', () => {
  const clear = projectClearStatus({
    contactId: owner, operationId: 'op-1', operationState: 'blocked', phase: 'boundary_pending', completed: false,
    boundary: { conversationId: 'conversation-1', barrierGeneration: '3', state: 'pending', operationId: 'op-1',
      manifestSha256: 'c'.repeat(64), memberCount: 42, boundaryToken: 'boundary-proof-token', reason: 'read_not_authorized', establishedAt: null },
    failureCode: 'history_boundary_required', boundaryReason: 'read_not_authorized',
    storedMessages: 0, storedSources: 0, openGoals: 0,
  });
  assert.equal(clear.phase, 'boundary_pending');
  assert.equal(clear.completed, false);
  assert.equal(clear.boundary_pending, true);
  assert.equal(clear.boundary.state, 'pending');
  const serialized = JSON.stringify(clear);
  assert.equal(serialized.includes('boundary-proof-token'), false);
  assert.equal(serialized.includes('conversation-1'), false);
  const resync = projectResyncStatus({ contactId: owner, requestKey: 'resync-1', state: 'active', completed: false,
    authorizationId: 'auth-1', grantId: 'grant-1', cutoffOperationId: 'op-1', barrierGeneration: '3', goalId: 'goal-1', goalState: 'running',
    coverage: { goalId: 'goal-1', contactId: owner, bindingId: 'binding-1', phase: 'running', failureCode: null, cursor: 'opaque-cursor',
      messageCount: 4, nonTextCount: 1, pageCount: 2, quarantinedCount: 0 }, completed: false });
  assert.equal(resync.goal.message_count, 3);
  assert.equal(resync.goal.non_text_count, 1);
  assert.equal(JSON.stringify(resync).includes('opaque-cursor'), false);
});

test('宿主查询门只放行固定清空/重读路径，拒绝查询串和任意路由', () => {
  const url = value => new URL(value, 'http://localhost');
  assert.equal(clearQueryAllowed('GET', url(`/api/contacts/${owner}/history/clear`)), true);
  assert.equal(clearQueryAllowed('POST', url(`/api/contacts/${owner}/history/resync`)), true);
  assert.equal(clearQueryAllowed('GET', url(`/api/contacts/${owner}/history/clear?x=1`)), false);
  assert.equal(clearQueryAllowed('PUT', url(`/api/contacts/${owner}/history/clear`)), false);
  assert.equal(clearQueryAllowed('GET', url('/api/contacts/not-a-uuid/history/clear')), false);
  assert.equal(clearQueryAllowed('GET', url('/api/contacts')), false);
});

test('正式清空/重读HTTP端点走正常服务入口，非法请求不触发读取', async t => {
  const f = await fixture(t);
  const contact = f.contactA;
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2')];
  f.state.boundaryMembers = [identity('shard-a', '1'), identity('shard-a', '2')];
  await f.current.history.synchronize(contact);
  const http = new SqliteHistoryClearHttp(f.current.clear, f.current.resync);
  const base = await serve(t, http);
  const getClear = async () => (await fetch(`${base}/api/contacts/${contact}/history/clear`)).json();
  const getResync = async () => (await fetch(`${base}/api/contacts/${contact}/history/resync`)).json();
  assert.equal((await getClear()).phase, 'none');
  assert.equal((await getResync()).state, 'none');
  const boundaryCalls = f.state.boundaryCalls;
  const invalid = await fetch(`${base}/api/contacts/${contact}/history/clear`, { method: 'POST', body: JSON.stringify({ scope: 'contact' }) });
  assert.equal(invalid.status, 400);
  assert.equal(f.state.boundaryCalls, boundaryCalls, '非法请求不读取边界');
  const cleared = await fetch(`${base}/api/contacts/${contact}/history/clear`, { method: 'POST', body: '{}' });
  assert.equal(cleared.status, 200);
  const clearedBody = await cleared.json();
  assert.equal(clearedBody.phase, 'completed');
  assert.equal(clearedBody.completed, true);
  assert.equal(clearedBody.boundary.member_count, 2);
  assert.equal((await f.current.history.read(contact)).messages.length, 0);
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2'), record('shard-b', '9')];
  const badKey = await fetch(`${base}/api/contacts/${contact}/history/resync`, { method: 'POST', body: JSON.stringify({ request_key: '../bad key' }) });
  assert.equal(badKey.status, 400);
  const restored = await fetch(`${base}/api/contacts/${contact}/history/resync`, { method: 'POST', body: JSON.stringify({ request_key: 'resync-http-1' }) });
  assert.equal(restored.status, 200);
  const restoredBody = await restored.json();
  assert.equal(restoredBody.state, 'completed');
  assert.equal(restoredBody.goal.message_count, 3, '重叠消息去重后恢复本机可读历史');
  assert.equal((await f.current.history.read(contact)).messages.length, 3);
  assert.equal((await getClear()).completed, true);
});

test('正式微信适配器未配置读取工具时，正文目标和边界能力均保持拒绝', async t => {
  const channel = createWechatHistoryChannel();
  t.after(() => channel.close());
  const scope = { token: {}, accountKey: 'unverified', conversationKey: 'unverified' };
  const report = await channel.inspect(scope);
  assert.equal(report.status, 'unverified');
  await assert.rejects(channel.target(scope), { code: 'history_support_unverified' });
  assert.equal(typeof channel.boundarySnapshot, 'function');
  await assert.rejects(channel.boundarySnapshot(scope), { code: 'history_support_unverified' });
});
