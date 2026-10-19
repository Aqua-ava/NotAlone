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

test('正式观察计时只接收固定事件与有限数值，不记录姓名或联系人标识', async () => {
  const output = path.join(directory, 'observation.jsonl');
  const sink = openHeaderChangeDiagnostics({ NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE: output });
  const metric = { kind: 'observation', ordinal: 1, elapsedMs: 10, event: 'result_published',
    durationMs: 154, changedContact: true, confirmed: true, phase: 'confirmed' };
  for (const bad of [{ ...metric, event: 'private-name' }, { ...metric, durationMs: Infinity },
    { ...metric, durationMs: -1 }, { ...metric, confirmed: 'true' }, { ...metric, contactId: 'synthetic' },
    { ...metric, name: '合成名称' }]) sink.record(bad);
  sink.record(metric); sink.close();
  assert.deepEqual((await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse), [metric]);
});

test('最终帧分账只接受三个有界计数，饱和显式标记且每源仅一次', async () => {
  const accepted=[],invalid=[];
  const decoder=new NativeHeaderChangeDiagnosticDecoder(value=>accepted.push(value),()=>invalid.push(true));
  decoder.push(Buffer.from('notalone-header-counts-v1 final 1 5 2 1000\n'));
  decoder.push(Buffer.from('notalone-header-counts-v1 final 1 6 3 1001\n'));decoder.finish();
  assert.deepEqual(accepted,[{kind:'native-counts',status:'final',initialImages:1,screenCallbacks:5,
    processedFrames:2,nativeElapsedMs:1000}]);
  assert.equal(invalid.length,1);
  const saturated=[];
  const maximum=new NativeHeaderChangeDiagnosticDecoder(value=>saturated.push(value),()=>assert.fail('合法饱和计数被拒绝'));
  maximum.push(Buffer.from('notalone-header-counts-v1 saturated 1 4294967295 240 1000\n'));maximum.finish();
  assert.equal(saturated[0].status,'saturated');assert.equal(saturated[0].screenCallbacks,4294967295);
  const output=path.join(directory,'counts.jsonl');
  const sink=openHeaderChangeDiagnostics({NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE:output});
  sink.record({ordinal:1,elapsedMs:10,...accepted[0]});
  for(const value of [{...accepted[0],processedFrames:241},{...accepted[0],screenCallbacks:1},
    {...accepted[0],initialImages:2},{...accepted[0],status:'saturated'},
    {...accepted[0],privateImage:'private-pixels'}, {...accepted[0],screenCallbacks:Infinity}]) {
    sink.record({ordinal:1,elapsedMs:10,...value});
  }
  sink.close();
  assert.deepEqual((await readFile(output,'utf8')).trim().split('\n').map(JSON.parse),
    [{ordinal:1,elapsedMs:10,...accepted[0]}]);
  for(const raw of ['final 2 5 2 1','final 1 4294967296 240 1','final 1 1 2 1',
    'final 1 250 241 1','saturated 1 5 2 1','final 1 5 2 NaN','final 1 5 2 1 name=private']){
    const values=[],failures=[];
    const rejected=new NativeHeaderChangeDiagnosticDecoder(value=>values.push(value),()=>failures.push(true));
    rejected.push(Buffer.from(`notalone-header-counts-v1 ${raw}\n`));rejected.finish();
    assert.equal(values.length,0,raw);assert.equal(failures.length,1,raw);
  }
});

test('实例零与多个仅接受固定不可读分类，旧ambiguous兼容且不接受数量或匹配位', async () => {
  const accepted = [], failures = [];
  const decoder = new NativeHeaderChangeDiagnosticDecoder(value => accepted.push(value), () => failures.push(true));
  decoder.push(Buffer.from('notalone-header-context-v1 instances_zero ------ 1\n'
    + 'notalone-header-context-v1 instances_multiple ------ 2\n'
    + 'notalone-header-context-v1 instances_ambiguous ------ 3\n'));
  decoder.finish();
  assert.deepEqual(accepted.map(value => value.reason), ['instances_zero', 'instances_multiple', 'instances_ambiguous']);
  assert.ok(accepted.every(value => value.processMatches === null && value.windowMatches === null));
  assert.deepEqual(failures, []);
  const output = path.join(directory, 'instances.jsonl');
  const sink = openHeaderChangeDiagnostics({ NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE: output });
  for (const value of accepted) sink.record({ ordinal: 1, elapsedMs: 4, ...value });
  sink.record({ ordinal: 1, elapsedMs: 4, ...accepted[0], count: 770001 });
  sink.close();
  assert.equal((await readFile(output, 'utf8')).trim().split('\n').length, 3);
  assert.doesNotMatch(await readFile(output, 'utf8'), /770001|count/);
  for (const raw of ['instances_zero 111111', 'instances_multiple 000000', 'instances_770001 ------']) {
    const values = [], invalid = [];
    const rejected = new NativeHeaderChangeDiagnosticDecoder(value => values.push(value), () => invalid.push(true));
    rejected.push(Buffer.from(`notalone-header-context-v1 ${raw} 1\n`)); rejected.finish();
    assert.equal(values.length, 0); assert.equal(invalid.length, 1);
  }
});

test('上下文诊断仅接受固定拒绝分类及六个匹配布尔，私有sink不落身份原值', async () => {
  const accepted = [], invalid = [];
  const decoder = new NativeHeaderChangeDiagnosticDecoder(value => accepted.push(value), () => invalid.push(true));
  decoder.push(Buffer.from('notalone-header-context-v1 identity_mismatch 10'));
  decoder.push(Buffer.from('1111 12.5\nnotalone-header-context-v1 windows_ambiguous ------ 13\n'));
  decoder.finish();
  const mismatch = { kind: 'native-context', reason: 'identity_mismatch', nativeElapsedMs: 12.5,
    processMatches: true, windowMatches: false, originMatches: true, sizeMatches: true,
    versionMatches: true, buildMatches: true };
  const unavailable = { kind: 'native-context', reason: 'windows_ambiguous', nativeElapsedMs: 13,
    processMatches: null, windowMatches: null, originMatches: null, sizeMatches: null,
    versionMatches: null, buildMatches: null };
  assert.deepEqual(accepted, [mismatch, unavailable]);
  assert.equal(invalid.length, 0);
  const output = path.join(directory, 'context.jsonl');
  const sink = openHeaderChangeDiagnostics({ NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE: output });
  for (const value of accepted) sink.record({ ordinal: 1, elapsedMs: 20, ...value });
  for (const value of [{ ...mismatch, processId: 770001 }, { ...mismatch, windowMatches: true },
    { ...mismatch, processMatches: 770001 }, { ...unavailable, windowMatches: false },
    { ...unavailable, reason: 'private-window-title' }]) sink.record({ ordinal: 1, elapsedMs: 20, ...value });
  sink.close();
  assert.deepEqual((await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse),
    accepted.map(value => ({ ordinal: 1, elapsedMs: 20, ...value })));
  assert.doesNotMatch(await readFile(output, 'utf8'), /770001|private-window-title/);
  for (const raw of ['identity_mismatch 111111', 'identity_mismatch ------',
    'windows_ambiguous 101111', 'private_window ------', 'identity_mismatch 770001',
    'identity_mismatch 101111 pid=7']) {
    const records = [], failures = [];
    const rejected = new NativeHeaderChangeDiagnosticDecoder(value => records.push(value), () => failures.push(true));
    rejected.push(Buffer.from(`notalone-header-context-v1 ${raw} 1\n`)); rejected.finish();
    assert.equal(records.length, 0, raw); assert.equal(failures.length, 1, raw);
  }
});

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

test('私有时钟锚点仅一条有限数值，非法范围不占首次且计入原共享限额', async () => {
  assert.equal(openHeaderChangeDiagnostics({}), undefined);
  const anchor = { kind: 'clock-anchor', elapsedMs: 2.5, epochMs: 1792000000000, sampleSpanMs: 0.5 };
  const output = path.join(directory, 'clock.jsonl');
  const sink = openHeaderChangeDiagnostics({ NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE: output });
  for (const invalid of [{ ...anchor, epochMs: NaN }, { ...anchor, epochMs: Infinity },
    { ...anchor, epochMs: -1 }, { ...anchor, epochMs: 1.25 }, { ...anchor, epochMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...anchor, elapsedMs: -1 }, { ...anchor, sampleSpanMs: -1 }, { ...anchor, sampleSpanMs: Infinity },
    { ...anchor, elapsedMs: 0.1, sampleSpanMs: 1 }, { ...anchor, name: 'private-clock-value' }]) sink.record(invalid);
  sink.record(anchor);
  sink.record({ ...anchor, epochMs: 1792000001000 });
  for (let ordinal = 0; ordinal < 5000; ordinal++) sink.record({ ...record, ordinal });
  sink.close(); sink.record(anchor);
  const text = await readFile(output, 'utf8'), rows = text.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows[0], anchor);
  assert.equal(rows.filter(row => row.kind === 'clock-anchor').length, 1);
  assert.equal(rows.length, 4096);
  assert.ok(Buffer.byteLength(text) <= 2 * 1024 * 1024);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.doesNotMatch(text, /private-clock-value|NaN|Infinity/);
});

test('宿主诊断行数与字节有界，关闭后无写入，非有限耗时和未知字段不落盘', async () => {
  const output = path.join(directory, 'bounded.jsonl');
  const sink = openHeaderChangeDiagnostics({ NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE: output });
  for (const invalid of [{ ...record, elapsedMs: NaN }, { ...record, elapsedMs: Infinity },
    { ...record, leaseElapsedMs: -1 }, { ...record, reason: 'private-value' }, { ...record, signal: 'private-value' }]) sink.record(invalid);
  for (let ordinal = 0; ordinal < 5000; ++ordinal) sink.record({ ...record, ordinal });
  sink.close(); sink.record(record);
  const bytes = await readFile(output);
  assert.equal(bytes.toString().trim().split('\n').length, 4096);
  assert.ok(bytes.length <= 2 * 1024 * 1024);
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
