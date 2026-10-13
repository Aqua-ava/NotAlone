import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('第三方工具打包参数在读取输入及创建输出前拒绝', { skip: process.platform !== 'darwin' }, async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-external-tools-'));
  try {
    const output = path.join(owned, 'output');
    for (const flag of ['--helper-directory', '--helper-version', '--helper-source']) {
      const result = spawnSync(process.execPath, [path.resolve('scripts/package.mjs'),
        '--output-directory', output, flag, '/synthetic-unavailable-input'], {
        encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin' },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /package_external_tools_only/);
      await assert.rejects(access(output));
    }
  } finally { await rm(owned, { recursive: true, force: true }); }
});
