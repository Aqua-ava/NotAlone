import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runDefaultDatabaseStartup } from './fixtures/cutover/default-startup.mjs';
import { unrecognizedManagedTargets } from '../src/platform/cutover/targets.ts';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-cutover-diagnostic-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ready = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(ready.phase, 'ready', ready.code);
  return root;
}

test('上次启动失败留下的固定诊断记录不会阻断之后的启动', async t => {
  const root = await fixture(t);
  const record = JSON.stringify({ version: 1, stage: 'storage', cause: 'timeout', recordedAt: 1 });
  for (const name of ['sqlite-backend.info.startup-diagnostic.json', 'backend.info.startup-diagnostic.json']) {
    await writeFile(path.join(root, 'managed', name), record, { mode: 0o600 });
  }
  assert.deepEqual(unrecognizedManagedTargets(root), []);
  const reopened = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(reopened.phase, 'ready', reopened.code);
});

test('诊断记录旁的未知条目仍阻断且不删除', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'managed', 'sqlite-backend.info.startup-diagnostic.json'), '{}', { mode: 0o600 });
  await writeFile(path.join(root, 'managed', 'unknown-entry'), '保留现场', { mode: 0o600 });
  assert.equal(unrecognizedManagedTargets(root).length, 1);
  const blocked = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(blocked.phase, 'maintenance');
});
