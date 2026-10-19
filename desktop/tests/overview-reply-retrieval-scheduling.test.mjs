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

test('双范围页面开关只透传，不把标志值当作证据目录或启动浏览器', async () => {
  const source = await readFile('scripts/test-pages.mjs', 'utf8');
  const start = source.indexOf('function parse('), end = source.lastIndexOf('\ntry {');
  const paths = [], environment = { CONDA_DEFAULT_ENV: 'NotAlone', CONDA_PREFIX: '/synthetic/python',
    NOTALONE_LAYERED_TEST_EVIDENCE_DIR: '/synthetic/evidence', NOTALONE_LAYERED_OWNER_CONTEXT: '1',
    NOTALONE_LAYERED_SCENARIO_READS: '1' };
  const { run, pageFixtureEnvironment } = runInNewContext(`${source.slice(start, end)}; ({run,pageFixtureEnvironment});`, {
    path, desktop: process.cwd(), process: { env: environment },
    realpath: async value => { paths.push(value); if (value === '1') throw new Error('ENOENT flag is not directory'); return value; },
    stat: async () => ({ isDirectory: () => true, mode: 0o700 }),
    acquireLease: async () => { throw new Error('SYNTHETIC_LEASE_STOP'); },
  });
  const options = { names: ['layered-reply'], mode: 'probe', id: 'synthetic-no-browser', timeout: 10 };
  assert.equal(pageFixtureEnvironment(options, environment).NOTALONE_LAYERED_OWNER_CONTEXT, '1');
  await assert.rejects(run(options), /SYNTHETIC_LEASE_STOP/);
  assert.deepEqual(paths, ['/synthetic/evidence']);
});

test('候选长历史可按原场景分别运行，环境选择仅传入对应页面并拒绝拼写错误', async () => {
  const source = await readFile('scripts/test-pages.mjs', 'utf8');
  const helper = source.slice(source.indexOf('function pageFixtureEnvironment('), source.indexOf('async function run('));
  const { pageFixtureEnvironment } = runInNewContext(`${helper}; ({ pageFixtureEnvironment });`, { path, desktop: process.cwd() });
  const key = 'NOTALONE_GROUP_BOUNDARIES_SCENE', options = { names: ['reply-strategy-group-boundaries'] };
  for (const value of ['suggest', 'express']) assert.equal(pageFixtureEnvironment(options, { [key]: value })[key], value);
  assert.equal(pageFixtureEnvironment({ names: ['reply-evidence'] }, { [key]: 'suggest' })[key], undefined);
  assert.equal(pageFixtureEnvironment(options, {})[key], undefined);
  for (const value of ['', 'both', 'suggest,express']) assert.throws(() => pageFixtureEnvironment(options, { [key]: value }), /page_test_environment/);
});
