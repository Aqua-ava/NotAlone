import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const owned = await mkdtemp(join(tmpdir(), 'notalone-session-recovery-'));
after(() => rm(owned, { recursive: true, force: true }));
const outfile = join(owned, 'session.mjs');
await build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { ReplySession } from './src/main/reply/session';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile });
const { ContactSession, ReplySession } = await import(pathToFileURL(outfile).href);

async function fixture(t) {
  const contactId = randomUUID(), sessionId = randomUUID(), requests = [];
  const control = { failSnapshot: false, failContinue: false, catalogGate: undefined, snapshotGate: undefined, continueGate: undefined,
    snapshotReads: 0, snapshotGateAt: undefined, text: null };
  const backend = { getConnectionGeneration: () => 7, onStateChanged: () => () => {}, subscribeMessages() {},
    requestJson: async request => {
      requests.push(request); let data;
      if (request.path.startsWith('/api/deletions?')) data = { operations: [] };
      else if (request.path.endsWith('/assistant-sessions')) {
        const gate = control.catalogGate; control.catalogGate = undefined;
        if (gate) { gate.entered.resolve(); await gate.release.promise; }
        data = { sessions: [{ session_id: sessionId, is_current: true }], current_session_id: sessionId };
      } else if (request.path.endsWith('/continue')) {
        const gate = control.continueGate; control.continueGate = undefined;
        if (gate) { gate.entered.resolve(); await gate.release.promise; }
        if (control.failContinue) throw new Error('合成继续回执丢失');
        data = { session_id: sessionId };
      } else if (request.path.endsWith('/assistant-session/binding')) data = { confirmed: true };
      else if (request.path.includes('/history-messages?')) data = { messages: [], next_cursor: null };
      else if (request.path.endsWith(`/assistant-sessions/${sessionId}`)) {
        const text = control.text;
        ++control.snapshotReads;
        const gate = control.snapshotGateAt === undefined || control.snapshotReads === control.snapshotGateAt ? control.snapshotGate : undefined;
        if (gate) control.snapshotGate = undefined;
        if (gate) { gate.entered.resolve(); await gate.release.promise; }
        if (control.failSnapshot) throw new Error('合成只读快照暂不可用');
        data = { mode: 'sqlite', session_id: sessionId, runtime_recovery: 'ready', entries: text === null ? [] : [
          { entry_id: randomUUID(), position: '1', role: 'user', text, request_id: randomUUID(), call_id: null, content_state: 'available' }] };
      } else throw new Error(`未安排的合成端口：${request.path}`);
      return { generation: 7, data };
    } };
  const contacts = new ContactSession(async () => ({ generation: 7,
    contacts: [{ contactId, displayName: '合成联系人', messageCount: 0, sourceCount: 0 }] }));
  contacts.setConnection(7); await contacts.refreshContacts();
  const replies = new ReplySession(contacts, backend);
  t.after(() => contacts.setConnection(undefined));
  contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
  const scope = { contactId, scopeRevision: contacts.getState().scopeRevision };
  await replies.readSavedSession(scope);
  return { replies, contacts, scope, sessionId, control, requests };
}

test('只读回看失败不会冒充会话变更待确认，重新核对保留本次独立草稿', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.contacts.setDraft({ ...f.scope, text: '尚未提交的合成想法' });
  f.control.failSnapshot = true;
  await f.replies.viewSavedSession({ ...f.scope, sessionId: f.sessionId });
  assert.equal(Boolean(f.replies.getState().sessionCatalog.selectionPending), false, 'GET失败没有未知写入');
  assert.equal(f.replies.getState().sessionCatalog.phase, 'failed');
  f.control.failSnapshot = false;
  await f.replies.viewSavedSession({ ...f.scope, sessionId: f.sessionId });
  assert.equal(f.contacts.getState().draft, '尚未提交的合成想法', '只读核对不能清除独立草稿');
  assert.equal(f.replies.getState().savedSession.phase, 'ready');
  assert.equal(f.replies.getState().sessionCatalog.selectionPending, false);
  assert.equal(f.requests.some(request => request.method === 'POST'), false, '恢复不得续期、创建会话或生成');
});

test('聊天清空开始即撤销在途回看，迟到的旧正文不能在结算前复活', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.control.text = '必须撤下的合成讨论正文';
  const gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  t.after(() => gate.release.resolve()); f.control.snapshotGate = gate;
  const viewing = f.replies.viewSavedSession({ ...f.scope, sessionId: f.sessionId }); await gate.entered.promise;
  const settle = f.replies.beginHistoryClear();
  assert.equal(f.requests.at(-1).signal.aborted, true, '聊天清空开始即撤销旧读取');
  f.control.text = null; gate.release.resolve(); await viewing;
  assert.equal(JSON.stringify(f.replies.getState()).includes('必须撤下的合成讨论正文'), false);
  await settle();
  assert.equal(f.replies.getState().savedSession.phase, 'ready');
  assert.deepEqual(f.replies.getState().savedSession.discussionEntries, []);
  assert.equal(f.replies.getState().sessionCatalog.selectionPending, false);
});

test('真正继续操作结果不明仍阻止生成，刷新或失败的回看不能解除，只读核对成功才恢复', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  t.after(() => gate.release.resolve()); f.control.continueGate = gate;
  const continuing = f.replies.resumeSavedSession({ ...f.scope, sessionId: f.sessionId }); await gate.entered.promise;
  await f.replies.beginHistoryClear()();
  gate.release.resolve(); await continuing;
  assert.equal(f.replies.getState().sessionCatalog.selectionPending, true);
  await f.replies.listSavedSessions(f.scope);
  assert.equal(f.replies.getState().sessionCatalog.selectionPending, true, '只有目录成功不足以放行');
  f.control.failSnapshot = true;
  await f.replies.viewSavedSession({ ...f.scope, sessionId: f.sessionId });
  assert.equal(f.replies.getState().sessionCatalog.selectionPending, true, '失败的只读核对不能取消真正的未知写入');
  f.control.failSnapshot = false;
  await f.replies.viewSavedSession({ ...f.scope, sessionId: f.sessionId });
  assert.equal(f.replies.getState().sessionCatalog.selectionPending, false);
  assert.equal(f.replies.getState().savedSession.phase, 'ready');
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1, '恢复不得自动重发写请求');
});

test('聊天清空后权威读取失败保持旧正文撤下，允许直接只读重试', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.control.text = '来源复验前的合成旧正文';
  await f.replies.readSavedSession(f.scope);
  const gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  t.after(() => gate.release.resolve()); f.control.catalogGate = gate;
  const listing = f.replies.listSavedSessions(f.scope); await gate.entered.promise;
  f.control.failSnapshot = true;
  await f.replies.beginHistoryClear()();
  gate.release.resolve(); await listing;
  assert.equal(JSON.stringify(f.replies.getState()).includes('来源复验前的合成旧正文'), false);
  assert.equal(f.replies.getState().savedSession.phase, 'failed');
  assert.equal(f.replies.getState().sessionCatalog.selectionPending, false);
  f.control.failSnapshot = false; f.control.text = null;
  await f.replies.viewSavedSession({ ...f.scope, sessionId: f.sessionId });
  assert.equal(f.replies.getState().savedSession.phase, 'ready');
  assert.deepEqual(f.replies.getState().savedSession.discussionEntries, []);
});

test('自动恢复正文等待时断开连接，旧复验正常结算且不发出旧范围目录请求', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const catalogGate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  const snapshotGate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  t.after(() => { catalogGate.release.resolve(); snapshotGate.release.resolve(); });
  f.control.catalogGate = catalogGate;
  const listing = f.replies.listSavedSessions(f.scope); await catalogGate.entered.promise;
  const settle = f.replies.beginHistoryClear();
  f.control.snapshotGate = snapshotGate;
  f.control.snapshotGateAt = f.control.snapshotReads + 1;
  const settling = settle(); await snapshotGate.entered.promise;
  f.contacts.setConnection(undefined);
  const before = f.requests.length;
  snapshotGate.release.resolve();
  await assert.doesNotReject(settling);
  catalogGate.release.resolve(); await listing;
  assert.equal(f.requests.length, before);
  assert.equal(f.replies.getState().contactId, null);
});

test('聊天清空打断只读列表后自动重读目录与正文，不留下待确认锁', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.contacts.setDraft({ ...f.scope, text: '资料更新期间保留的合成想法' });
  const gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  t.after(() => gate.release.resolve()); f.control.catalogGate = gate;
  const listing = f.replies.listSavedSessions(f.scope); await gate.entered.promise;
  const settle = f.replies.beginHistoryClear();
  await settle();
  gate.release.resolve(); await listing;
  assert.equal(f.replies.getState().sessionCatalog.selectionPending, false, '只读被取消不代表选择结果未知');
  assert.equal(f.replies.getState().sessionCatalog.phase, 'ready');
  assert.equal(f.replies.getState().savedSession.phase, 'ready', '复验必须完成新权威读取');
  assert.equal(f.contacts.getState().draft, '资料更新期间保留的合成想法');
  assert.equal(f.requests.some(request => request.method === 'POST'), false);
});
