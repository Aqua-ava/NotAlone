import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadManifest } from '../src/platform/cutover/control.ts';
import { prepareDefaultDatabaseStartup, runDefaultDatabaseStartup } from '../src/platform/cutover/startup.ts';
import { launchDsh } from '../src/launch.ts';

async function handshake(host, infoPath) {
  const until = Date.now() + 20000;
  while (Date.now() < until && host.isRunning()) {
    try { return Object.fromEntries((await readFile(infoPath, 'utf8')).trim().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; })); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(50);
  }
  assert.fail('SQLite 宿主未在有界时间内就绪');
}

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
  const info = await handshake(host, infoPath);
  const status = async () => (await fetch(`http://${info.address}/api/runtime/status`, { headers: { Authorization: `Bearer ${info.token}` } })).json();
  assert.equal((await status()).storageIdentity.available, true);
  // 停读诊断字段：未失败时为空数组，失败时只列固定资源键。
  assert.deepEqual((await status()).shutdownFailedResources, []);
  const before = loadManifest(root);

  // 宿主自己的握手与启动锁都真实存在且存活；重连预检必须仍然准备原目标。
  for (let round = 0; round < 3; round++) {
    const prepared = await prepareDefaultDatabaseStartup({ userData: root });
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
  const next = await handshake(second, infoPath);
  assert.notEqual(next.pid, info.pid);
  assert.equal((await fetch(`http://${next.address}/api/runtime/status`, { headers: { Authorization: `Bearer ${next.token}` } })).status, 200);
});
