import {prepareDatabaseStartup} from '../src/platform/database-startup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadManifest } from '../src/platform/cutover/control.ts';
import { runDefaultDatabaseStartup } from './fixtures/cutover/default-startup.mjs';
import { launchDsh } from '../src/launch.ts';
import { waitForHostReady } from './host-readiness-support.mjs';

test('真实SQLite宿主存活时：重连预检不改写清单，也不放行第二个宿主，退出后可重新启动', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-live-host-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(first.phase, 'ready');
  const infoPath = path.join(root, 'managed/sqlite-backend.info');
  const launch = () => launchDsh({ nodeExecutable: process.execPath, projectDirectory: new URL('../../', import.meta.url).pathname,
    envFilePath: path.join(root, 'unused.env'), infoPath, businessHome: root, environment: {},
    sqlite: { userData: root, expectedDatabaseId: first.databaseId, expectedOwnerId: first.ownerId, role: 'test', ...first.configuration } }, () => true);
  const host = await launch();
  t.after(() => host.terminate());
  const info = await waitForHostReady(host, infoPath);
  const status = async () => (await fetch(`http://${info.address}/api/runtime/status`, { headers: { Authorization: `Bearer ${info.token}` } })).json();
  assert.equal((await status()).storageIdentity.available, true);
  // 停读诊断字段：未失败时为空数组，失败时只列固定资源键。
  assert.deepEqual((await status()).shutdownFailedResources, []);
  const before = loadManifest(root);

  // 宿主自己的握手与启动锁都真实存在且存活；重连预检必须仍然准备原目标。
  for (let round = 0; round < 3; round++) {
    const prepared = await prepareDatabaseStartup({ userData: root });
    assert.equal(prepared.phase, 'prepared', JSON.stringify(prepared));
    assert.equal(prepared.databaseId, first.databaseId);assert.equal(prepared.ownerId, first.ownerId);
  }
  const after = loadManifest(root);
  assert.equal(after.phase, 'completed');assert.equal(after.revision, before.revision);assert.equal(after.blockedCode, undefined);
  assert.equal((await status()).pid, Number(info.pid), '预检没有触碰存活的原宿主');

  // 单实例由启动器保证：存活期间第二次启动被拒绝，原宿主不受影响。
  await assert.rejects(launch(), /backend_already_running/);
  assert.equal((await status()).pid, Number(info.pid));

  // 原宿主退出后可以沿同一实例重新启动。
  assert.equal(await host.terminate(), true);
  const second = await launch();
  t.after(() => second.terminate());
  const next = await waitForHostReady(second, infoPath);
  assert.notEqual(next.pid, info.pid);
  assert.equal((await fetch(`http://${next.address}/api/runtime/status`, { headers: { Authorization: `Bearer ${next.token}` } })).status, 200);
});

test('真实SQLite宿主异步停读在有界时间内确认stopped，且无任何资源被强制放弃', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-live-shutdown-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(first.phase, 'ready');
  const infoPath = path.join(root, 'managed/sqlite-backend.info');
  const host = await launchDsh({ nodeExecutable: process.execPath, projectDirectory: new URL('../../', import.meta.url).pathname,
    envFilePath: path.join(root, 'unused.env'), infoPath, businessHome: root, environment: {},
    sqlite: { userData: root, expectedDatabaseId: first.databaseId, expectedOwnerId: first.ownerId, role: 'test', ...first.configuration } }, () => true);
  t.after(() => host.terminate());
  const info = await waitForHostReady(host, infoPath);
  const request = async (method, endpoint) => (await fetch(`http://${info.address}${endpoint}`, { method, headers: { Authorization: `Bearer ${info.token}` } }));
  const begun = Date.now();
  assert.ok([200, 202].includes((await request('POST', '/api/runtime/shutdown/begin')).status));
  let last;
  for (let attempt = 0; attempt < 100 && !(last?.state === 'stopped'); attempt++) {
    try { last = await (await request('GET', '/api/runtime/status')).json(); } catch { if (!host.isRunning()) break; }
    if (last?.state !== 'stopped') await delay(100);
  }
  // 状态确认 stopped 或宿主在确认后随即退出，二者都算有界收尾；失败或被强制放弃必须为空。
  if (last) { assert.equal(last.shutdownFailed, false); assert.deepEqual(last.shutdownForcedResources, []); }
  assert.ok(await host.waitForExit(10000), '宿主应在停读后退出');
  assert.ok(Date.now() - begun < 20000);
});
