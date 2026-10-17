import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('组合页面在取得租约和启动浏览器前要求独立证据目录与Conda', () => {
  for (const extra of [{}, { CONDA_DEFAULT_ENV: 'NotAlone', CONDA_PREFIX: '/synthetic-unused' },
    { CONDA_DEFAULT_ENV: 'NotAlone', CONDA_PREFIX: '/synthetic-unused', NOTALONE_EVOLUTION_EVIDENCE_DIR: path.resolve('..') }]) {
    const result = spawnSync(process.execPath, ['scripts/test-pages.mjs', '--case', 'memory-skill-evolution', '--timeout-seconds', '300'],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...extra } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /page_test_environment/);
    assert.doesNotMatch(result.stdout, /验证范围|page_test_probe_ready/);
  }
});

test('受控子入口接受组合范围并继续拒绝未登记范围', () => {
  const source = readFileSync('tests/headless/run.ts', 'utf8');
  const start = source.indexOf('const cases = ');
  const end = source.indexOf('let browser:', start);
  assert.ok(start >= 0 && end > start);
  const guard = source.slice(start, end).replace(' as string[]', '');
  const validate = names => runInNewContext(guard, { process: { env: { NOTALONE_PAGE_CASES: JSON.stringify(names) } } });
  assert.doesNotThrow(() => validate(['memory-skill-evolution']));
  assert.throws(() => validate(['unregistered-evolution']), /page_test_arguments/);
});
