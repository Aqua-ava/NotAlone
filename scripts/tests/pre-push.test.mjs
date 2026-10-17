import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../../', import.meta.url));
test('推送检查覆盖实际提交、历史泄露、多引用、标签与删除操作', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'notalone-hook-'));
  const env = { ...process.env, NOTALONE_PUBLICATION_ENV_FILE: path.join(repo, 'absent-env') };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  const run = (input) => spawnSync('sh', ['.githooks/pre-push'], { cwd: repo, env, input, encoding: 'utf8' });
  const zeros = '0'.repeat(40);
  const record = (oid) => `refs/heads/test ${oid} refs/heads/test ${zeros}\n`;
  try {
    git('init', '-q');
    git('config', 'user.name', 'Synthetic Test');
    git('config', 'user.email', 'test@example.invalid');
    fs.mkdirSync(path.join(repo, 'scripts'));
    fs.mkdirSync(path.join(repo, '.githooks'));
    for (const name of ['scripts/check_public_history.mjs', '.githooks/pre-push']) {
      fs.copyFileSync(path.join(source, name), path.join(repo, name));
    }
    git('add', '.'); git('commit', '-qm', '合成干净提交');
    const clean = git('rev-parse', 'HEAD');
    assert.equal(run(record(clean)).status, 0);
    // 合成秘密通过拼接生成，避免把可命中凭据写入仓库历史。
    const secret = 'ghp_' + 'a'.repeat(36);
    fs.writeFileSync(path.join(repo, 'sample.txt'), secret);
    git('add', '.'); git('commit', '-qm', '合成敏感提交');
    const unsafe = git('rev-parse', 'HEAD');
    fs.unlinkSync(path.join(repo, 'sample.txt'));
    git('add', '-u'); git('commit', '-qm', '移除合成内容但保留历史');
    const result = run(record(git('rev-parse', 'HEAD')));
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes(secret));
    assert.equal(run(record(clean)).status, 0, '扫描推送对象而非当前 HEAD');
    assert.equal(run(record(clean) + record(unsafe)).status, 1);
    git('tag', '-a', 'synthetic-tag', unsafe, '-m', '合成标签');
    assert.equal(run(record(git('rev-parse', 'synthetic-tag'))).status, 1);
    git('tag', '-a', 'private-note', clean, '-m', secret);
    const tagResult = run(record(git('rev-parse', 'private-note')));
    assert.equal(tagResult.status, 1, '附注标签说明也需要检查');
    assert.ok(!tagResult.stdout.includes(secret));
    assert.equal(run(record(zeros)).status, 0);
    assert.equal(run(record('f'.repeat(40))).status, 1);
    fs.writeFileSync(path.join(repo, '.git/shallow'), clean + '\n');
    assert.equal(run(record(clean)).status, 1, '不允许将浅克隆当作完整历史');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
