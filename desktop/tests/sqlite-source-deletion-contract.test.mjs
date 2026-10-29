import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { SqliteStorage } from '../../backend-ts/src/storage/sqlite/client.ts';
import { DeletionService } from '../../backend-ts/src/storage/sqlite/deletion/service.ts';
import { ActiveHolders } from '../../backend-ts/src/storage/sqlite/deletion/holders.ts';
import { ManagedFiles } from '../../backend-ts/src/storage/sqlite/deletion/managed-files.ts';
import { SqliteDeletionHttp } from '../../backend-ts/src/storage/sqlite/deletion/http.ts';

test('现有来源删除读取器接受SQLite生产HTTP回执及最终状态', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'notalone-source-contract-')));
  let storage, server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await storage?.close();
    await rm(root, {recursive: true, force: true});
  });
  const output = join(root, 'source-reader.mjs');
  await build({entryPoints: ['src/main/sources/read.ts'], outfile: output, bundle: true, format: 'esm', platform: 'node'});
  const {deletionReceipt, deletionTask} = await import(pathToFileURL(output).href);
  storage = await SqliteStorage.open({userData: root, intent: 'create', role: 'test', registryModule: new URL('../../backend-ts/test/fixtures/sqlite/deletion-registry.mjs', import.meta.url).href});
  await storage.execute('sample.seed', {});
  const adapter = new SqliteDeletionHttp(new DeletionService(storage, new ActiveHolders(), new ManagedFiles(root)), 'o');
  server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer fixed-synthetic') {res.writeHead(401); res.end(); return;}
    if (!await adapter.handle(req, res)) {res.writeHead(404); res.end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {authorization: 'Bearer fixed-synthetic'};
  const receipt = await fetch(base + '/api/contacts/a/sources/r1', {method: 'DELETE', headers});
  assert.equal(receipt.status, 202);
  const taskId = deletionReceipt(await receipt.json());
  const progress = await fetch(base + `/api/tasks/status?contact_id=a&task_id=${taskId}`, {headers});
  const task = deletionTask(await progress.json(), taskId);
  assert.equal(task.status, 'succeeded');
  assert.equal(task.step, 'verify_not_retrievable');
  assert.ok(task.steps.every(step => step.status === 'succeeded'));
});
