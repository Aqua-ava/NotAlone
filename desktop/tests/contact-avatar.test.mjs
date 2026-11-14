import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
const bundle = await build({ stdin: { contents: "export * from './src/main/contacts/avatar';export { contactSummaries } from './src/main/contacts/directory';export { ContactSession } from './src/main/contacts/session';export { JsonClient } from './src/main/backend/json-client';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { parseContactAvatar, readContactAvatar, contactSummaries, ContactSession, JsonClient } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const payload = { avatar: { mime_type: 'image/png', base64: png.toString('base64') } };
const contactId = '00000000-0000-4000-8000-000000000001';

test('联系人目录传递本地头像内容版本，缺图到保存后的变化可供页面跟随', () => {
  const contact = { contact_id: contactId, display_name: '合成联系人', data_status: { message_count: 0, source_count: 0 } };
  assert.equal(contactSummaries({ contacts: [{ ...contact, avatar_revision: null }] })[0].avatarRevision, '');
  assert.equal(contactSummaries({ contacts: [{ ...contact, avatar_revision: 'saved-1' }] })[0].avatarRevision, 'saved-1');
  assert.throws(() => contactSummaries({ contacts: [{ ...contact, avatar_revision: 1 }] }), /目录不可用/);
});

test('头像仅接受有限、规范的位图字节；缺失头像正常返回空', () => {
  assert.equal(parseContactAvatar({ avatar: null }), null);
  assert.deepEqual(parseContactAvatar(payload), { mimeType: 'image/png', dataBase64: png.toString('base64') });
  const maximum = Buffer.alloc(256 * 1024); png.copy(maximum);
  assert.equal(parseContactAvatar({ avatar: { mime_type: 'image/png', base64: maximum.toString('base64') } }).dataBase64.length, 349528);
  for (const avatar of [
    { mime_type: 'image/svg+xml', base64: Buffer.from('<svg/>').toString('base64') },
    { mime_type: 'image/png', base64: Buffer.from('<html>not an image</html>').toString('base64') },
    { ...payload.avatar, base64: `${payload.avatar.base64}\n` },
    { ...payload.avatar, url: 'https://example.invalid/avatar' },
    { ...payload.avatar, base64: Buffer.alloc(256 * 1024 + 1).toString('base64') },
  ]) assert.throws(() => parseContactAvatar({ avatar }), /暂不可用/);
});

async function harness() {
  let generation = 4, contactRows = [{ contactId, displayName: '合成联系人', messageCount: 1, sourceCount: 0 }];
  const contacts = new ContactSession(async () => ({ generation, contacts: contactRows }));
  contacts.setConnection(generation); await contacts.refreshContacts();
  let release;
  const calls = [];
  const backend = { getConnectionGeneration: () => generation, requestJson: async request => {
    calls.push(request); await new Promise(resolve => { release = resolve; }); return { generation: 4, data: payload };
  } };
  return { contacts, backend, calls, selection: { contactId, scopeRevision: contacts.getState().scopeRevision },
    release: () => release(), reconnect: () => { generation++; }, remove: async () => { contactRows = []; await contacts.refreshContacts(); } };
}

test('仅为目录中指定联系人请求头像，不依赖当前选中对象', async () => {
  const h = await harness();
  const reading = readContactAvatar(h.backend, h.contacts, h.selection); h.release();
  assert.equal((await reading).mimeType, 'image/png');
  assert.equal(h.calls[0].path, `/api/contacts/${contactId}/avatar`);
  assert.equal(h.calls[0].method, 'GET');
  await assert.rejects(readContactAvatar(h.backend, h.contacts, { ...h.selection, contactId: '00000000-0000-4000-8000-000000000002' }), /暂不可用/);
  assert.equal(h.calls.length, 1);
});

test('连接、读取范围或联系人删除使未完成头像失效', async () => {
  for (const invalidate of [h => h.reconnect(), h => h.contacts.invalidateReadingScope(), h => h.remove()]) {
    const h = await harness();
    const reading = readContactAvatar(h.backend, h.contacts, h.selection);
    await invalidate(h); h.release();
    await assert.rejects(reading, /暂不可用/);
  }
});

test('通过正常桌面 HTTP 客户端直接读取已同步的本地头像', async t => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  const client = new JsonClient({ address: `127.0.0.1:${port}`, port, token: 'synthetic-avatar-token', pid: process.pid });
  t.after(() => client.cancelPending());
  const contacts = new ContactSession(async () => ({ generation: 1,
    contacts: [{ contactId, displayName: '合成联系人', messageCount: 0, sourceCount: 0 }] }));
  contacts.setConnection(1); await contacts.refreshContacts();
  const backend = { getConnectionGeneration: () => 1,
    requestJson: async request => ({ generation: 1, data: (await client.perform(request)).data }) };
  const avatar = await readContactAvatar(backend, contacts, { contactId, scopeRevision: contacts.getState().scopeRevision });
  assert.deepEqual(avatar, { mimeType: 'image/png', dataBase64: png.toString('base64') });
  assert.deepEqual(requests, [{ method: 'GET', path: `/api/contacts/${contactId}/avatar` }]);
});
