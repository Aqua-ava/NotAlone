import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

async function ports(use) {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-header-native-ports-'));
  try {
    const output = path.join(directory, 'ports.mjs');
    await build({ entryPoints: ['tests/header-change-native-acceptance.spec.ts'], outfile: output,
      platform: 'node', format: 'esm', bundle: true, logLevel: 'silent', plugins: [{
        name: '只登记原生验收，不执行用例', setup(builder) {
          builder.onResolve({ filter: /^(@playwright\/test|\.\/app-test-gate)$/ },
            ({ path: request }) => ({ path: request, namespace: 'registration' }));
          builder.onLoad({ filter: /.*/, namespace: 'registration' }, ({ path: request }) => ({
            contents: request === '@playwright/test'
              ? `export const test = Object.assign(() => {}, {
                  skip(value) { globalThis.headerNativeSkipped = value; }, use() {}
                }); export function expect() { throw Error('禁止执行原生验收'); }`
              : `export function spawnApp() { throw Error('禁止启动原生进程'); }
                 export function verifyAppTestLease() { throw Error('禁止申请启动'); }`, loader: 'js',
          }));
        },
      }] });
    await use(await import(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('原生辅助诊断只接受固定枚举与有限非负毫秒，并限制完整字节和行数', async () => {
  await ports(({ parseHeaderDiagnostics }) => {
    assert.deepEqual(parseHeaderDiagnostics(Buffer.from('notalone-header-change-v1 streaming first_frame 12.5\n')),
      [{ stage: 'streaming', reason: 'first_frame', elapsedMs: 12.5 }]);
    for (const raw of [
      'NSError private-contact\n', 'notalone-header-change-v1 streaming private-name 1\n',
      'notalone-header-change-v1 unknown begin 1\n', 'notalone-header-change-v1 run begin NaN\n',
      'notalone-header-change-v1 run begin -1\n', 'notalone-header-change-v1 run begin 1e999\n',
      'notalone-header-change-v1 run begin 1\n'.repeat(33), '界'.repeat(41),
    ]) assert.throws(() => parseHeaderDiagnostics(Buffer.from(raw)));
    assert.throws(() => parseHeaderDiagnostics(Buffer.from([0xff, 10])));
    assert.deepEqual(parseHeaderDiagnostics(Buffer.from('notalone-header-change-v1 run'), false), []);
    assert.throws(() => parseHeaderDiagnostics(Buffer.from('notalone-header-change-v1 run')));
  });
});

test('独立入口默认关闭且只接受规范绝对当前App路径', async () => {
  const original = process.env.NOTALONE_HEADER_CHANGE_NATIVE_ACCEPTANCE;
  try {
    delete process.env.NOTALONE_HEADER_CHANGE_NATIVE_ACCEPTANCE;
    await ports(({ nativeAcceptanceResources }) => {
      assert.equal(globalThis.headerNativeSkipped, true);
      assert.equal(nativeAcceptanceResources('/synthetic/NotAlone.app/Contents/MacOS/NotAlone'),
        '/synthetic/NotAlone.app/Contents/Resources');
      for (const selected of [undefined, 'relative/NotAlone.app/Contents/MacOS/NotAlone',
        '/synthetic/../NotAlone.app/Contents/MacOS/NotAlone', '/synthetic/other-helper']) {
        assert.throws(() => nativeAcceptanceResources(selected));
      }
    });
    process.env.NOTALONE_HEADER_CHANGE_NATIVE_ACCEPTANCE = '1';
    await ports(() => assert.equal(globalThis.headerNativeSkipped, false));
  } finally {
    if (original === undefined) delete process.env.NOTALONE_HEADER_CHANGE_NATIVE_ACCEPTANCE;
    else process.env.NOTALONE_HEADER_CHANGE_NATIVE_ACCEPTANCE = original;
  }
});

test('辅助stdout严格只收changed和paused，正式stdout仅输出状态与九个数值', async () => {
  await ports(({ parseSourceEvents, summarizeFormalProbe }) => {
    assert.deepEqual(parseSourceEvents(Buffer.from('{"event":"changed"}\n{"event":"paused"}\n')), ['changed', 'paused']);
    for (const raw of ['{"event":"changed","name":"private"}\n', '{"event":"private"}\n',
      '{"event":"changed"}\n'.repeat(242), 'not-json\n']) {
      assert.throws(() => parseSourceEvents(Buffer.from(raw)));
    }
    const events = ['started', 'foregroundAccepted', 'captureRequested', 'captureCompleted',
      'frameReceived', 'headerOcrStarted', 'headerOcrCompleted', 'finished'];
    const stderr = events.map((event, index) => `notalone-observation-v1 ${event} ${10 + index / 10}\n`).join('');
    const stdout = JSON.stringify({ ok: true, wechat_in_front: true, capture_version: 'automatic-header-v3',
      display_name: '禁止输出的合成名称', quality: { layout_verified: true, name_complete: true, display_name_confidence: 0.99 } });
    const summary = summarizeFormalProbe(stdout, Buffer.from(stderr), 1000, 900);
    assert.deepEqual(summary, { status: 'recognized', startedAtMs: 1000, elapsedMs: 900,
      nativeMs: 700, captureMs: 100, ocrMs: 100, captureRequests: 1, captureCompletions: 1, framesReceived: 1, headerOcrCalls: 1 });
    assert(!JSON.stringify(summary).includes('禁止输出'));
    const low = summarizeFormalProbe(JSON.stringify({ ok: true, wechat_in_front: true,
      capture_version: 'automatic-header-v3', display_name: '合成低置信度名称',
      quality: { layout_verified: true, name_complete: true, display_name_confidence: 0.5 } }),
    Buffer.from(stderr), 2000, 900);
    assert.equal(low.status, 'low-confidence');
    assert.equal(low.framesReceived, 1); assert.equal(low.headerOcrCalls, 1);
    assert.equal([summary, low].filter(row => row.status === 'recognized').length, 1);
    assert(!JSON.stringify(low).includes('合成低置信度名称'));
    for (const raw of [stderr + 'raw-private-error\n', stderr.replace('finished', 'unknown'),
      stderr.replace('10.1', 'NaN'), stderr.replace('captureCompleted', 'captureRequested')]) {
      assert.throws(() => summarizeFormalProbe(stdout, Buffer.from(raw), 1000, 900));
    }
    assert.throws(() => summarizeFormalProbe('{"ok":true}', Buffer.from(stderr), 1000, 900));
    assert.throws(() => summarizeFormalProbe(stdout, Buffer.from(stderr.replace('10.7', '1e308')), 1000, 900));
    const paused = summarizeFormalProbe('{"ok":true,"wechat_in_front":false}',
      Buffer.from('notalone-observation-v1 started 10\nnotalone-observation-v1 finished 10.1\n'), 1000, 100);
    assert.equal(paused.status, 'paused'); assert.equal(paused.framesReceived, 0);
  });
});
