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
export {BackendRequestFailure, requestTimeoutLimitMs} from './src/main/backend/json-client';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
await (await import('node:fs/promises')).writeFile(path.join(temporary, 'main.mjs'), bundled.outputFiles[0].text);
const { ContactDeletionController, ContactSession, readContactDirectory, BackendRequestFailure, requestTimeoutLimitMs } = await import(path.join(temporary, 'main.mjs'));

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
  let slowAdvance = false;
  const executeStorage = storage.execute.bind(storage);
  // 合成慢清理：在已 claim 的清理阶段（sealTargets）加延迟，让客户端在服务端清理结束前超时。
  storage.execute = async (name, input, lease) => {
    if (slowAdvance && name === 'deletion.sealTargets') await new Promise(resolve => setTimeout(resolve, 300));
    return executeStorage(name, input, lease);
  };
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
  let loseNextDeleteResponse = false, timeoutNextDelete = false, hideDiscovery = false;
  // 保留 BackendHost 的 generation / listener / JSON 调用边界，只替换已认证的 loopback HTTP 传输。
  const backend = {
    getConnectionGeneration: () => generation,
    onStateChanged() { return () => {}; },
    async requestJson(request) {
      const acceptedGeneration = generation;
      requests.push({ method: request.method, path: request.path, timeoutMs: request.timeoutMs });
      // 合成“发现窗口不可用”：回执丢失后名单暂时读不到原任务，必须保守标记未知。
      if (hideDiscovery && request.method === 'GET' && request.path === '/api/deletions') {
        return { generation: acceptedGeneration, data: { operations: [] } };
      }
      const send = (signal) => fetch(endpoint + request.path, {
        method: request.method,
        headers: { authorization: 'Bearer synthetic-http-test', 'content-type': 'application/json', ...request.headers },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        ...(signal ? { signal } : {}),
      });
      let response;
      if (request.method === 'DELETE' && timeoutNextDelete) {
        timeoutNextDelete = false;
        // 客户端在服务端清理结束前超时：连接断开，但服务端继续推进原任务。
        const local = new AbortController();
        const timer = setTimeout(() => local.abort(), 50);
        try { response = await send(request.signal ? AbortSignal.any([request.signal, local.signal]) : local.signal); }
        catch { throw new BackendRequestFailure('connection'); }
        finally { clearTimeout(timer); }
      } else {
        response = await send(request.signal);
      }
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
  // 删除路径不能再用会清空界面的完整刷新；这里记录两类读取的实际调用。
  const refreshes = { full: 0, background: 0 };
  const fullRefresh = contacts.refreshContacts.bind(contacts);
  contacts.refreshContacts = async () => { refreshes.full++; return fullRefresh(); };
  const backgroundRefresh = contacts.refreshContactsInBackground.bind(contacts);
  contacts.refreshContactsInBackground = async () => { refreshes.background++; return backgroundRefresh(); };
  const refreshesBeforeDelete = { ...refreshes };

  const controller = new ContactDeletionController(backend, contacts, undefined, undefined, undefined,
    { operationWaitMs: 10_000, operationPollMs: 25, discoverPollMs: 10, discoverTimeoutMs: 200 });
  t.after(() => controller.dispose());
  await controller.refresh();
  hideDiscovery = true;
  loseNextDeleteResponse = true;
  const deleting = controller.delete({ contactId: first.contactId, scopeRevision: contacts.getState().scopeRevision, confirmed: true });
  // 删除请求仍在等回执、后端名单服务已关闭时，本地目录已经撤下这一位，其他联系人保持。
  assert.deepEqual(contacts.getState().contacts.map(row => row.contactId), [sibling.contactId]);
  assert.equal(contacts.getState().selectedContactId, null);
  await deleting;
  assert.equal(refreshes.full, refreshesBeforeDelete.full, '删除期间不使用会清空界面的完整刷新');
  assert.ok(refreshes.background > refreshesBeforeDelete.background, '删除期间与收尾使用保留式后台刷新');

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

  // 第二次删除：客户端在运输层超时，服务端仍推进原任务；控制器必须按原任务轮询到 completed，不误报未知。
  hideDiscovery = false;
  slowAdvance = true;
  contacts.selectContact({ contactId: sibling.contactId, scopeRevision: contacts.getState().scopeRevision });
  timeoutNextDelete = true;
  const postsBeforeTimeoutDelete = requests.filter(request => request.method === 'POST').length;
  const refreshesBeforeSecond = { ...refreshes };
  const secondDeleting = controller.delete({ contactId: sibling.contactId, scopeRevision: contacts.getState().scopeRevision, confirmed: true });
  assert.deepEqual(contacts.getState().contacts, [], '第二次删除发出即撤下最后一位联系人');
  assert.equal(contacts.getState().selectedContactId, null);
  await secondDeleting;
  assert.equal(refreshes.full, refreshesBeforeSecond.full, '第二次删除期间同样不使用完整刷新');
  assert.ok(refreshes.background > refreshesBeforeSecond.background);
  const second = controller.getState().operations[0];
  assert.equal(controller.getState().error, null);
  assert.equal(controller.getState().busyId, null);
  assert.equal(second.phase, 'completed');
  assert.equal(second.contactId, null);
  assert.deepEqual(contacts.getState().contacts, []);
  assert.deepEqual(requests.filter(request => request.method === 'DELETE').map(request => request.path), [
    `/api/contacts/${first.contactId}`, `/api/contacts/${first.contactId}`, `/api/contacts/${sibling.contactId}`,
  ]);
  // 服务端仍在推进时应靠状态轮询收尾，不用续跑请求制造并发。
  assert.equal(requests.filter(request => request.method === 'POST').length, postsBeforeTimeoutDelete);
  assert.ok(requests.every(request => request.timeoutMs === undefined || request.timeoutMs <= requestTimeoutLimitMs),
    '删除请求不能超过运输层单次时限');
  assert.equal((await direct('GET', '/api/contacts')).body.contacts.length, 0);
});

// 真实后端删除进行中名单服务已按 deletion.metadataAdmission 只读重建：桌面侧的目录/授权读取
// 应能拿到其他联系人与有效绑定，被删对象不可见；早开读者不能阻塞后续清理与删除结算。
async function earlyOpenFixture(t) {
  const userData = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-early-open-data-')));
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
  let slowSeal = false;
  const executeStorage = storage.execute.bind(storage);
  // 放慢清理阶段，让读取发生在删除请求尚未结算、名单服务已按准入重建之后。
  storage.execute = async (name, input, lease) => {
    if (slowSeal && name === 'deletion.sealTargets') await new Promise(resolve => setTimeout(resolve, 1200));
    return executeStorage(name, input, lease);
  };
  const deletion = new DeletionService(storage, holders, new ManagedFiles(userData), { drainTimeoutMs: 100 });
  const deletionHttp = new SqliteDeletionHttp(deletion, ownerId);
  server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer synthetic-http-test') { res.writeHead(401).end(); return; }
    if (!await deletionHttp.handle(req, res) && !await metadata.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
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
  assert.equal((await direct('POST', '/api/sync/cli-bindings/confirm', { snapshot_token: snapshot.snapshot_token,
    history_authorized: true, selections: snapshot.sessions.map(row => ({ locator: row.username,
      observed_display_name: row.display_name, expected_selection_generation: row.selection_generation })) })).status, 200);
  const contacts = (await direct('GET', '/api/contacts')).body.contacts;
  assert.equal(contacts.length, 2);
  return { direct, contacts, setSlowSeal: value => { slowSeal = value; }, closed: () => closed };
}

test('删除进行中名单服务已只读重建，其他联系人目录与授权绑定可读且被删对象不可见', async t => {
  const f = await earlyOpenFixture(t);
  const first = f.contacts.find(row => row.display_name === '合成甲');
  const sibling = f.contacts.find(row => row.display_name === '合成乙');
  f.setSlowSeal(true);
  const deleting = f.direct('DELETE', `/api/contacts/${first.contact_id}`, { confirmed: true, confirm_contact_id: first.contact_id });
  let roster;
  for (let i = 0; i < 300; i++) {
    roster = await f.direct('GET', '/api/contacts');
    // 旧名单服务已关闭、重建后的只读名单服务能回答 200，才证明读取发生在早开准入之后。
    if (roster.status === 200 && f.closed() >= 1) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(roster.status, 200, `删除进行中目录读取应已重建，实际 ${roster.status} ${JSON.stringify(roster.body)}`);
  assert.ok(f.closed() >= 1, '重建前旧名单服务已关闭');
  assert.deepEqual(roster.body.contacts.map(row => row.contact_id), [sibling.contact_id], '被删对象不可见，其他联系人可读');
  assert.ok(f.closed() >= 1, '重建前旧名单服务已关闭');
  const bindings = await f.direct('GET', '/api/sync/cli-bindings');
  assert.equal(bindings.status, 200, '删除进行中授权目录读取应可用');
  assert.ok(bindings.body.bindings.every(row => row.contact_id !== first.contact_id), '被删对象的绑定不可见');
  assert.ok(bindings.body.bindings.some(row => row.contact_id === sibling.contact_id), '其他联系人绑定保持可读');
  const deleted = await deleting;
  assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
  assert.equal((await f.direct('GET', `/api/deletions/${deleted.body.operation_id}`)).body.state, 'completed',
    '早开的名单读者不能阻塞删除结算');
  f.setSlowSeal(false);
  const after = await f.direct('GET', '/api/contacts');
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.contacts.map(row => row.contact_id), [sibling.contact_id]);
});
