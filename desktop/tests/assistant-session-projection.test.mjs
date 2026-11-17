import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const bundled = await build({ entryPoints: ['src/main/reply/assistant-session-projection.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false });
const { AssistantSessionProjection } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const scope = { connectionGeneration: 7, contactId: 'contact-a', scopeRevision: 3, sessionId: 'session-a' };
function snapshot(text = '合成讨论正文') {
  return { generation: 7, sessionId: 'session-a', runtimeRecovery: 'ready', discussionEntries: [
    { entryId: 'entry-a', position: '1', role: 'user', text, requestId: 'request-a', callId: null, contentState: 'available' },
  ] };
}
function display(saved = snapshot()) {
  const { generation: _generation, ...content } = saved;
  return { phase: 'ready', ...content };
}

test('SQLite权威回看保留当时发言与恢复状态，较新快照接纳后旧读取不能覆盖', () => {
  const projection = new AssistantSessionProjection();
  projection.registerDisplay(scope, display(), 'authoritative');
  const oldRead = projection.beginRead(scope), newRead = projection.beginRead(scope);
  const newer = snapshot('新核验的合成讨论正文'); newer.runtimeRecovery = 'blocked';
  const accepted = projection.acceptRead(newRead, newer);
  assert.equal(accepted.kind, 'accepted');
  assert.deepEqual(accepted.snapshot.discussionEntries, newer.discussionEntries);
  assert.equal(accepted.snapshot.runtimeRecovery, 'blocked');
  assert.equal(projection.acceptRead(oldRead, snapshot()).kind, 'superseded');
  assert.equal(projection.failRead(oldRead, 'unknown').kind, 'superseded');
});

test('较晚loading与正式快照接管旧读取，普通状态通知不撤销读取', () => {
  const projection = new AssistantSessionProjection();
  projection.registerDisplay(scope, display(), 'authoritative');
  const read = projection.beginRead(scope);
  projection.registerDisplay(scope); assert.equal(projection.isReadCurrent(read), true);
  projection.registerDisplay(scope, { phase: 'loading', sessionId: scope.sessionId });
  assert.equal(projection.acceptRead(read, snapshot()).kind, 'superseded');
  const current = projection.beginRead(scope), accepted = projection.acceptRead(current, snapshot());
  assert.equal(accepted.kind, 'accepted'); assert.equal(projection.isReadCurrent(accepted.read), true);
  projection.registerDisplay(scope, display(snapshot('更新的合成发言')), 'authoritative');
  assert.equal(projection.isReadCurrent(accepted.read), false);
});

for (const failure of ['unknown', 'unavailable']) test(`SQLite回看${failure}失败撤下正文，保留真实失败分类`, () => {
  const projection = new AssistantSessionProjection(); projection.registerDisplay(scope, display(), 'authoritative');
  const failed = projection.failRead(projection.beginRead(scope), failure);
  assert.equal(failed.kind, 'failed'); assert.equal(failed.failure, failure);
  assert.equal(failed.snapshot.phase, 'failed'); assert.equal(failed.snapshot.sessionId, scope.sessionId);
  assert.equal(JSON.stringify(failed.snapshot).includes('合成讨论正文'), false);
});

test('来源撤下后旧读取和迟到失败均失效，新权威读取才恢复正文', () => {
  const projection = new AssistantSessionProjection(); projection.registerDisplay(scope, display(), 'authoritative');
  const old = projection.beginRead(scope); projection.invalidateSource();
  assert.equal(projection.acceptRead(old, snapshot()).kind, 'superseded');
  assert.equal(projection.failRead(old, 'unknown').kind, 'superseded');
  projection.registerDisplay(scope, { phase: 'idle', sessionId: scope.sessionId });
  const actual = projection.acceptRead(projection.beginRead(scope), snapshot('合法的新讨论'));
  assert.equal(actual.kind, 'accepted'); assert.equal(actual.snapshot.discussionEntries[0].text, '合法的新讨论');
});

test('首次目录读取绑定实际SID后可继续恢复，切到其他SID使原读取失效', () => {
  const projection = new AssistantSessionProjection();
  projection.registerDisplay({ ...scope, sessionId: null }, { phase: 'loading', sessionId: null });
  let read = projection.beginRead({ ...scope, sessionId: null }); read = projection.resolveReadSession(read, scope.sessionId);
  const decision = projection.acceptRead(read, snapshot()); assert.equal(decision.kind, 'accepted');
  assert.equal(projection.isReadCurrent(decision.read), true);
  projection.registerDisplay({ ...scope, sessionId: 'session-b' }, { ...display(), sessionId: 'session-b' }, 'authoritative');
  assert.equal(projection.isReadCurrent(decision.read), false);
});

for (const changed of [{ connectionGeneration: 8 }, { contactId: 'contact-b' }, { scopeRevision: 4 }, { sessionId: 'session-b' }, { sessionId: null }]) {
  test(`范围或删除边界变化后迟到正文不能发布：${Object.keys(changed)[0]}=${Object.values(changed)[0]}`, () => {
    const projection = new AssistantSessionProjection(); projection.registerDisplay(scope, display(), 'authoritative');
    const read = projection.beginRead(scope); projection.registerDisplay({ ...scope, ...changed }, { phase: 'idle', sessionId: changed.sessionId ?? null });
    assert.equal(projection.acceptRead(read, snapshot()).kind, 'superseded');
    assert.equal(projection.failRead(read, 'unknown').kind, 'superseded');
  });
}

for (const mismatch of [{ generation: 8 }, { sessionId: 'session-b' }]) test('响应不能借用另一连接或会话的发言', () => {
  const projection = new AssistantSessionProjection(); projection.registerDisplay(scope, display(), 'authoritative');
  assert.equal(projection.acceptRead(projection.beginRead(scope), { ...snapshot(), ...mismatch }).kind, 'superseded');
});

test('来源撤下后的新读取接管，旧票据与迟到失败不能取消新权威快照', () => {
  const projection = new AssistantSessionProjection(); projection.registerDisplay(scope, display(), 'authoritative');
  const old = projection.beginRead(scope); projection.invalidateSource();
  projection.registerDisplay(scope, { phase: 'idle', sessionId: scope.sessionId });
  const read = projection.beginRead(scope), checked = snapshot('重新核验的合法讨论');
  const actual = projection.acceptRead(read, checked); assert.equal(actual.kind, 'accepted');
  assert.equal(projection.isReadCurrent(actual.read), true);
  assert.equal(projection.acceptRead(old, snapshot()).kind, 'superseded');
  assert.equal(projection.failRead(old, 'unknown').kind, 'superseded');
  assert.equal(projection.isReadCurrent(actual.read), true);
});
