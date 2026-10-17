import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

test('本人页面公开有限入口先核证据目录，缺失或越界即拒绝且不启动浏览器', () => {
  for (const evidence of ['', 'relative-evidence']) {
    const result = spawnSync(process.execPath, ['scripts/test-pages.mjs', '--case', 'owner-facts-overview', '--timeout-seconds', '180'], {
      encoding: 'utf8', env: { ...process.env, CONDA_DEFAULT_ENV: 'NotAlone', CONDA_PREFIX: '/synthetic-notalone',
        NOTALONE_OWNER_OVERVIEW_TEST_EVIDENCE_DIR: evidence },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /page_test_environment/);
    assert.ok(!result.stdout.includes('page_test_case'));
  }
});

test('本人页面子门独立拒绝无父进程授权及超范围，仅静态执行启动前门禁', async () => {
  const source = await readFile('tests/headless/run.ts', 'utf8');
  const start = source.indexOf('if (!process.send');
  const end = source.indexOf('let browser:', start);
  assert.ok(start > 0 && end > start);
  const gate = source.slice(start, end).replace(' as string[]', '');
  assert.throws(() => runInNewContext(gate, { process: { env: { NOTALONE_PAGE_CASES: '["owner-facts-overview"]' } } }), /page_test_unapproved/);
  const process = { send() {}, env: { NOTALONE_PAGE_RUN_NONCE: 'a'.repeat(64), NOTALONE_PAGE_CASES: '["owner-facts-overview"]' } };
  assert.doesNotThrow(() => runInNewContext(gate, { process }));
  for (const names of ['["unregistered-owner-case"]', '["owner-facts-overview","owner-facts-overview"]', '["owner-facts-overview","owner-facts-overview","owner-facts-overview"]']) {
    process.env.NOTALONE_PAGE_CASES = names;
    assert.throws(() => runInNewContext(gate, { process }), /page_test_arguments/);
  }
});
