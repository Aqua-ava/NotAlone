import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runDefaultDatabaseStartup } from '../src/platform/cutover/startup.ts';
import { launchDsh } from '../src/launch.ts';
import { waitForHostReady } from './host-readiness-support.mjs';

test('默认 SQLite 跨重启：同 database_id/owner 重开并恢复联系人、绑定与同步状态读取', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-cutover-restart-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(first.phase, 'ready');
  assert.equal(first.created, true);
  const second = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(second.phase, 'ready', JSON.stringify(second));
  assert.equal(second.code, 'sqlite_reopened');
  assert.equal(second.databaseId, first.databaseId);
  assert.equal(second.ownerId, first.ownerId);
  assert.deepEqual(second.configuration.capabilities, ['contacts', 'skills', 'history', 'discussions', 'memory']);

  const infoPath = path.join(root, 'managed/sqlite-backend.info');
  const host = await launchDsh({ nodeExecutable: process.execPath, projectDirectory: new URL('../../', import.meta.url).pathname,
    envFilePath: path.join(root, 'unused.env'), infoPath, businessHome: root, environment: {},
    sqlite: { userData: root, expectedDatabaseId: second.databaseId, role: 'test', ...second.configuration } }, () => true);
  t.after(() => host.terminate());
  const info = await waitForHostReady(host, infoPath);
  const request = async (route, options = {}) => {
    const response = await fetch(`http://${info.address}${route}`, { ...options, headers: { Authorization: `Bearer ${info.token}`, ...options.headers } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const runtime = await request('/api/runtime/status');
  assert.equal(runtime.status, 200);
  assert.equal(runtime.body.storage, 'sqlite');
  assert.equal(runtime.body.ownership.contacts, 'typescript');
  const setup = await request('/api/setup/status');
  assert.equal(setup.status, 200);
  assert.equal(setup.body.owner_id, first.ownerId);
  const contacts = await request('/api/contacts');
  assert.equal(contacts.status, 200);
  assert.deepEqual(contacts.body.contacts, []);
  const bindings = await request('/api/sync/cli-bindings');
  assert.equal(bindings.status, 200);
  assert.equal(bindings.body.identity_protocol, 'sqlite-selected-v1');
  assert.deepEqual(bindings.body.bindings, []);
  const sync = await request('/api/sync/status');
  assert.equal(sync.status, 200);
  assert.equal(sync.body.identity_protocol, 'sqlite-selected-v1');
  assert.equal(sync.body.sync_enabled, false);
  const sessions = await request('/api/sync/cli-sessions');
  assert.equal(sessions.status, 409);
  assert.equal(sessions.body.error, 'metadata_consent_required');
  const skills = await request('/api/skills');
  assert.equal(skills.status, 200);
  assert.deepEqual(skills.body.skills, []);
  // 宿主关闭后再次默认启动仍是同一实例，不因检查/重开生成另一个空库。
  assert.equal(await host.terminate(), true);
  const third = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(third.phase, 'ready', JSON.stringify(third));
  assert.equal(third.databaseId, first.databaseId);
  assert.equal(third.ownerId, first.ownerId);
});
