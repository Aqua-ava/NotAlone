import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const project = path.resolve('..');
const bundleRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-sqlite-only-startup-test-')));
after(() => rm(bundleRoot, { recursive: true, force: true }));
const built = await build({
  entryPoints: ['src/main/startup/sqlite-development.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const bundle = path.join(bundleRoot, 'sqlite-development.mjs');
await writeFile(bundle, built.outputFiles[0].text);
const { SqliteDevelopmentProbe } = await import(pathToFileURL(bundle).href);

async function fixture(t, name) {
  const userData = await realpath(await mkdtemp(path.join(tmpdir(), `notalone-sqlite-only-${name}-`)));
  t.after(() => rm(userData, { recursive: true, force: true }));
  return userData;
}

async function createUnknownManagedStore(userData) {
  const location = path.join(userData, 'managed', 'old-store', 'catalog.bin');
  await mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
  await writeFile(location, 'synthetic unclassified store', { mode: 0o600 });
  return location;
}

async function authorizeSyntheticCleanup(userData) {
  const control = path.join(userData, 'database-cutover');
  await mkdir(control, { recursive: true, mode: 0o700 });
  await writeFile(path.join(control, 'authorization.json'), JSON.stringify({ formatVersion: 1, approvedAt: 1, scope: 'synthetic',
    targets: [{ id: 'a'.repeat(32), disposition: 'clean' }] }) + '\n', { mode: 0o600 });
}

test('未识别的 managed 存储进入维护态，即使有授权也不覆盖或清理', async t => {
  for (const authorized of [false, true]) {
    const userData = await fixture(t, authorized ? 'authorized-unknown' : 'unknown');
    const legacyStore = await createUnknownManagedStore(userData);
    if (authorized) await authorizeSyntheticCleanup(userData);

    const result = await new SqliteDevelopmentProbe(userData, project).run(() => true);

    assert.equal(result.phase, 'blocked');
    assert.equal(result.code, 'cutover_legacy_target_unclassified');
    assert.equal(result.maintenance, true);
    assert.equal(JSON.stringify(result).includes('synthetic unclassified store'), false);
    assert.equal(await readFile(legacyStore, 'utf8'), 'synthetic unclassified store');
    await assert.rejects(readFile(path.join(userData, 'managed', 'sqlite', 'notalone.sqlite')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(userData, 'sqlite-development.json')), { code: 'ENOENT' });

    await rm(path.dirname(legacyStore), { recursive: true, force: true });
    const created = await new SqliteDevelopmentProbe(userData, project).run(() => true);
    assert.equal(created.phase, 'ready');
    assert.equal(created.code, 'sqlite_ready');
    const reopened = await new SqliteDevelopmentProbe(userData, project).run(() => true);
    assert.equal(reopened.phase, 'prepared');
    assert.equal(reopened.databaseId, created.databaseId);
  }
});

test('已完成的SQLite实例重开时也阻断新出现的未识别managed存储', async t => {
  const userData = await fixture(t, 'completed-unknown');
  const probe = new SqliteDevelopmentProbe(userData, project);
  const created = await probe.run(() => true);
  assert.equal(created.phase, 'ready');
  const manifestPath = path.join(userData, 'database-cutover', 'manifest.json');
  const configurationPath = path.join(userData, 'sqlite-development.json');
  const manifestBefore = await readFile(manifestPath, 'utf8');
  const configurationBefore = await readFile(configurationPath, 'utf8');
  const legacyStore = await createUnknownManagedStore(userData);

  const result = await probe.run(() => true);

  assert.equal(result.phase, 'blocked');
  assert.equal(result.code, 'cutover_legacy_target_unclassified');
  assert.equal(result.maintenance, true);
  assert.equal(await readFile(legacyStore, 'utf8'), 'synthetic unclassified store');
  assert.equal(await readFile(manifestPath, 'utf8'), manifestBefore);
  assert.equal(await readFile(configurationPath, 'utf8'), configurationBefore);

  await rm(path.dirname(legacyStore), { recursive: true, force: true });
  const reopened = await probe.run(() => true);
  assert.equal(reopened.phase, 'prepared');
  assert.equal(reopened.code, 'sqlite_prepared');
  assert.equal(reopened.databaseId, created.databaseId);
});
