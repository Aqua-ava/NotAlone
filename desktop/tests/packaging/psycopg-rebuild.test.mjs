import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rebuildPsycopgRuntime } from '../../scripts/rebuild-psycopg-runtime.mjs';

test('修改库探针先拒绝伪造的上游源码，不创建构建目录或改写原运行时', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-psycopg-rebuild-'));
  try {
    const sourceArchive = path.join(owned, 'source.tar.gz');
    await writeFile(sourceArchive, 'synthetic replaced upstream archive');
    await assert.rejects(rebuildPsycopgRuntime({ sourceArchive, runtimeDirectory: path.join(owned, 'original'),
      outputDirectory: path.join(owned, 'output'), workDirectory: path.join(owned, 'build'), sourceCache: path.join(owned, 'cache') }), /psycopg_rebuild_source_hash/);
    assert.deepEqual(await readdir(owned), ['source.tar.gz']);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('外部修改补丁先拒绝越出源码根的路径，尚不读取或构建原运行时', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-psycopg-patch-'));
  try {
    const patchFile = path.join(owned, 'recipient.patch');
    await writeFile(patchFile, '--- a/../../outside\n+++ b/../../outside\n@@ -1 +1 @@\n-old\n+new\n');
    await assert.rejects(rebuildPsycopgRuntime({ patchFile, sourceArchive: path.join(owned, 'absent.tar.gz'),
      runtimeDirectory: path.join(owned, 'original'), outputDirectory: path.join(owned, 'output'),
      workDirectory: path.join(owned, 'build'), sourceCache: path.join(owned, 'cache') }), /psycopg_rebuild_patch_path/);
    assert.deepEqual(await readdir(owned), ['recipient.patch']);
  } finally { await rm(owned, { recursive: true, force: true }); }
});
