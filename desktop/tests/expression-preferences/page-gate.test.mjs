import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';

async function entryGate(environment) {
  const source = await readFile('scripts/test-pages.mjs', 'utf8');
  const start = source.indexOf('function parse(');
  const stop = source.indexOf("  if (options.mode !== 'probe') await access(", start);
  assert.ok(start > 0 && stop > start);
  // 与07一致，只执行真实入口在浏览器与租约之前的有限门禁。
  const executed = `${source.slice(start, stop)}}; ({ parse, run });`;
  if (process.env.NOTALONE_REPLY_EVIDENCE_TEST_PROOF) {
    await writeFile(path.join(process.env.NOTALONE_REPLY_EVIDENCE_TEST_PROOF, `preference-page-gate-${process.pid}.json`),
      JSON.stringify({ path: path.resolve('scripts/test-pages.mjs'),
        sourceSha256: createHash('sha256').update(source).digest('hex'),
        executedSha256: createHash('sha256').update(executed).digest('hex') }),
      { mode: 0o600 });
  }
  return runInNewContext(executed, { path, desktop: process.cwd(), realpath, stat, readFile, createHash,
    process: { env: environment } });
}

test('长期偏好页面入口先核验Conda，不因新增场景绕过单实例有限时段门禁', async () => {
  const gate = await entryGate({});
  const options = gate.parse(['--case', 'expression-preferences', '--timeout-seconds', '180']);
  assert.equal(options.timeout, 180);
  assert.equal(options.names[0], 'expression-preferences');
  await assert.rejects(gate.run(options), /page_test_environment/);
  assert.throws(() => gate.parse(['--case', 'expression-preferences', '--case', 'expression-preferences',
    '--timeout-seconds', '180']), /page_test_arguments/);
});

test('正式偏好页面拒绝缺失、仓库内或宽权限证据目录，均在租约和浏览器前失败', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'notalone-preference-gate-'));
  try {
    chmodSync(directory, 0o755);
    for (const evidence of [undefined, path.resolve('..'), directory]) {
      const gate = await entryGate({ CONDA_DEFAULT_ENV: 'NotAlone', CONDA_PREFIX: '/synthetic-unused',
        ...(evidence ? { NOTALONE_PREFERENCE_EVIDENCE_DIR: evidence } : {}) });
      const options = gate.parse(['--case', 'expression-preferences', '--timeout-seconds', '180']);
      await assert.rejects(gate.run(options), /page_test_environment/);
    }
  } finally { rmSync(directory, { recursive: true }); }
});
