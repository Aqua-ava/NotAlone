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
  const status = await f.storage.execute('deletion.metadataAvailable', { ownerId: owner });
  assert.equal(status, true, '来源/清空/讨论/媒体删除不关闭联系人身份元数据');
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
    try { assert.equal(await opened.execute('deletion.metadataAvailable', { ownerId }), false, `${scopeKind} 未完成删除必须关闭名单服务`); }
    finally { await opened.close(); }
    const cleanup = new DatabaseSync(path.join(root, 'managed/sqlite/notalone.sqlite'));
    try { cleanup.prepare('DELETE FROM deletion_operation WHERE operation_id=?').run(`${scopeKind}-operation`); } finally { cleanup.close(); }
  }
});

function databaseId(root) {
  const db = new DatabaseSync(path.join(root, 'managed/sqlite/notalone.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT database_id FROM database_instance WHERE slot=1').all()[0].database_id; }
  finally { db.close(); }
}
