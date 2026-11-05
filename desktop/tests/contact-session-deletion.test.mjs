import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const built = await build({ stdin: { contents: `export { ContactSession } from './src/main/contacts/session';
export { ContactDeletionQuiet } from './src/main/contacts/deletion-quiet';`,
  resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { ContactSession, ContactDeletionQuiet } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const c = '33333333-3333-4333-8333-333333333333';
const directory = () => [a, b, c].map((contactId, index) => ({ contactId, displayName: `合成联系人${index + 1}`,
  messageCount: 0, sourceCount: 0 }));
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

async function fixture(t, reader) {
  const session = new ContactSession(reader ?? (async () => ({ generation: 7, contacts: directory() })));
  session.setConnection(7);
  await session.refreshContacts();
  t.after(() => session.setConnection(undefined));
  return session;
}

test('删除发起后只撤下目标联系人，其他联系人的选中项与草稿保留', async t => {
  const session = await fixture(t);
  session.selectContact({ contactId: b, scopeRevision: session.getState().scopeRevision });
  session.setDraft({ contactId: b, scopeRevision: session.getState().scopeRevision, text: '合成草稿乙' });
  const before = session.getState();
  session.removeContact(a);
  const after = session.getState();
  assert.deepEqual(after.contacts.map(contact => contact.contactId), [b, c]);
  assert.equal(after.selectedContactId, b);
  assert.equal(after.draft, '合成草稿乙');
  assert.equal(after.scopeRevision, before.scopeRevision, '未选中对象失效不应连带其他联系人');
  assert.equal(after.directoryPhase, 'ready');
});

test('删除当前选中联系人时只清除这一位的选择、草稿和范围', async t => {
  const session = await fixture(t);
  session.selectContact({ contactId: a, scopeRevision: session.getState().scopeRevision });
  session.setDraft({ contactId: a, scopeRevision: session.getState().scopeRevision, text: '合成草稿甲' });
  const scopeRevision = session.getState().scopeRevision;
  session.removeContact(a);
  const state = session.getState();
  assert.deepEqual(state.contacts.map(contact => contact.contactId), [b, c]);
  assert.equal(state.selectedContactId, null);
  assert.equal(state.draft, '');
  assert.equal(state.scopeRevision, scopeRevision + 1);
});

test('后台刷新失败保留现有目录、选中项与草稿，不进入错误态', async t => {
  let rosterClosed = false;
  const session = await fixture(t, async () => {
    if (rosterClosed) throw new Error('synthetic_roster_closed');
    return { generation: 7, contacts: directory() };
  });
  session.selectContact({ contactId: b, scopeRevision: session.getState().scopeRevision });
  session.setDraft({ contactId: b, scopeRevision: session.getState().scopeRevision, text: '合成草稿乙' });
  rosterClosed = true;
  assert.equal(await session.refreshContactsInBackground(), false);
  const state = session.getState();
  assert.equal(state.directoryPhase, 'ready');
  assert.deepEqual(state.contacts.map(contact => contact.contactId), [a, b, c]);
  assert.equal(state.selectedContactId, b);
  assert.equal(state.draft, '合成草稿乙');
  // 明确刷新仍按原规则显示失败；删除路径不能使用这条会清空目录的读取。
  await session.refreshContacts();
  assert.equal(session.getState().directoryPhase, 'error');
  assert.deepEqual(session.getState().contacts, []);
});

test('删除期间迟到的目录读取不能把已撤下的联系人重新加回', async t => {
  const reads = [];
  const session = new ContactSession(() => new Promise(resolve => reads.push(resolve)));
  session.setConnection(7);
  reads[0]({ generation: 7, contacts: directory() });
  await flush();
  assert.equal(session.getState().directoryPhase, 'ready');
  const delayed = session.refreshContacts();
  assert.equal(session.getState().directoryPhase, 'loading');
  session.removeContact(a);
  assert.equal(session.getState().directoryPhase, 'ready', '撤下对象时用现有列表收敛为可读状态');
  assert.deepEqual(session.getState().contacts.map(contact => contact.contactId), [b, c]);
  reads[1]({ generation: 7, contacts: directory() });
  await delayed;
  await flush();
  assert.deepEqual(session.getState().contacts.map(contact => contact.contactId), [b, c], '迟到读取不能恢复已撤下的对象');
  assert.equal(session.getState().directoryPhase, 'ready');
});

test('删除窗口只在最后一个窗口结束时补读一次，重复结束不重复补读', () => {
  const quiet = new ContactDeletionQuiet();
  const reads = [];
  assert.equal(quiet.defer(() => reads.push('window外')), false);
  const endOuter = quiet.begin();
  const endInner = quiet.begin();
  const read = () => reads.push('补读');
  assert.equal(quiet.defer(read), true);
  assert.equal(quiet.defer(read), true);
  endInner(); endInner();
  assert.equal(quiet.deleting, true);
  assert.deepEqual(reads, []);
  endOuter();
  assert.equal(quiet.deleting, false);
  assert.deepEqual(reads, ['补读'], '同一读取函数在一个窗口内只补读一次');
});

test('补读抛错不影响其他补读或窗口结束', () => {
  const quiet = new ContactDeletionQuiet();
  const reads = [];
  const end = quiet.begin();
  quiet.defer(() => { throw new Error('合成补读失败'); });
  quiet.defer(() => reads.push('另一读取'));
  end();
  assert.equal(quiet.deleting, false);
  assert.deepEqual(reads, ['另一读取']);
});

test('删除窗口内完整刷新失败保留目录、选择与草稿，窗口结束时后台补读一次', async t => {
  const quiet = new ContactDeletionQuiet();
  let closed = false, reads = 0;
  const session = new ContactSession(async () => {
    reads++;
    if (closed) throw new Error('synthetic_roster_closed');
    return { generation: 7, contacts: directory() };
  }, quiet);
  t.after(() => session.setConnection(undefined));
  session.setConnection(7);
  await session.refreshContacts();
  session.selectContact({ contactId: b, scopeRevision: session.getState().scopeRevision });
  session.setDraft({ contactId: b, scopeRevision: session.getState().scopeRevision, text: '合成草稿乙' });
  const before = session.getState();
  const finish = quiet.begin();
  closed = true;
  await session.refreshContacts();
  await flush();
  const during = session.getState();
  assert.equal(during.directoryPhase, 'ready', '删除窗口内失败恢复可展示状态，不清空目录');
  assert.deepEqual(during.contacts.map(contact => contact.contactId), [a, b, c]);
  assert.equal(during.selectedContactId, b);
  assert.equal(during.draft, '合成草稿乙');
  assert.equal(during.scopeRevision, before.scopeRevision);
  // 窗口结束前重新取基线，确认窗口结束的补读确实发生。
  const baseline = reads;
  closed = false;
  finish();
  await flush();
  assert.equal(reads, baseline + 1, '窗口结束时后台补读一次');
  assert.equal(session.getState().directoryPhase, 'ready');
});

test('删除窗口结束且目录尚未可读时做完整刷新恢复目录', async t => {
  const quiet = new ContactDeletionQuiet();
  let closed = true, reads = 0;
  const session = new ContactSession(async () => {
    reads++;
    if (closed) throw new Error('synthetic_roster_closed');
    return { generation: 7, contacts: directory() };
  }, quiet);
  t.after(() => session.setConnection(undefined));
  session.setConnection(7);
  await flush();
  assert.equal(session.getState().directoryPhase, 'error');
  const finish = quiet.begin();
  closed = false;
  const baseline = reads;
  finish();
  await flush();
  assert.equal(reads, baseline + 1, '非 ready 时窗口结束做一次完整刷新');
  assert.equal(session.getState().directoryPhase, 'ready');
  assert.deepEqual(session.getState().contacts.map(contact => contact.contactId), [a, b, c]);
});
