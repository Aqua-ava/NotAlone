import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fixture, owner } from './fixtures/memory-sqlite/support.mjs';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { SqliteHistoryClearService } from '../src/history/sqlite/clear.ts';
import { DeletionService } from '../src/storage/sqlite/deletion/service.ts';
import { ActiveHolders } from '../src/storage/sqlite/deletion/holders.ts';
import { ManagedFiles } from '../src/storage/sqlite/deletion/managed-files.ts';
import { launchDsh } from '../src/launch.ts';
import { DatabaseSync } from 'node:sqlite';

test('宿主级负例：手写未完成 contact 删除后重启仍返回 409 identity_closed', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-metadata-host-gate-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = await SqliteStorage.open({ userData: root, intent: 'create', role: 'test' });
  const ownerId = await storage.execute('identity.resolveOwner', { proposedOwnerId: '33333333-3333-4333-8333-333333333333', at: 1 });
  await storage.close();
  const db = new DatabaseSync(path.join(root, 'managed/sqlite/notalone.sqlite'));
  try {
    db.prepare("INSERT INTO deletion_operation(operation_id,owner_identity,request_namespace,request_key,scope_kind,contact_identity,accepted_generation,state,plan_revision,domain_manifest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run('blocked-contact-operation', ownerId, 'metadata_host_gate', 'blocked-contact-key', 'contact', '44444444-4444-4444-8444-444444444444', 1, 'blocked', 1, '{}', 1);
  } finally { db.close(); }
  const infoPath = path.join(root, 'managed/sqlite-backend.info');
  const host = await launchDsh({ nodeExecutable: process.execPath, projectDirectory: new URL('../../', import.meta.url).pathname,
    envFilePath: path.join(root, 'unused.env'), infoPath, businessHome: root, environment: {},
    sqlite: { userData: root, expectedDatabaseId: databaseId(root), role: 'test', capabilities: ['contacts'] } }, () => true);
  t.after(() => host.terminate());
  const info = await handshake(host, infoPath);
  const get = async route => {
    const response = await fetch(`http://${info.address}${route}`, { headers: { Authorization: `Bearer ${info.token}` } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const contacts = await get('/api/contacts');
  assert.equal(contacts.status, 409, JSON.stringify(contacts));
  assert.equal(contacts.body.error, 'identity_closed');
  const bindings = await get('/api/sync/cli-bindings');
  assert.equal(bindings.status, 409);
  assert.equal(bindings.body.error, 'identity_closed');
});

async function handshake(host, infoPath) {
  const until = Date.now() + 15000;
  while (Date.now() < until && host.isRunning()) {
    try { return Object.fromEntries((await readFile(infoPath, 'utf8')).trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; })); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(50);
  }
  assert.fail('清空未完成后重启的 SQLite 宿主未就绪');
}

test('清空聊天 blocked 操作跨重启不再关闭联系人/绑定读取，删除进度仍可见', async t => {
  const f = await fixture(t);
  const holders = new ActiveHolders();
  const deletion = new DeletionService(f.storage, holders, new ManagedFiles(f.root));
  const channel = () => ({ inspect: async () => { throw new Error('synthetic_no_channel'); }, target: async () => { throw new Error('synthetic_no_channel'); }, page: async () => { throw new Error('synthetic_no_channel'); } });
  const clear = new SqliteHistoryClearService(f.storage, f.contacts, channel, deletion, holders);
  const contactId = f.saved[0].contact_id;
  const cleared = await clear.clear(contactId, { signal: new AbortController().signal });
  assert.equal(cleared.phase, 'boundary_pending');
  assert.equal(cleared.boundary?.state, 'blocked');
  const status = await f.storage.execute('deletion.metadataAdmission', { ownerId: owner });
  assert.deepEqual(status, { available: true, writable: true, admittedOperations: [] }, '来源/清空/讨论/媒体删除不关闭联系人身份元数据');
  // 名单服务保持可读不等于放开身份写入：选择/撤销仍受既有资格与代次 CAS 约束。
  await assert.rejects(() => f.contacts.revoke(contactId, f.saved[0].binding_id, '0'), /identity_generation|selection|stale|invalid|closed/i);
  await assert.rejects(() => f.contacts.confirm('stale-selection-token', []), /selection_stale|identity_request_invalid|stale/i);
  await f.contacts.close();
  await f.storage.close();
  const infoPath = path.join(f.root, 'managed/sqlite-backend.info');
  const envFilePath = path.join(f.root, 'unused.env');
  const host = await launchDsh({ nodeExecutable: process.execPath, projectDirectory: new URL('../../', import.meta.url).pathname,
    envFilePath, infoPath, businessHome: f.root, environment: {}, sqlite: { userData: f.root, expectedDatabaseId: databaseId(f.root), role: 'test',
      capabilities: ['contacts', 'history', 'memory'] } }, () => true);
  t.after(() => host.terminate());
  const info = await handshake(host, infoPath);
  const request = async route => {
    const response = await fetch(`http://${info.address}${route}`, { headers: { Authorization: `Bearer ${info.token}` } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const contacts = await request('/api/contacts');
  assert.equal(contacts.status, 200, JSON.stringify(contacts));
  assert.ok(Array.isArray(contacts.body.contacts) && contacts.body.contacts.length >= 2);
  const bindings = await request('/api/sync/cli-bindings');
  assert.equal(bindings.status, 200);
  assert.equal(bindings.body.identity_protocol, 'sqlite-selected-v1');
  const sync = await request('/api/sync/status');
  assert.equal(sync.status, 200);
  const clearStatus = await request(`/api/contacts/${contactId}/history/clear`);
  assert.equal(clearStatus.status, 200);
  assert.equal(clearStatus.body.phase, 'boundary_pending');
  const deletions = await request('/api/deletions');
  assert.equal(deletions.status, 200);
  assert.ok(deletions.body.operations.some(operation => operation.scope_kind === 'contact_history' && operation.state === 'blocked'));
});

test('未完成联系人或账号删除仍关闭身份元数据服务（安全门禁保持）', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-metadata-gate-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = await SqliteStorage.open({ userData: root, intent: 'create', role: 'test' });
  const ownerId = await storage.execute('identity.resolveOwner', { proposedOwnerId: '11111111-1111-4111-8111-111111111111', at: 1 });
  await storage.close();
  for (const [scopeKind, contactIdentity] of [['contact', '22222222-2222-4222-8222-222222222222'], ['account', null]]) {
    const db = new DatabaseSync(path.join(root, 'managed/sqlite/notalone.sqlite'));
    try {
      db.prepare("INSERT INTO deletion_operation(operation_id,owner_identity,request_namespace,request_key,scope_kind,contact_identity,accepted_generation,state,plan_revision,domain_manifest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(`${scopeKind}-operation`, ownerId, 'metadata_gate_test', `${scopeKind}-key`, scopeKind, contactIdentity, 1, 'blocked', 1, '{}', 1);
    } finally { db.close(); }
    const opened = await SqliteStorage.open({ userData: root, intent: 'open', expectedDatabaseId: (() => { const d = new DatabaseSync(path.join(root, 'managed/sqlite/notalone.sqlite'), { readOnly: true }); try { return d.prepare('SELECT database_id FROM database_instance WHERE slot=1').all()[0].database_id; } finally { d.close(); } })(), role: 'test' });
    try { assert.deepEqual(await opened.execute('deletion.metadataAdmission', { ownerId }), { available: false, writable: false, admittedOperations: [] }, `${scopeKind} 尚未封禁或账户删除必须关闭名单服务`); }
    finally { await opened.close(); }
    const cleanup = new DatabaseSync(path.join(root, 'managed/sqlite/notalone.sqlite'));
    try { cleanup.prepare('DELETE FROM deletion_operation WHERE operation_id=?').run(`${scopeKind}-operation`); } finally { cleanup.close(); }
  }
});

test('宿主级正例：联系人已封禁的未完成删除跨重启后名单只读可读且被删对象不可见', async t => {
  const f = await fixture(t);
  const ownerId = owner;
  const contactId = f.saved[0].contact_id;
  await f.storage.close();
  const db = new DatabaseSync(path.join(f.root, 'managed/sqlite/notalone.sqlite'));
  try {
    db.prepare("UPDATE contact SET state='deleting' WHERE owner_id=? AND id=?").run(ownerId, contactId);
    db.prepare("INSERT INTO deletion_operation(operation_id,owner_identity,request_namespace,request_key,scope_kind,contact_identity,accepted_generation,state,plan_revision,domain_manifest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run('early-open-contact-operation', ownerId, 'metadata_host_early', 'early-open-contact-key', 'contact', contactId, 1, 'cleaning', 1, '{}', 1);
  } finally { db.close(); }
  const infoPath = path.join(f.root, 'managed/sqlite-backend.info');
  const host = await launchDsh({ nodeExecutable: process.execPath, projectDirectory: new URL('../../', import.meta.url).pathname,
    envFilePath: path.join(f.root, 'unused.env'), infoPath, businessHome: f.root, environment: {},
    sqlite: { userData: f.root, expectedDatabaseId: databaseId(f.root), role: 'test', capabilities: ['contacts'] } }, () => true);
  t.after(() => host.terminate());
  const info = await handshake(host, infoPath);
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(`http://${info.address}${route}`, { method, headers: { Authorization: `Bearer ${info.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const contacts = await request('/api/contacts');
  assert.equal(contacts.status, 200, JSON.stringify(contacts));
  assert.ok(contacts.body.contacts.every(row => row.contact_id !== contactId), '已封禁联系人不能出现在目录');
  const bindings = await request('/api/sync/cli-bindings');
  assert.equal(bindings.status, 200, JSON.stringify(bindings));
  assert.equal((await request('/api/sync/status')).status, 200);
  const write = await request('/api/sync/enable', 'POST', {});
  assert.equal(write.status, 409); assert.equal(write.body.error, 'identity_closed');
  const sessions = await request('/api/sync/cli-sessions');
  assert.equal(sessions.status, 409); assert.equal(sessions.body.error, 'identity_closed');
});

test('宿主级负例：未完成账户删除跨重启仍关闭名单读取', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-metadata-host-account-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = await SqliteStorage.open({ userData: root, intent: 'create', role: 'test' });
  const ownerId = await storage.execute('identity.resolveOwner', { proposedOwnerId: '33333333-3333-4333-8333-333333333333', at: 1 });
  await storage.close();
  const db = new DatabaseSync(path.join(root, 'managed/sqlite/notalone.sqlite'));
  try {
    db.prepare("INSERT INTO deletion_operation(operation_id,owner_identity,request_namespace,request_key,scope_kind,accepted_generation,state,plan_revision,domain_manifest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run('early-account-operation', ownerId, 'metadata_host_account', 'early-account-key', 'account', 1, 'blocked', 1, '{}', 1);
  } finally { db.close(); }
  const infoPath = path.join(root, 'managed/sqlite-backend.info');
  const host = await launchDsh({ nodeExecutable: process.execPath, projectDirectory: new URL('../../', import.meta.url).pathname,
    envFilePath: path.join(root, 'unused.env'), infoPath, businessHome: root, environment: {},
    sqlite: { userData: root, expectedDatabaseId: databaseId(root), role: 'test', capabilities: ['contacts'] } }, () => true);
  t.after(() => host.terminate());
  const info = await handshake(host, infoPath);
  const response = await fetch(`http://${info.address}/api/contacts`, { headers: { Authorization: `Bearer ${info.token}` } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'identity_closed');
});

function databaseId(root) {
  const db = new DatabaseSync(path.join(root, 'managed/sqlite/notalone.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT database_id FROM database_instance WHERE slot=1').all()[0].database_id; }
  finally { db.close(); }
}
