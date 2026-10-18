import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

const ports = build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { ReplySession } from './src/main/reply/session';
  export { BackendRequestFailure } from './src/main/backend/json-client';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false })
  .then(output => import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`));

async function fixture(t) {
  const { ContactSession, ReplySession, BackendRequestFailure } = await ports;
  const ids = Array.from({ length: 3 }, () => randomUUID());
  const sessions = new Map(ids.map(id => [id, randomUUID()]));
  const requests = [], listeners = new Set();
  let generation = 7;
  const control = { barrier: undefined, missing: new Set(), block: null };
  const backend = {
    getConnectionGeneration: () => generation,
    onStateChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeMessages: observer => observer.connected(),
    requestJson: async request => {
      requests.push(request);
      const id = request.path.split('/')[3];
      await control.barrier?.(request);
      if (control.missing.has(id)) throw new BackendRequestFailure('response', 404, 'not_found');
      if (request.path.endsWith('/selections')) return { generation: 7, data: { selection: null } };
      return { generation: 7, data: request.path.endsWith('/assistant-session/default')
        ? { session_id: sessions.get(id) }
        : { session_id: sessions.get(id), current_input_version_id: null, turns: [], inputs: [] } };
    },
  };
  const contacts = new ContactSession(async () => ({ generation: 7,
    contacts: ids.map((contactId, i) => ({ contactId, displayName: `合成联系人${i}`, messageCount: 0, sourceCount: 0 })) }));
  contacts.setConnection(7); await contacts.refreshContacts();
  const replies = new ReplySession(contacts, backend, () => control.block);
  t.after(() => { generation++; for (const listener of listeners) listener(); });
  const select = contactId => { contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
    return { contactId, scopeRevision: contacts.getState().scopeRevision }; };
  const ready = contactId => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('内容恢复未在有界时间完成')); }, 1500);
    const unsubscribe = replies.onStateChanged(state => {
      if (state.contactId === contactId && state.savedSession?.phase === 'ready') {
        clearTimeout(timer); unsubscribe(); resolve(state);
      }
    });
  });
  return { ids, sessions, requests, control, contacts, replies, select, ready };
}

test('快速 A→B→C 立即显示最后联系人，仅稳定后的 C 读取讨论', async t => {
  const f = await fixture(t); const [a, b, c] = f.ids;
  f.control.block = 'foreground-confirmation-required'; f.replies.refreshGenerationEligibility();
  f.select(a); f.select(b); f.select(c);
  assert.equal(f.replies.getState().contactId, c);
  f.control.block = null; f.replies.refreshGenerationEligibility();
  assert.equal(f.replies.getState().savedSession.phase, 'loading');
  assert.equal(f.requests.length, 0, '短暂途经的联系人不应立即读取讨论');
  await f.ready(c);
  assert.ok(f.requests.length > 0);
  assert.ok(f.requests.every(request => request.path.includes(c)));
});

test('显式读取立即执行，B 迟到结果不能覆盖 C', async t => {
  const f = await fixture(t); const [, b, c] = f.ids;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.control.barrier = request => request.path.includes(b) ? gate : undefined;
  const bScope = f.select(b);
  const reading = f.replies.readSavedSession(bScope);
  assert.equal(f.requests.length, 1, '明确读取不经过稳定等待');
  const cScope = f.select(c);
  await f.replies.readSavedSession(cScope);
  release(); await reading;
  assert.equal(f.replies.getState().contactId, c);
  assert.equal(f.replies.getState().savedSession.sessionId, f.sessions.get(c));
});


test('切回 A 复用草稿缓存，但已删除讨论不会恢复旧输入', async t => {
  const f = await fixture(t); const [a, b] = f.ids;
  const first = f.select(a); await f.replies.readSavedSession(first);
  f.contacts.setDraft({ ...first, text: '合成未提交草稿' });
  await f.replies.updateRequirements({ ...first, requirements: '合成临时要求' });
  await f.replies.readSavedSession(f.select(b));
  f.select(a); await f.ready(a);
  assert.equal(f.contacts.getState().draft, '合成未提交草稿');
  assert.equal(f.replies.getState().requirements, '合成临时要求');
  await f.replies.readSavedSession(f.select(b));
  f.control.missing.add(a);
  await f.replies.readSavedSession(f.select(a));
  assert.equal(f.replies.getState().savedSession.phase, 'failed');
  assert.equal(f.contacts.getState().draft, '');
  assert.equal(f.replies.getState().requirements, '');
});
