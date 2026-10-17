import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPostgresRuntime } from '../../scripts/build-postgres.mjs';
import { runtimeMinimumMacOS } from '../../scripts/runtime-platform.mjs';

test('运行时最低系统只接受明确的macOS数字版本，缺失和注入格式在构建前拒绝', () => {
  assert.equal(runtimeMinimumMacOS({ minimumMacOS: '15.0' }), '15.0');
  assert.equal(runtimeMinimumMacOS({ minimumMacOS: '15.1.2' }), '15.1.2');
  for (const minimumMacOS of [undefined, null, 15, '', '15', '015.0', '15.00', '15.0\n', '15.0 -flag', '15.0.0.1']) {
    assert.throws(() => runtimeMinimumMacOS({ minimumMacOS }), /runtime_minimum_macos_invalid/);
  }
});

test('数据库构建在运行源码之前核验官方锁定摘要，拒绝替换归档且不留下产物', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-postgres-source-'));
  try {
    const archive = path.join(owned, 'replacement.tar.bz2');
    await writeFile(archive, 'synthetic replaced PostgreSQL source');
    await assert.rejects(buildPostgresRuntime({ archive, directory: path.join(owned, 'postgres'), workDirectory: path.join(owned, 'build') }), /runtime_postgres_source_hash/);
    assert.deepEqual(await readdir(owned), ['replacement.tar.bz2']);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('默认数据库运行时来源为官方源码，与随包完整源码及通知映射一致', async () => {
  const read = async (name) => JSON.parse(await readFile(new URL(`../../scripts/runtime/${name}`, import.meta.url), 'utf8'));
  const components = await read('component-sources.lock.json');
  const attribution = await read('attribution-sources.lock.json');
  assert.equal(components.postgres.version, '16.15');
  assert.equal(components.postgres.source, 'https://ftp.postgresql.org/pub/source/v16.15/postgresql-16.15.tar.bz2');
  assert.equal(components.postgres.sha256, 'c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed');
  assert.ok(attribution.sources.some((source) => source.filename === components.postgres.filename && source.sha256 === components.postgres.sha256 && source.retain));
  assert.ok(!attribution.sources.some((source) => source.scope.split('+').includes('edb')));
});
