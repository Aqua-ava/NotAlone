import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

async function observationPorts(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-smoke-observation-'));
  try {
    const output = path.join(directory, 'acceptance.mjs');
    await build({ entryPoints: ['tests/reply-model-smoke-app-acceptance.spec.ts'], outfile: output,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: '仅登记，不运行App或后端', setup(builder) {
        builder.onResolve({ filter: /^(\.\/reply-model-smoke-fixture|\.\/app-fixture|\.\/app-test-gate|\.\/foreground-confirmation-actions|@playwright\/test)$/ },
          ({ path: request }) => ({ path: request, namespace: 'registration' }));
        builder.onLoad({ filter: /.*/, namespace: 'registration' }, ({ path: request }) => ({ contents:
          request === './reply-model-smoke-fixture' ? `export const test = Object.assign(() => {}, { skip() {}, use() {} });`
            : request === './app-fixture' ? `export function selectMenu() { throw Error('禁止启动App'); }`
              : request === './app-test-gate' ? `export function verifyAppTestLease() { throw Error('禁止领取租约'); }`
                : request === './foreground-confirmation-actions' ? `export function confirmHelperContact() { throw Error('禁止操作App'); }`
                  : `export function expect() { throw Error('禁止执行App断言'); }`, loader: 'js' }));
      } }] });
    await run(await import(output), directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const inspection = () => ({ counts: { message: 0, source_document: 0, confirmed_memory: 0,
  memory_candidate: 0, background_task: 0, reply_request: 1 }, reply_states: ['completed'],
  responses: 1, response_model_matches: true, status_codes: [200], failure_kind: null });

test('完成等待超时保留实际idle与waiting、脱敏inspect并重抛原异常', async () => {
  await observationPorts(async ({ observeReplySmokeCompletion }, directory) => {
    const file = path.join(directory, 'observations.json');
    const original = new Error('合成poll超时');
    const states = [{ phase: 'waiting', resultPresent: false }, { phase: 'idle', resultPresent: false }];
    let time = 100;
    await assert.rejects(observeReplySmokeCompletion({
      read: async () => states.shift(),
      poll: async read => {
        assert.equal(await read(), 'pending');
        const during = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(during.pollState, 'waiting');
        assert.equal(during.samples.length, 1, '下一次poll前已有本次实际状态');
        assert.equal(await read(), 'pending');
        throw original;
      },
      inspect: async () => inspection(), now: () => time++,
      persist: record => writeFile(file, JSON.stringify(record), { mode: 0o600 }),
    }), error => error === original);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(saved.samples, [
      { sampledAtMs: 100, phase: 'waiting', errorCode: null, resultPresent: false, readFailed: false },
      { sampledAtMs: 101, phase: 'idle', errorCode: null, resultPresent: false, readFailed: false },
    ]);
    assert.equal(saved.pollState, 'failed');
    assert.equal(saved.inspection.state, 'ok');
    assert.deepEqual(saved.inspection.replyStates, ['completed']);
    assert.equal(saved.inspection.provider.responses, 1);
  });
});

test('inspect失败单列且不记录错误正文或替换原poll异常', async () => {
  await observationPorts(async ({ observeReplySmokeCompletion }, directory) => {
    const file = path.join(directory, 'observations.json');
    const original = new Error('原poll失败');
    await assert.rejects(observeReplySmokeCompletion({
      read: async () => ({ phase: 'waiting', errorCode: null, resultPresent: false }),
      poll: async read => { await read(); throw original; },
      inspect: async () => { throw new Error('private-token-never-record'); }, now: () => 200,
      persist: record => writeFile(file, JSON.stringify(record), { mode: 0o600 }),
    }), error => error === original);
    const raw = await readFile(file, 'utf8');
    assert.deepEqual(JSON.parse(raw).inspection, { state: 'failed', observedAtMs: 200 });
    assert.equal(raw.includes('private-token'), false);
  });
});

test('allowlist拒绝任意正文、身份与未知值，inspect完成不能代签poll完成', async () => {
  await observationPorts(async ({ observeReplySmokeCompletion }, directory) => {
    const file = path.join(directory, 'observations.json');
    const original = new Error('原等待到期');
    await assert.rejects(observeReplySmokeCompletion({
      read: async () => ({ phase: 'private-phase', errorCode: 'private-error', resultPresent: 'private-result',
        candidate: 'private-body', contactId: 'private-identity' }),
      poll: async read => { assert.equal(await read(), 'pending'); throw original; },
      inspect: async () => ({ ...inspection(), token: 'private-token', result: 'private-body',
        counts: { ...inspection().counts, contact: 'private-identity' }, reply_states: ['completed', 'private-state'],
        status_codes: [200, 'private-status'], failure_kind: 'private-failure' }), now: () => 300,
      persist: record => writeFile(file, JSON.stringify(record), { mode: 0o600 }),
    }), error => error === original);
    const raw = await readFile(file, 'utf8'), saved = JSON.parse(raw);
    assert.equal(raw.includes('private-'), false);
    assert.deepEqual(saved.samples[0], { sampledAtMs: 300, phase: 'unknown', errorCode: 'unknown',
      resultPresent: null, readFailed: false });
    assert.deepEqual(saved.inspection.replyStates, ['completed', 'unknown']);
    assert.deepEqual(saved.inspection.provider.statusCodes, [200, null]);
    assert.equal(saved.inspection.provider.failureKind, 'unknown');
    assert.equal(saved.pollState, 'failed');
  });
});

test('读取错误与持久化错误都不覆盖原失败，没有原失败时存盘故障明确失败', async () => {
  await observationPorts(async ({ observeReplySmokeCompletion }) => {
    const original = new Error('原renderer读取失败');
    let saved;
    await assert.rejects(observeReplySmokeCompletion({
      read: async () => { throw original; }, poll: async read => { await read(); },
      inspect: async () => inspection(), now: () => 400,
      persist: async record => { saved = structuredClone(record); throw new Error('合成存盘失败'); },
    }), error => error === original);
    assert.equal(saved.samples[0].readFailed, true);
    assert.equal(saved.samples[0].resultPresent, null);
    assert.equal(saved.persistenceFailed, true);
    await assert.rejects(observeReplySmokeCompletion({
      read: async () => ({ phase: 'ready', resultPresent: true }), poll: async read => { assert.equal(await read(), 'completed'); },
      inspect: async () => inspection(), persist: async () => { throw new Error('合成存盘失败'); },
    }), /本场模型完成观测写入未确认/);
  });
});

test('实际候选或failed仍沿原谓词结束，记录观察不改变业务终态', async () => {
  await observationPorts(async ({ observeReplySmokeCompletion }, directory) => {
    for (const [phase, errorCode, resultPresent, expected] of [
      ['ready', null, true, 'completed'], ['failed', 'timeout', false, 'failed'],
    ]) {
      const file = path.join(directory, `${expected}.json`);
      await observeReplySmokeCompletion({
        read: async () => ({ phase, errorCode, resultPresent }),
        poll: async read => { assert.equal(await read(), expected); },
        inspect: async () => inspection(), now: () => 500,
        persist: record => writeFile(file, JSON.stringify(record), { mode: 0o600 }),
      });
      const saved = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(saved.pollState, 'settled');
      assert.deepEqual(saved.samples[0], { sampledAtMs: 500, phase, errorCode, resultPresent, readFailed: false });
    }
  });
});
