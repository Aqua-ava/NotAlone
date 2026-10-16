import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function acceptancePorts(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-visual-evidence-'));
  try {
    const output = path.join(directory, 'acceptance.mjs');
    await build({ stdin: { contents: "export * from './tests/real-sync-visual-independence-acceptance.spec';",
      resolveDir: process.cwd(), loader: 'ts' }, outfile: output, bundle: true, platform: 'node', format: 'esm',
    logLevel: 'silent', plugins: [{ name: '仅登记验收，不执行App', setup(builder) {
      builder.onResolve({ filter: /^(\.\/real-sync-quit-fixture|\.\/app-fixture|\.\/app-test-gate|@playwright\/test)$/ },
        ({ path: request }) => ({ path: request, namespace: 'registration' }));
      builder.onLoad({ filter: /.*/, namespace: 'registration' }, ({ path: request }) => ({ contents:
        request === './real-sync-quit-fixture' ? `export const test = Object.assign(() => {}, {
          skip(value) { globalThis.visualSkipped = value; },
          use(value) { globalThis.visualOptions = value; }
        });` : request === './app-fixture' ? "export function selectMenu() { throw Error('禁止执行App'); }"
          : request === './app-test-gate' ? "export function verifyAppTestLease() { throw Error('禁止申请App'); }"
            : "export function expect() { throw Error('禁止执行App断言'); }", loader: 'js' }));
    } }] });
    await run(await import(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function fixturePorts(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-visual-fixture-'));
  try {
    const output = path.join(directory, 'fixture.mjs');
    await build({ entryPoints: ['tests/real-sync-quit-fixture.ts'], outfile: output, bundle: true,
      platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: '仅登记夹具，不启动后端', setup(builder) {
        builder.onResolve({ filter: /^(\.\/app-fixture|\.\/app-test-gate)$/ },
          ({ path: request }) => ({ path: request, namespace: 'fixture-registration' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture-registration' }, ({ path: request }) => ({ contents:
          request === './app-fixture' ? `export const test = { extend(options) { return options; } };
            export function isolatedAppEnvironment() { throw Error('禁止启动夹具'); }`
            : "export function verifyAppTestLease() { throw Error('禁止申请App'); }", loader: 'js' }));
      } }] });
    await run(await import(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('阶段后的真实tail必须有新PID、同PID成功退出及其后范围校验，旧结果不复用', async () => {
  await acceptancePorts(({ completedTailAfter }) => {
    const started = pid => ({ event: 'started', kind: 'tail', pid });
    const finished = (pid, returncode = 0) => ({ event: 'finished', kind: 'tail', pid, returncode });
    const accepted = { event: 'accepted', kind: 'tail', pid: null };
    assert.equal(completedTailAfter([started(11), finished(11), accepted], 0), true);
    assert.equal(completedTailAfter([started(11), finished(11), accepted], 1), false);
    assert.equal(completedTailAfter([started(null), finished(11), accepted], 0), false);
    assert.equal(completedTailAfter([started(11), finished(12), accepted], 0), false);
    assert.equal(completedTailAfter([started(11), finished(11, 1), accepted], 0), false);
    assert.equal(completedTailAfter([started(11), accepted, finished(11)], 0), false);
    assert.equal(completedTailAfter([started(11), finished(11)], 0), false);
    assert.equal(completedTailAfter([started(11), finished(11), started(null), accepted], 0), false);
    assert.equal(completedTailAfter([started(11), finished(11), { event: 'scope_rejected', kind: 'tail' }, accepted], 0), false);
    assert.equal(completedTailAfter([started(11), finished(11), accepted], -1), false);
  });
});

test('正式观察按阶段开始计数，助手零新调用，其他App须完整暂停且零采集/OCR', async () => {
  await acceptancePorts(({ visualPhaseEvidence }) => {
    const start = at => ({ kind: 'probe-start', started_at_ms: at });
    const result = (at, status, count) => ({ kind: 'probe', started_at_ms: at,
      outcome: 'returned', native_status: status, complete: true, valid: true, single_frame_requested: true,
      capture_requests: count, capture_completions: count, frames_received: count, header_ocr_calls: count });
    const recognized = [start(101), result(101, 'recognized', 1)];
    assert.equal(visualPhaseEvidence(recognized, 100, 'wechat').ready, true);
    assert.equal(visualPhaseEvidence(recognized, 102, 'wechat').ready, false);
    assert.equal(visualPhaseEvidence([], 100, 'helper').ready, true);
    assert.equal(visualPhaseEvidence([start(101)], 100, 'helper').invalid, true);
    assert.equal(visualPhaseEvidence([start(101)], 100, 'finder').ready, false);
    assert.equal(visualPhaseEvidence([start(101), result(101, 'paused', 0)], 100, 'finder').ready, true);
    assert.equal(visualPhaseEvidence([result(101, 'paused', 0)], 100, 'finder').ready, false);
    assert.equal(visualPhaseEvidence([start(101), result(101, 'paused', 1)], 100, 'finder').invalid, true);
    assert.equal(visualPhaseEvidence(recognized, 100, 'finder').invalid, true);
    assert.equal(visualPhaseEvidence([start(101), { ...result(101, 'paused', 0), complete: false }], 100, 'finder').invalid, true);
    assert.equal(visualPhaseEvidence([start(101), { ...result(101, 'paused', 0), outcome: 'timeout' }], 100, 'finder').invalid, true);
    assert.equal(visualPhaseEvidence([start(101), { ...result(101, 'recognized', 1), single_frame_requested: false }], 100, 'wechat').invalid, true);
    assert.equal(visualPhaseEvidence([{ kind: 'probe-start', started_at_ms: NaN }], 100, 'helper').invalid, true);
  });
});

test('微信完整零采集暂停只等待，首个合法recognized才固定测量起点', async () => {
  await acceptancePorts(({ wechatStageEvidence }) => {
    const start = at => ({ kind: 'probe-start', started_at_ms: at });
    const result = (at, status, count) => ({ kind: 'probe', started_at_ms: at,
      outcome: 'returned', native_status: status, complete: true, valid: true, single_frame_requested: true,
      capture_requests: count, capture_completions: count, frames_received: count, header_ocr_calls: count });
    const paused = [start(101), result(101, 'paused', 0)];
    const waiting = wechatStageEvidence(paused, 100);
    assert.equal(waiting.invalid, false, '实际旧阶段会把合法零采集暂停误拒');
    assert.equal(waiting.ready, false);
    assert.equal(waiting.startedAt, null);
    assert.equal(waiting.waitingCompleted, 1);
    const positive = wechatStageEvidence([...paused, start(105), result(105, 'recognized', 1)], 100);
    assert.equal(positive.invalid, false);
    assert.equal(positive.ready, true);
    assert.equal(positive.startedAt, 105);
    assert.equal(positive.waitingCompleted, 1);
  });
});

test('微信前置必须合法闭合，未知、坏计数、重复或逆序配对及正向后暂停均拒绝', async () => {
  await acceptancePorts(({ wechatStageEvidence }) => {
    const start = at => ({ kind: 'probe-start', started_at_ms: at });
    const result = (at, status = 'paused', count = 0) => ({ kind: 'probe', started_at_ms: at,
      outcome: 'returned', native_status: status, complete: true, valid: true, single_frame_requested: true,
      capture_requests: count, capture_completions: count, frames_received: count, header_ocr_calls: count });
    const pending = [start(101), start(105), result(105, 'recognized', 1)];
    assert.equal(wechatStageEvidence(pending, 100).startedAt, null);
    assert.equal(wechatStageEvidence(pending, 100).ready, false);
    assert.equal(wechatStageEvidence([...pending, result(101)], 100).startedAt, 105);
    for (const bad of [
      result(101, 'unknown'), result(101, 'paused', 1), result(101, 'recognized', 0),
      { ...result(101), outcome: 'timeout' }, { ...result(101), complete: false },
      { ...result(101), valid: false }, { ...result(101), single_frame_requested: false },
      { ...result(101), header_ocr_calls: 1 },
    ]) assert.equal(wechatStageEvidence([start(101), bad], 100).invalid, true);
    for (const rows of [[result(101)], [result(101), start(101)], [start(101), start(101)],
      [start(101), result(101), result(101)], [{ kind: 'probe-start', started_at_ms: NaN }]]) {
      assert.equal(wechatStageEvidence(rows, 100).invalid, true);
    }
    const positive = [start(105), result(105, 'recognized', 1)];
    assert.equal(wechatStageEvidence([...positive, start(110)], 100, 105).ready, false);
    const laterPaused = wechatStageEvidence([...positive, start(110), result(110)], 100, 105);
    assert.equal(laterPaused.startedAt, 105);
    assert.equal(laterPaused.invalid, true);
  });
});

test('助手等真实获焦才固定一次起点和CLI边界，失焦重获焦不重置或延长70秒', async () => {
  await acceptancePorts(({ helperStageEvidence }) => {
    const oldTail = [{ event: 'started', kind: 'tail', pid: 11 },
      { event: 'finished', kind: 'tail', pid: 11, returncode: 0 }, { event: 'accepted', kind: 'tail' }];
    const frame = { triggeredAt: 100, observedAt: 150, checkedAt: 151, auditObservedAt: 151,
      focused: false, rows: [{ kind: 'probe-start', started_at_ms: 110 }], audit: oldTail };
    const waiting = helperStageEvidence(undefined, frame);
    assert.equal(waiting.boundary.startedAt, null, 'Root信号不能代签首次原生获焦');
    assert.equal(waiting.ready, false);
    const focused = helperStageEvidence(waiting.boundary, { ...frame, focused: true, observedAt: 200,
      checkedAt: 202, auditObservedAt: 201 });
    assert.equal(focused.boundary.startedAt, 200);
    assert.equal(focused.boundary.checkpoint, 3);
    assert.equal(focused.boundary.checkpointObservedAt, 201);
    assert.equal(focused.ready, false, '起点前完成的tail不得复用');
    const fresh = [...oldTail, { event: 'started', kind: 'tail', pid: 12 },
      { event: 'finished', kind: 'tail', pid: 12, returncode: 0 }, { event: 'accepted', kind: 'tail' }];
    const blurred = helperStageEvidence(focused.boundary, { ...frame, observedAt: 300,
      checkedAt: 301, audit: fresh });
    assert.equal(blurred.ready, false);
    const regained = helperStageEvidence(blurred.boundary, { ...frame, focused: true, observedAt: 400,
      checkedAt: 401, audit: fresh });
    assert.equal(regained.boundary.startedAt, 200);
    assert.equal(regained.boundary.checkpoint, 3);
    assert.equal(regained.ready, true);
    const expired = helperStageEvidence(regained.boundary, { ...frame, focused: true, observedAt: 70_100,
      checkedAt: 70_100, audit: fresh });
    assert.equal(expired.boundary.deadlineAt, 70_100);
    assert.equal(expired.expired, true);
    assert.equal(expired.ready, false);
  });
});

test('助手失焦不掩盖起点后的新probe，晚获焦不增加预算，坏或未accepted的tail不能通过', async () => {
  await acceptancePorts(({ helperStageEvidence }) => {
    const base = { triggeredAt: 100, observedAt: 70_090, checkedAt: 70_091, auditObservedAt: 70_091,
      focused: true, rows: [], audit: [] };
    const first = helperStageEvidence(undefined, base);
    assert.equal(first.boundary.startedAt, 70_090);
    assert.equal(first.boundary.deadlineAt, 70_100);
    const started = { event: 'started', kind: 'tail', pid: 11 };
    const finished = { event: 'finished', kind: 'tail', pid: 11, returncode: 0 };
    const accepted = { event: 'accepted', kind: 'tail' };
    for (const audit of [[started], [started, finished], [started, { ...finished, returncode: 1 }, accepted]]) {
      assert.equal(helperStageEvidence(first.boundary, { ...base, audit }).ready, false);
    }
    const audit = [started, finished, accepted];
    assert.equal(helperStageEvidence(first.boundary, { ...base, checkedAt: 70_099, audit }).ready, true);
    assert.equal(helperStageEvidence(first.boundary, { ...base, checkedAt: 70_100, audit }).ready, false);
    const rows = [{ kind: 'probe-start', started_at_ms: 70_095 }];
    const blurred = helperStageEvidence(first.boundary, { ...base, focused: false, rows, audit });
    assert.equal(blurred.invalid, true);
    const regained = helperStageEvidence(blurred.boundary, { ...base, rows, audit });
    assert.equal(regained.invalid, true);
    assert.equal(regained.boundary.startedAt, 70_090);
    assert.equal(regained.boundary.checkpoint, 0);
    assert.equal(regained.ready, false);
  });
});

test('边界前在途探针保留原件及后来配对，不能冒充阶段内成功或掩盖新启动', async () => {
  await acceptancePorts(({ boundaryProbeEvidence, visualPhaseEvidence }) => {
    const started = { kind: 'probe-start', started_at_ms: 150 };
    const ended = { kind: 'probe', started_at_ms: 150, outcome: 'returned', native_status: 'recognized',
      complete: true, valid: true, single_frame_requested: true,
      capture_requests: 1, capture_completions: 1, frames_received: 1, header_ocr_calls: 1 };
    const pending = boundaryProbeEvidence([started], 200, 1);
    assert.deepEqual(pending.pendingBefore, [started]);
    assert.deepEqual(pending.stillPending, [started]);
    const completed = boundaryProbeEvidence([started, ended], 200, 1);
    assert.deepEqual(completed.pendingBefore, [started]);
    assert.deepEqual(completed.completedObservedLater, [ended]);
    assert.deepEqual(completed.stillPending, []);
    assert.equal(completed.completionWallClockCertified, false);
    assert.deepEqual(visualPhaseEvidence([started, ended], 200, 'helper'), {
      starts: 0, completed: 0, pending: 0, invalid: false, ready: true,
    });
    assert.equal(visualPhaseEvidence([started, ended, { ...started, started_at_ms: 201 }], 200, 'helper').invalid, true);
  });
});

test('真实视觉选项默认关闭，旧入口仍用unavailable-probe，显式模式拒绝旧E凭据混用', async () => {
  await fixturePorts(async ({ test: fixtures, visualObservationResources }) => {
    assert.deepEqual(fixtures.realSyncVisualObservation, [false, { option: true }]);
    const backend = { directory: '/synthetic-owned', scope: { real_cli: '/synthetic-cli' } };
    let configuration;
    await fixtures.launchConfiguration({ realSyncBackend: backend }, value => { configuration = value; });
    assert.equal(configuration.syncProbePath, '/synthetic-owned/unavailable-probe');
    await fixtures.launchConfiguration({ realSyncBackend: { ...backend, foreground: { probePath: '/synthetic-E' } } },
      value => { configuration = value; });
    assert.equal(configuration.syncProbePath, '/synthetic-E');
    await fixtures.launchConfiguration({ realSyncBackend: { ...backend, visualProbePath: '/synthetic-current/Resources/notalone-probe/notalone-sync-probe' } },
      value => { configuration = value; });
    assert.equal(configuration.syncProbePath, '/synthetic-current/Resources/notalone-probe/notalone-sync-probe');
    const env = { NOTALONE_REAL_SYNC_VISUAL_ACCEPTANCE: '1',
      NOTALONE_TEST_APP_EXECUTABLE: '/synthetic-final/NotAlone.app/Contents/MacOS/NotAlone' };
    const scope = { not_before: 1000, until: 1300 };
    assert.equal(visualObservationResources(env, scope, 1_400_000, 1_001_000),
      '/synthetic-final/NotAlone.app/Contents/Resources');
    assert.throws(() => visualObservationResources({}, scope, 1_400_000, 1_001_000));
    for (const key of ['NOTALONE_REAL_FOREGROUND_LOCATOR_ACCEPTANCE', 'NOTALONE_TEST_FOREGROUND_CREDENTIAL',
      'NOTALONE_REAL_FOREGROUND_MODE', 'NOTALONE_REAL_FOREGROUND_TARGET', 'NOTALONE_REAL_FOREGROUND_TARGET_SHA256']) {
      assert.throws(() => visualObservationResources({ ...env, [key]: '1' }, scope, 1_400_000, 1_001_000));
    }
    assert.throws(() => visualObservationResources({ ...env, NOTALONE_TEST_APP_EXECUTABLE: 'relative.app/Contents/MacOS/NotAlone' }, scope, 1_400_000, 1_001_000));
    assert.throws(() => visualObservationResources(env, { ...scope, not_before: NaN }, 1_400_000, 1_001_000));
    assert.throws(() => visualObservationResources(env, scope, 1_200_000, 1_001_000));
    assert.throws(() => visualObservationResources(env, { ...scope, not_before: 0 }, 1_400_000, 1_001_000));
  });
});

test('验收入口默认skip并关闭录屏截图追踪，不执行用例回调', async () => {
  const original = process.env.NOTALONE_REAL_SYNC_VISUAL_ACCEPTANCE;
  try {
    delete process.env.NOTALONE_REAL_SYNC_VISUAL_ACCEPTANCE;
    await acceptancePorts(() => {
      assert.equal(globalThis.visualSkipped, true);
      assert.deepEqual(globalThis.visualOptions, { realSyncVisualObservation: false,
        trace: 'off', screenshot: 'off', video: 'off' });
    });
    process.env.NOTALONE_REAL_SYNC_VISUAL_ACCEPTANCE = '1';
    await acceptancePorts(() => {
      assert.equal(globalThis.visualSkipped, false);
      assert.equal(globalThis.visualOptions.realSyncVisualObservation, true);
    });
  } finally {
    if (original === undefined) delete process.env.NOTALONE_REAL_SYNC_VISUAL_ACCEPTANCE;
    else process.env.NOTALONE_REAL_SYNC_VISUAL_ACCEPTANCE = original;
  }
});

test('受控启动器在真实server argv下安装原测量器，诊断模块不会误装', async () => {
  assert.equal(process.env.CONDA_DEFAULT_ENV, 'NotAlone', '本合成Python检查须激活NotAlone');
  await fixturePorts(async ({ prepareVisualObservationMeasurements }) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-visual-launcher-'));
    try {
      const python = path.join(process.env.CONDA_PREFIX, 'bin/python');
      const controlled = path.join(directory, 'controlled-python');
      // 合成启动器只退出，不执行参数里的 server 模块、CLI、探针或 App。
      await writeFile(controlled, `#!${python}\nprint("synthetic_only")\n`, { mode: 0o700 });
      const fixture = { directory, pythonExecutable: controlled,
        environment: () => ({ PYTHONPATH: path.resolve('../backend/src'), PYTHONNOUSERSITE: '1' }) };
      await prepareVisualObservationMeasurements(fixture, path.join(directory, 'never-run-probe'));
      const record = path.join(directory, 'observation-measurements.jsonl');
      const invoke = module => execute(controlled, ['-m', module], { env: fixture.environment(), timeout: 15_000 });
      assert.equal((await invoke('notalone.server.startup_diagnostics')).stdout.trim(), 'synthetic_only');
      const { readFile } = await import('node:fs/promises');
      assert.equal(await readFile(record, 'utf8'), '');
      const result = await invoke('notalone.server.command');
      assert.equal(result.stdout.trim(), 'synthetic_only');
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse((await readFile(record, 'utf8')).trim()), { kind: 'installed' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
