import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test, after } from 'node:test';
import { build } from 'esbuild';

const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-header-diagnostics-')));
const built = await build({ entryPoints: ['src/main/foreground/header-change-diagnostics.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false });
await writeFile(path.join(directory, 'diagnostics.mjs'), built.outputFiles[0].text);
const { openHeaderChangeDiagnostics, NativeHeaderChangeDiagnosticDecoder } = await import(path.join(directory, 'diagnostics.mjs'));
after(() => rm(directory, { recursive: true, force: true }));

const record = { kind: 'host', event: 'reconcile', reason: 'no_permit', ordinal: 0, elapsedMs: 1, leaseElapsedMs: null,
  permitPresent: false, childPresent: false, resolving: false, blocked: false, freshProof: false,
  epochCurrent: true, paused: false, stopping: false, renewalEligible: false, code: null, signal: 'none' };

test('诊断默认关闭；显式新文件仅记录固定字段并拒覆盖、symlink和不私有父目录', async () => {
  assert.equal(openHeaderChangeDiagnostics({}), undefined);
  const output = path.join(directory, 'events.jsonl');
  const sink = openHeaderChangeDiagnostics({ NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE: output });
  assert.ok(sink);
  sink.record(record);
  sink.record({ ...record, secret: '禁止落盘' });
  sink.close();
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.deepEqual((await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse), [record]);
  assert.equal(openHeaderChangeDiagnostics({ NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE: output }), undefined);
  const link = path.join(directory, 'linked.jsonl');
  await symlink(output, link);
  assert.equal(openHeaderChangeDiagnostics({ NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE: link }), undefined);
  const publicDirectory = path.join(directory, 'not-private');
  await mkdir(publicDirectory, { mode: 0o755 });
  assert.equal(openHeaderChangeDiagnostics({ NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE: path.join(publicDirectory, 'events') }), undefined);
  assert.equal(openHeaderChangeDiagnostics({ NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE: 'relative.jsonl' }), undefined);
  const parentLink = path.join(directory, 'parent-link');
  await symlink(directory, parentLink);
  assert.equal(openHeaderChangeDiagnostics({ NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE: path.join(parentLink, 'new.jsonl') }), undefined);
});

test('宿主诊断行数与字节有界，关闭后无写入，非有限耗时和未知字段不落盘', async () => {
  const output = path.join(directory, 'bounded.jsonl');
  const sink = openHeaderChangeDiagnostics({ NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE: output });
  for (const invalid of [{ ...record, elapsedMs: NaN }, { ...record, elapsedMs: Infinity },
    { ...record, leaseElapsedMs: -1 }, { ...record, reason: 'private-value' }, { ...record, signal: 'private-value' }]) sink.record(invalid);
  for (let ordinal = 0; ordinal < 1000; ++ordinal) sink.record({ ...record, ordinal });
  sink.close(); sink.record(record);
  const bytes = await readFile(output);
  assert.equal(bytes.toString().trim().split('\n').length, 512);
  assert.ok(bytes.length <= 256 * 1024);
  assert.doesNotMatch(bytes.toString(), /private-value|NaN|Infinity/);
});

test('原生诊断只解析完整白名单行；未知、非有限、残行及32行/3840字节超限终止本源诊断', () => {
  const accepted = [], invalid = [];
  const decoder = new NativeHeaderChangeDiagnosticDecoder(record => accepted.push(record), () => invalid.push(true));
  decoder.push(Buffer.from('notalone-header-change-v1 streaming first_'));
  assert.equal(accepted.length, 0);
  decoder.push(Buffer.from('frame 12.5\nnotalone-header-change-v1 finished lease_expired 55001.25\n'));
  decoder.finish();
  assert.deepEqual(accepted, [{ stage: 'streaming', reason: 'first_frame', nativeElapsedMs: 12.5 },
    { stage: 'finished', reason: 'lease_expired', nativeElapsedMs: 55001.25 }]);
  assert.equal(invalid.length, 0);
  for (const raw of ['NSError private-value\n', 'notalone-header-change-v1 streaming private-value 1\n',
    'notalone-header-change-v1 unknown begin 1\n', 'notalone-header-change-v1 run begin NaN\n',
    'notalone-header-change-v1 run begin -1\n', 'notalone-header-change-v1 run begin 1e999\n',
    'notalone-header-change-v1 run begin 1\r\n', '界'.repeat(41), 'x'.repeat(120), 'x'.repeat(3841),
    'notalone-header-change-v1 run']) {
    const values = [], failures = [];
    const rejected = new NativeHeaderChangeDiagnosticDecoder(value => values.push(value), () => failures.push(true));
    rejected.push(Buffer.from(raw)); rejected.finish();
    rejected.push(Buffer.from('notalone-header-change-v1 run begin 0\n'));
    assert.equal(values.length, 0, raw);
    assert.equal(failures.length, 1, raw);
  }
  const values = [], failures = [];
  const limited = new NativeHeaderChangeDiagnosticDecoder(value => values.push(value), () => failures.push(true));
  limited.push(Buffer.from('notalone-header-change-v1 run begin 0\n'.repeat(33)));
  assert.equal(values.length, 32); assert.equal(failures.length, 1);
});
