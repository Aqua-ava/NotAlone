import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function fixture(use) {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-finder-isolation-'));
  try {
    const module = path.join(owned, 'isolation.mjs');
    await build({ entryPoints: ['tests/finder-user-data.ts'], outfile: module,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { createFinderUserData } = await import(pathToFileURL(module).href);
    const backup = path.join(owned, 'backup'); await mkdir(backup);
    await use({ owned, backup, directory: path.join(owned, 'userData'), createFinderUserData });
  } finally { await rm(owned, { recursive: true, force: true }); }
}

test('Finder隔离只换入测试目录，恢复原目录身份与原文件，空首启也恢复为空', async () => {
  await fixture(async ({ directory, backup, createFinderUserData }) => {
    await mkdir(directory); await writeFile(path.join(directory, 'existing'), 'synthetic_preserved');
    const original = await lstat(directory);
    const isolation = await createFinderUserData(directory, backup);
    assert.notEqual((await lstat(directory)).ino, original.ino);
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    await writeFile(path.join(directory, 'generated'), 'synthetic_test_only');
    await isolation.restore();
    assert.equal((await lstat(directory)).ino, original.ino);
    assert.equal(await readFile(path.join(directory, 'existing'), 'utf8'), 'synthetic_preserved');
    await assert.rejects(lstat(path.join(directory, 'generated')), { code: 'ENOENT' });
    await rm(directory, { recursive: true });
    const firstRun = await createFinderUserData(directory, backup);
    await firstRun.restore();
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
  });
});

test('Finder隔离拒绝符号链接，目录被替换时保留原备份和未知新目录', async () => {
  await fixture(async ({ owned, directory, backup, createFinderUserData }) => {
    const target = path.join(owned, 'target'); await mkdir(target);
    await writeFile(path.join(target, 'existing'), 'synthetic_preserved');
    await symlink(target, directory);
    await assert.rejects(createFinderUserData(directory, backup), /finder_user_data_unsafe/);
    assert.equal(await readFile(path.join(target, 'existing'), 'utf8'), 'synthetic_preserved');
    await rm(directory); await rename(target, directory);
    const isolation = await createFinderUserData(directory, backup);
    await rename(directory, path.join(owned, 'moved-test-directory')); await mkdir(directory);
    await writeFile(path.join(directory, 'unknown'), 'synthetic_do_not_delete');
    await assert.rejects(isolation.restore(), /finder_user_data_changed/);
    assert.equal(await readFile(path.join(directory, 'unknown'), 'utf8'), 'synthetic_do_not_delete');
    assert.equal(await readFile(path.join(backup, 'original-user-data/existing'), 'utf8'), 'synthetic_preserved');
  });
});
