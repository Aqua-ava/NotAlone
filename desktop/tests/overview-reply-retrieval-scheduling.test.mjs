import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

async function recordInput(file, source, executed) {
  if (!process.env.NOTALONE_REPLY_EVIDENCE_TEST_PROOF) return;
  await writeFile(path.join(process.env.NOTALONE_REPLY_EVIDENCE_TEST_PROOF, `scheduling-${path.basename(file)}-${process.pid}.json`),
    JSON.stringify({ path: path.resolve(file), bytes: Buffer.byteLength(source), sourceSha256: createHash('sha256').update(source).digest('hex'),
      executedBytes: Buffer.byteLength(executed), executedSha256: createHash('sha256').update(executed).digest('hex') }, null, 2),
    { mode: 0o600, flag: 'wx' });
}

test('概览回复验收仅由有限公开入口登记，证据目录按本组显式透传', async () => {
  const source = await readFile('scripts/test-pages.mjs', 'utf8');
  const start = source.indexOf('function parse('), end = source.indexOf('async function run(', start);
  assert.ok(start > 0 && end > start);
  const executed = `${source.slice(start, end)}; ({ parse, pageFixtureEnvironment });`;
  await recordInput('scripts/test-pages.mjs', source, executed);
  const { parse, pageFixtureEnvironment } = runInNewContext(executed, {
    path, desktop: process.cwd(),
  });
  const options = parse(['--case', 'overview-reply-retrieval', '--timeout-seconds', '180']);
  assert.equal(options.names[0], 'overview-reply-retrieval'); assert.equal(options.timeout, 180);
  const key = 'NOTALONE_REPLY_OVERVIEW_TEST_EVIDENCE_DIR', evidence = '/synthetic-private-evidence';
  assert.equal(pageFixtureEnvironment(options, { [key]: evidence })[key], evidence);
  assert.deepEqual(Object.keys(pageFixtureEnvironment({ names: ['reply-evidence'] }, { [key]: evidence })), []);
  for (const value of [undefined, '', 'relative-evidence', path.resolve('..'), path.resolve('../private-evidence')]) {
    assert.throws(() => pageFixtureEnvironment(options, { [key]: value }), /page_test_environment/);
  }
  for (const args of [
    ['--case', 'unknown-overview-reply', '--timeout-seconds', '180'],
    ['--case', 'overview-reply-retrieval', '--case', 'overview-reply-retrieval', '--timeout-seconds', '180'],
    ['--case', 'overview-reply-retrieval', '--timeout-seconds', '0'],
    ['--case', 'overview-reply-retrieval', '--timeout-seconds', '301'],
  ]) assert.throws(() => parse(args), /page_test_arguments/);
});

test('概览回复页面子门保留自有nonce与范围限制，不直接执行运行时', async () => {
  const source = await readFile('tests/headless/run.ts', 'utf8');
  const start = source.indexOf('if (!process.send'), end = source.indexOf('let browser:', start);
  assert.ok(start > 0 && end > start);
  const gate = source.slice(start, end).replace(' as string[]', '');
  await recordInput('tests/headless/run.ts', source, gate);
  const environment = { NOTALONE_PAGE_RUN_NONCE: 'a'.repeat(64), NOTALONE_PAGE_CASES: '["overview-reply-retrieval"]' };
  assert.throws(() => runInNewContext(gate, { process: { env: environment } }), /page_test_unapproved/);
  const process = { send() {}, env: environment };
  assert.doesNotThrow(() => runInNewContext(gate, { process }));
  for (const names of ['["unknown-overview-reply"]', '["overview-reply-retrieval","overview-reply-retrieval"]',
    '["overview-reply-retrieval","owner-facts-overview","contact-relationship-overview"]']) {
    process.env.NOTALONE_PAGE_CASES = names;
    assert.throws(() => runInNewContext(gate, { process }), /page_test_arguments/);
  }
});
