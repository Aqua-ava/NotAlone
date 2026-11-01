import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { SqliteStorage } from '../../backend-ts/src/storage/sqlite/client.ts';
import { ActiveHolders } from '../../backend-ts/src/storage/sqlite/deletion/holders.ts';
import { ManagedFiles } from '../../backend-ts/src/storage/sqlite/deletion/managed-files.ts';
import { DeletionService } from '../../backend-ts/src/storage/sqlite/deletion/service.ts';
import { SqliteDeletionHttp } from '../../backend-ts/src/storage/sqlite/deletion/http.ts';
import { ContactMetadataLifetime } from '../../backend-ts/src/storage/sqlite/deletion/contact-metadata.ts';

const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-contact-deletion-http-')));
after(() => rm(temporary, { recursive: true, force: true }));
const bundled = await build({ stdin: { contents: `
export {ContactDeletionController} from './src/main/contact-deletion/controller';
export {ContactSession} from './src/main/contacts/session';
export {readContactDirectory} from './src/main/contacts/directory';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
await (await import('node:fs/promises')).writeFile(path.join(temporary, 'main.mjs'), bundled.outputFiles[0].text);
const { ContactDeletionController, ContactSession, readContactDirectory } = await import(path.join(temporary, 'main.mjs'));

test('真实SQLite联系人删除HTTP投影被main接受，重放旧ID幂等且保留其他联系人', async t => {
  const userData = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-contact-deletion-data-')));
  const ownerId = '00000000-0000-4000-8000-000000000055';
  const evidence = { externalKey: 'synthetic-account', identityScheme: 'wechat.account.v1',
    sourceGeneration: 'source-1', assurance: 'verified', supportProfile: 'synthetic-metadata-v1' };
  let server;
  let storage;
  let metadata;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await metadata?.close();
    await storage?.close();
    await rm(userData, { recursive: true, force: true });
  });
  storage = await SqliteStorage.open({ userData, intent: 'create', role: 'test' });
  const holders = new ActiveHolders();
  let closed = 0;
  metadata = new ContactMetadataLifetime(storage, ownerId, holders, () => ({
    account: async () => evidence,
    sessions: async () => [
      { externalKey: 'synthetic-a', displayName: '合成甲', kind: 'private', identityAssurance: 'verified' },
      { externalKey: 'synthetic-b', displayName: '合成乙', kind: 'private', identityAssurance: 'verified' },
    ],
    close: async () => { closed++; },
  }));
  await metadata.initialize();
  const deletion = new DeletionService(storage, holders, new ManagedFiles(userData), { drainTimeoutMs: 100 });
  const deletionHttp = new SqliteDeletionHttp(deletion, ownerId);
  server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer synthetic-http-test') { res.writeHead(401).end(); return; }
    if (!await deletionHttp.handle(req, res) && !await metadata.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let generation = 1;
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const requests = [];
  let loseNextDeleteResponse = false;
  // 保留 BackendHost 的 generation / listener / JSON 调用边界，只替换已认证的 loopback HTTP 传输。
  const backend = {
    getConnectionGeneration: () => generation,
    onStateChanged() { return () => {}; },
    async requestJson(request) {
      const acceptedGeneration = generation;
      requests.push({ method: request.method, path: request.path });
      const response = await fetch(endpoint + request.path, {
        method: request.method,
        headers: { authorization: 'Bearer synthetic-http-test', 'content-type': 'application/json', ...request.headers },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`synthetic backend HTTP ${response.status}: ${data.error ?? 'unknown'}`);
      if (request.method === 'DELETE' && loseNextDeleteResponse) {
        loseNextDeleteResponse = false;
        throw new Error('synthetic lost DELETE response after server commit');
      }
      return { generation: acceptedGeneration, data };
    },
  };
  const direct = async (method, route, body, headers = {}) => {
    const response = await fetch(endpoint + route, { method,
      headers: { authorization: 'Bearer synthetic-http-test', 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };

  const candidate = (await direct('POST', '/api/setup/wechat/detect', {})).body;
  assert.equal((await direct('POST', '/api/setup/wechat/confirm', { candidate_token: candidate.candidate_token,
    confirmed: true, mode: 'selected', history_authorized: false })).status, 200);
  const snapshot = (await direct('GET', '/api/sync/cli-sessions', undefined,
    { 'x-notalone-metadata-consent': 'selected-list' })).body;
  assert.equal(snapshot.sessions.length, 2);
  assert.equal((await direct('POST', '/api/sync/cli-bindings/confirm', { snapshot_token: snapshot.snapshot_token,
    history_authorized: true, selections: snapshot.sessions.map(row => ({ locator: row.username,
      observed_display_name: row.display_name, expected_selection_generation: row.selection_generation })) })).status, 200);

  const contacts = new ContactSession(() => readContactDirectory(backend));
  contacts.setConnection(generation);
  await contacts.refreshContacts();
  const initial = contacts.getState();
  const first = initial.contacts.find(row => row.displayName === '合成甲');
  const sibling = initial.contacts.find(row => row.displayName === '合成乙');
  assert.ok(first && sibling);
  contacts.selectContact({ contactId: first.contactId, scopeRevision: initial.scopeRevision });

  const controller = new ContactDeletionController(backend, contacts);
  t.after(() => controller.dispose());
  await controller.refresh();
  loseNextDeleteResponse = true;
  await controller.delete({ contactId: first.contactId, scopeRevision: contacts.getState().scopeRevision, confirmed: true });

  let unknown = controller.getState().operations.find(item => item.contactId === first.contactId);
  assert.ok(unknown);
  assert.equal(unknown.phase, 'unconfirmed');
  assert.equal(unknown.operationId, null);
  assert.equal(contacts.getState().selectedContactId, null);
  assert.deepEqual(contacts.getState().contacts.map(row => row.contactId), [sibling.contactId]);
  await controller.retry({ id: unknown.id, scopeRevision: controller.getState().scopeRevision, confirmed: true });

  const completed = controller.getState().operations.find(item => item.phase === 'completed');
  assert.ok(completed);
  assert.ok(completed.operationId);
  assert.equal(completed.contactId, null);
  assert.equal(completed.displayName, null);
  assert.equal(controller.getState().busyId, null);
  assert.equal(contacts.getState().selectedContactId, null);
  assert.deepEqual(contacts.getState().contacts.map(row => row.contactId), [sibling.contactId]);
  assert.equal(closed, 1);
  assert.deepEqual(requests.filter(request => request.method === 'DELETE').map(request => request.path), [
    `/api/contacts/${first.contactId}`, `/api/contacts/${first.contactId}`,
  ]);
  assert.equal((await direct('GET', `/api/deletions/${completed.operationId}`)).body.state, 'completed');
  assert.deepEqual((await direct('GET', '/api/contacts')).body.contacts.map(row => row.contact_id), [sibling.contactId]);
});
