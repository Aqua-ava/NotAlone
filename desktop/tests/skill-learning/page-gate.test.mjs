import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import path from 'node:path';

test('学习页面在有限租约与浏览器前要求明确Conda和仓库外证据目录', () => {
  for (const name of ['skill-learning', 'skill-review', 'skill-lifecycle', 'skill-feedback']) for (const extra of [{}, { CONDA_DEFAULT_ENV: 'NotAlone', CONDA_PREFIX: '/synthetic-unused' },
    { CONDA_DEFAULT_ENV: 'NotAlone', CONDA_PREFIX: '/synthetic-unused', NOTALONE_LEARNING_EVIDENCE_DIR: path.resolve('..') }]) {
    const result = spawnSync(process.execPath, ['scripts/test-pages.mjs', '--case', name, '--timeout-seconds', '180'],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...extra } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /page_test_environment/);
    assert.doesNotMatch(result.stdout, /验证范围|page_test_probe_ready/);
  }
});
