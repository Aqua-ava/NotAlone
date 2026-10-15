import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAcceptanceCoordinator } from '../acceptance-coordinator.mjs';

async function scenario(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-coordinate-'));
  let tick = 0;
  let alive = true;
  let onWait = async () => {};
  const coordinator = await createAcceptanceCoordinator({ directory, pid: 12345,
    checkLease: async () => { if (tick >= 1000) throw new Error('expired'); },
    isAlive: () => alive, now: () => tick,
    wait: async () => { tick += 250; await onWait(); } });
  const state = async () => JSON.parse(await readFile(path.join(directory, 'control-state.json'), 'utf8'));
  const signal = async (stage, token = coordinator.runId) => writeFile(path.join(directory, `${stage}.trigger`), token);
  try { await run({ coordinator, state, signal, setWait: fn => { onWait = fn; },
    exit: () => { alive = false; }, time: () => tick }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('失败留在同一实例，旧结束信号无效，当前结束信号才释放', () => scenario(async ({ coordinator, state, signal, setWait, time }) => {
  await signal('finish', 'previous-run');
  setWait(async () => {
    const current = await state();
    assert.equal(current.state, 'failed-held');
    assert.equal(current.pid, 12345);
    if (time() === 500) await signal('finish');
  });
  assert.equal(await coordinator.holdFailure(), 'finished');
  assert.equal(time(), 500);
  assert.equal((await state()).state, 'closing');
}));

test('助手焦点或旧观察不能开启识别计时，新前台观察才放行', () => scenario(async ({ coordinator, state, setWait, time }) => {
  setWait(async () => assert.equal((await state()).state, 'waiting-foreground'));
  await coordinator.waitForForeground('baseline', async () => ({
    helperBlurred: time() >= 250, wechatInFront: true, freshObservation: time() >= 500,
  }), 750);
  assert.equal(time(), 500);
}));

test('前台一直未确认时停在前置检查，不进入识别阶段', () => scenario(async ({ coordinator, state }) => {
  await assert.rejects(coordinator.waitForForeground('baseline', async () => ({
    helperBlurred: true, wechatInFront: false, freshObservation: true,
  }), 500), /acceptance_lease_ended/);
  assert.equal((await state()).state, 'waiting-user');
}));

test('前台未知及探针超时分开记录，不写入原始错误或标题', () => scenario(async ({ coordinator, state }) => {
  await assert.rejects(coordinator.waitForForeground('baseline', async () => ({
    helperBlurred: true, wechatInFront: false, freshObservation: true,
    probeAvailable: false, unavailable: true, foregroundUnknown: true, probeTimedOut: false,
    reason: 'PRIVATE_WINDOW_TITLE',
  }), 500), /acceptance_lease_ended/);
  const snapshot = await state();
  assert.equal(snapshot.foreground.foregroundUnknown, true);
  assert.equal(snapshot.foreground.probeAvailable, false);
  assert.equal(snapshot.foreground.unavailable, true);
  assert.equal(snapshot.foreground.probeTimedOut, false);
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_WINDOW_TITLE'));
}));

test('保留检查期间进程退出，不重新创建实例', () => scenario(async ({ coordinator, exit, setWait, state }) => {
  setWait(async () => exit());
  assert.equal(await coordinator.holdFailure(), 'exited');
  assert.equal((await state()).state, 'closing');
}));

test('保留检查受租约约束，未发结束信号也会到期退出', () => scenario(async ({ coordinator, time }) => {
  assert.equal(await coordinator.holdFailure(), 'lease-ended');
  assert.equal(time(), 1000);
}));

test('阶段信号按本轮随机标识校验，finish可提前停止等待', () => scenario(async ({ coordinator, signal, setWait, time }) => {
  await signal('baseline', 'old');
  setWait(async () => { if (time() === 500) await signal('baseline'); });
  await coordinator.waitFor('baseline');
  assert.equal(time(), 500);
  await signal('finish');
  await assert.rejects(coordinator.waitFor('moved'), /acceptance_finished/);
}));

test('正常完成也等待明确finish，不把结束信号当成失败', () => scenario(async ({ coordinator, signal, setWait, time }) => {
  setWait(async () => signal('finish'));
  await coordinator.waitFor('finish');
  assert.equal(time(), 250);
}));

test('关闭状态不可逆，退出失败也不得重新开放检查', () => scenario(async ({ coordinator, state, time }) => {
  await coordinator.close();
  assert.equal(await coordinator.holdFailure(), 'closing');
  assert.equal(time(), 0);
  assert.equal((await state()).state, 'closing');
  await assert.rejects(coordinator.waitFor('baseline'), /acceptance_closing/);
}));

test('前台超时等用户点击，同实例retry信号后重新检查才放行', () => scenario(async ({ coordinator, state, signal, setWait, time }) => {
  let reads = 0;
  setWait(async () => {
    if (time() === 500) {
      assert.equal((await state()).state, 'waiting-user');
      assert.equal(reads, 1);
      await signal('baseline-retry');
    }
  });
  await coordinator.waitForForeground('baseline', async since => {
    reads += 1;
    assert.equal(since, time() >= 500 ? 500 : 0);
    return { helperBlurred: time() >= 500, wechatInFront: time() >= 500, freshObservation: true };
  }, 250);
  assert.equal(reads, 2);
  assert.equal((await state()).state, 'measuring');
}));
