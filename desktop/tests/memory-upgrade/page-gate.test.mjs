import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import path from 'node:path';

test('旧资料升级页面在租约和浏览器前要求Conda与仓库外证据目录', () => {
  for (const extra of [{}, { CONDA_DEFAULT_ENV: 'NotAlone', CONDA_PREFIX: '/synthetic-unused' },
    { CONDA_DEFAULT_ENV: 'NotAlone', CONDA_PREFIX: '/synthetic-unused', NOTALONE_UPGRADE_EVIDENCE_DIR: path.resolve('..') }]) {
    const result = spawnSync(process.execPath, ['scripts/test-pages.mjs', '--case', 'memory-upgrade', '--timeout-seconds', '180'],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...extra } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /page_test_environment/);
    assert.doesNotMatch(result.stdout, /验证范围|page_test_probe_ready/);
  }
});
