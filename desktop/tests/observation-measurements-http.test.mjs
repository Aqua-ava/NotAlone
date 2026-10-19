import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { build } from 'esbuild';

test('测量夹具接入真实认证HTTP且不改变非微信暂停结果', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-measurement-http-'));
  try {
    const compiled = await build({ stdin: { contents: [
      "export { withBindingFixture } from './tests/binding-backend-fixture';",
      "export { prepareObservationMeasurements, readObservationMeasurements } from './tests/observation-measurements-fixture';",
    ].join('\n'), resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
    const modulePath = path.join(directory, 'fixture.mjs');
    await writeFile(modulePath, compiled.outputFiles[0].text);
    const ports = await import(modulePath);
    await ports.withBindingFixture('notalone-measured-http-', 'single-account', async fixture => {
      const probe = path.join(fixture.directory, 'synthetic-probe');
      await writeFile(probe, `#!${fixture.pythonExecutable}
import json, sys
if sys.argv[1:] == ['--session-worker', '--json']:
    print(json.dumps({'version': 1, 'event': 'ready'}), flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        assert set(request) == {'version', 'request_id', 'operation'}
        assert request['version'] == 1 and request['operation'] == 'observe'
        print(json.dumps({'version': 1, 'request_id': request['request_id'],
            'result': {'ok': True, 'wechat_in_front': False}}), flush=True)
else:
    raise ValueError('本轮测量须通过常驻观察协议。')
`, { mode: 0o700 });
      await ports.prepareObservationMeasurements(fixture, probe);
      await fixture.startBackend();
      assert.deepEqual(await ports.readObservationMeasurements(fixture), [{ kind: 'installed' }]);
      assert.equal((await fixture.request('/api/sync/enable', {})).status, 200);
      const before = (await ports.readObservationMeasurements(fixture)).filter(record => record.kind === 'probe').length;
      const observed = await fixture.request('/api/sync/foreground/observe', {});
      assert.equal(observed.status, 200);
      assert.equal(observed.data.phase, 'paused');
      assert.equal(observed.data.wechat_in_front, false);
      const records = await ports.readObservationMeasurements(fixture);
      const native = records.filter(record => record.kind === 'probe');
      assert.equal(native.length - before, 1, '本次明确观察增加一轮；开启同步的既有观察另计');
      assert.equal(native[0].capture_requests, 0);
      assert.equal(native[0].transport, 'worker');
      assert.equal(native[0].outcome, 'returned');
      assert.equal(native[0].native_status, 'paused');
      assert.ok(native[0].elapsed_ms >= 0);
      assert.equal(native[0].complete, false, 'worker未返回原生stderr，不能签发完整图帧或OCR测量');
      assert.equal(native[0].valid, false);
      assert.equal(native[0].native_ms, null);
      assert.equal(native[0].capture_ms, null);
      assert.equal(native[0].ocr_ms, null);
      assert.equal(records.filter(record => record.kind === 'backend').length, 1);
      assert.equal(records.some(record => Object.hasOwn(record, 'display_name')), false);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
