import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  historyCliBuildRoot, parseHistoryBuildArguments, validateHistoryOutputDirectory,
  verifyHistoryBuildFile, validateHistoryBuildInputs, applyHistoryBuildPatch,
} from '../../scripts/build-history-cli.mjs';

test('历史CLI开发构建拒绝缺失、未知、重复与非绝对路径参数', () => {
  const valid = ['--source-directory', '/synthetic/source', '--go-archive', '/synthetic/go.tar.gz',
    '--wcdb-library', '/synthetic/libWCDB.dylib', '--output-directory', path.join(historyCliBuildRoot, 'synthetic-new')];
  assert.equal(parseHistoryBuildArguments(valid).sourceDirectory, '/synthetic/source');
  for (const args of [[], ['--help'], [...valid, '--download'], [...valid, '--go-archive', '/another'],
    ['--source-directory', 'relative', ...valid.slice(2)]]) {
    assert.throws(() => parseHistoryBuildArguments(args), /history_cli_arguments_invalid/);
  }
});

test('历史CLI开发构建拒绝越界、现存输出与链接', async () => {
  await assert.rejects(validateHistoryOutputDirectory('/tmp/history-cli-outside'), /history_cli_output_invalid/);
  await assert.rejects(validateHistoryOutputDirectory(historyCliBuildRoot), /history_cli_output_invalid/);
  await mkdir(historyCliBuildRoot, { recursive: true });
  const owned = await mkdtemp(path.join(historyCliBuildRoot, 'script-test-'));
  const link = `${owned}-link`;
  try {
    await assert.rejects(validateHistoryOutputDirectory(owned), /history_cli_output_exists/);
    await symlink(owned, link);
    await assert.rejects(validateHistoryOutputDirectory(link), /history_cli_output_exists/);
  } finally {
    await rm(link, { force: true });
    await rm(owned, { recursive: true, force: true });
  }
});

test('历史CLI开发构建在错误摘要时拒绝，不需要伪造大型Go归档', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-history-build-'));
  try {
    const file = path.join(owned, 'tiny-synthetic-archive');
    await writeFile(file, '合成损坏归档');
    await assert.rejects(verifyHistoryBuildFile(file, '0'.repeat(64), 'history_cli_go_hash'), /history_cli_go_hash/);
    await assert.rejects(validateHistoryBuildInputs({ sourceDirectory: owned, goArchive: file,
      wcdbLibrary: file, outputDirectory: path.join(historyCliBuildRoot, `invalid-go-${process.pid}`) }), /history_cli_go_hash/);
    const result = spawnSync(process.execPath, [new URL('../../scripts/build-history-cli.mjs', import.meta.url).pathname,
      '--source-directory', 'relative'], { encoding: 'utf8', timeout: 5000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /history_cli_arguments_invalid/);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('归档位于父Git仓库内时仍在归档根实际应用补丁', async () => {
  await mkdir(historyCliBuildRoot, { recursive: true });
  const owned = await mkdtemp(path.join(historyCliBuildRoot, 'script-patch-test-'));
  try {
    const source = path.join(owned, 'source'), patch = path.join(owned, 'synthetic.patch');
    await mkdir(source);
    await writeFile(path.join(source, 'fixture.txt'), 'before\n');
    await writeFile(patch, 'diff --git a/fixture.txt b/fixture.txt\n--- a/fixture.txt\n+++ b/fixture.txt\n@@ -1 +1 @@\n-before\n+after\n');
    await applyHistoryBuildPatch(source, patch);
    assert.equal(await readFile(path.join(source, 'fixture.txt'), 'utf8'), 'after\n');
  } finally { await rm(owned, { recursive: true, force: true }); }
});
