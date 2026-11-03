import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelPermitArbiter} from '../src/platform/models/model-permits.ts';

const turn = () => new Promise(resolve => setImmediate(resolve));
const worker = {pid: 12345, parentPid: 1, startedAt: 'Tue Nov 3 00:00:00 2026', executable: '/synthetic/node'};
function requests(t, arbiter) {
  const held = [];
  t.after(() => { arbiter.stop(); for (const permit of held) { try { permit.settle(); } catch {} } });
  return (kind, signal, attemptId) => {
    const state = {permit: undefined, error: undefined};
    state.done = arbiter.acquire(kind, signal, worker, attemptId).then(
      permit => { held.push(permit); state.permit = permit; return permit; },
      error => { state.error = error; });
    return state;
  };
}

for (const limit of [1, 3, 4]) test(`后台${limit}路占满时前台独立获许可，双方不借用空槽`, async t => {
  const arbiter = new ModelPermitArbiter(limit), request = requests(t, arbiter);
  const background = Array.from({length: limit}, () => request('background'));
  await Promise.all(background.map(item => item.done));
  const foreground = request('foreground'), nextBackground = request('background'), nextForeground = request('foreground');
  await turn();
  assert.ok(foreground.permit, '后台在途不能阻止前台');
  assert.equal(nextBackground.permit, undefined);
  assert.equal(nextForeground.permit, undefined);
  foreground.permit.settle(); await turn();
  assert.ok(nextForeground.permit);
  assert.equal(nextBackground.permit, undefined, '空闲前台槽不能借给后台');
  nextForeground.permit.settle(); background[0].permit.settle(); await turn();
  assert.ok(nextBackground.permit);
});

test('前台在途时后台仍获三路许可，各类等待者按同类FIFO推进', async t => {
  const arbiter = new ModelPermitArbiter(3), request = requests(t, arbiter);
  const firstForeground = request('foreground'); await firstForeground.done;
  const foreground = [request('foreground'), request('foreground')];
  const background = Array.from({length: 5}, () => request('background'));
  await turn();
  assert.equal(background.filter(item => item.permit).length, 3);
  firstForeground.permit.settle(); await turn();
  assert.ok(foreground[0].permit); assert.equal(foreground[1].permit, undefined);
  background[1].permit.settle(); await turn();
  assert.ok(background[3].permit); assert.equal(background[4].permit, undefined);
  foreground[0].permit.settle(); background[0].permit.settle(); await turn();
  assert.ok(foreground[1].permit); assert.ok(background[4].permit);
});

for (const kind of ['foreground', 'background']) test(`${kind}孤儿保留未知调用并仅冻结自身类别`, async t => {
  const arbiter = new ModelPermitArbiter(3), request = requests(t, arbiter);
  const lost = request(kind); await lost.done; lost.permit.orphan();
  const same = request(kind), otherKind = kind === 'foreground' ? 'background' : 'foreground';
  const other = request(otherKind); await turn();
  assert.equal(same.permit, undefined, '孤儿所在类别连空闲槽也冻结');
  assert.ok(other.permit, '另一类别必须继续派发');
  assert.deepEqual(arbiter.orphanedPermitIds(), [lost.permit.id]);
  other.permit.settle(); await turn();
  assert.equal(same.permit, undefined, '另一类别结算不能清除未知调用');
  lost.permit.settle(); await turn();
  assert.ok(same.permit);
  assert.deepEqual(arbiter.orphanedPermitIds(), []);
});

for (const kind of ['foreground', 'background']) test(`${kind}取消等待不发许可，取消在途不提前释放`, async t => {
  const arbiter = new ModelPermitArbiter(1), request = requests(t, arbiter), runningSignal = new AbortController();
  const running = request(kind, runningSignal.signal); await running.done;
  const cancel = new AbortController(), cancelled = request(kind, cancel.signal), next = request(kind);
  cancel.abort(); runningSignal.abort(); await turn();
  assert.match(cancelled.error?.message ?? '', /model_work_stopped/);
  assert.equal(cancelled.permit, undefined); assert.equal(next.permit, undefined);
  const other = request(kind === 'foreground' ? 'background' : 'foreground'); await turn();
  assert.ok(other.permit);
  assert.equal(next.permit, undefined);
  running.permit.settle(); await turn(); assert.ok(next.permit);
});

test('全局暂停等待两个类别真实结算，再恢复各类FIFO且不借槽', async t => {
  const arbiter = new ModelPermitArbiter(2), request = requests(t, arbiter);
  const foreground = request('foreground'), background = request('background'); await turn();
  assert.ok(foreground.permit); assert.ok(background.permit);
  let drained = false; const drain = arbiter.pauseAndDrain().then(() => { drained = true; });
  const nextForeground = request('foreground'), nextBackground = request('background');
  foreground.permit.settle(); await turn(); assert.equal(drained, false);
  background.permit.settle(); await drain;
  assert.equal(nextForeground.permit, undefined); assert.equal(nextBackground.permit, undefined);
  arbiter.resume(); await turn(); assert.ok(nextForeground.permit); assert.ok(nextBackground.permit);
});

test('stop全局拒绝两个类别等待者，保留在途直到全部结算', async t => {
  const arbiter = new ModelPermitArbiter(1), request = requests(t, arbiter);
  const foreground = request('foreground'), background = request('background'); await turn();
  assert.ok(foreground.permit); assert.ok(background.permit);
  const nextForeground = request('foreground'), nextBackground = request('background');
  arbiter.stop(); await turn();
  for (const item of [nextForeground, nextBackground]) assert.match(item.error?.message ?? '', /model_work_stopped/);
  await assert.rejects(arbiter.acquire('foreground'), /model_work_stopped/);
  await assert.rejects(arbiter.acquire('background'), /model_work_stopped/);
  let drained = false; const drain = arbiter.pauseAndDrain().then(() => { drained = true; });
  foreground.permit.settle(); await turn(); assert.equal(drained, false);
  background.permit.settle(); await drain; assert.throws(() => arbiter.resume(), /model_work_stopped/);
});

test('许可journal记录同时在途的两个类别及原执行者和attempt身份', async t => {
  const arbiter = new ModelPermitArbiter(3), entries = [];
  arbiter.attachJournal({host: worker, record: active => entries.push(structuredClone(active))});
  const request = requests(t, arbiter);
  const foreground = request('foreground', undefined, 'foreground-attempt');
  const background = request('background', undefined, 'background-attempt'); await turn();
  assert.ok(foreground.permit); assert.ok(background.permit);
  assert.deepEqual(entries.at(-1), [
    {id: foreground.permit.id, kind: 'foreground', worker, attempt_id: 'foreground-attempt'},
    {id: background.permit.id, kind: 'background', worker, attempt_id: 'background-attempt'},
  ]);
});

for (const failingKind of ['foreground', 'background']) test(`${failingKind}派发journal失败停止全部类别，不继续发放并保留未知容量`, async t => {
  const arbiter = new ModelPermitArbiter(3), failure = new Error('synthetic_journal_failed');
  arbiter.attachJournal({host: worker, record: active => { if (active.at(-1)?.kind === failingKind) throw failure; }});
  const request = requests(t, arbiter); await arbiter.pauseAndDrain();
  const foreground = request('foreground'), background = request('background'), nextBackground = request('background');
  arbiter.resume(); await turn();
  if (failingKind === 'foreground') {
    assert.equal(foreground.error, failure);
    assert.match(background.error?.message ?? '', /model_work_stopped/);
  } else {
    assert.ok(foreground.permit);
    assert.equal(background.error, failure);
  }
  assert.match(nextBackground.error?.message ?? '', /model_work_stopped/);
  assert.equal(background.permit, undefined);
  assert.equal(arbiter.snapshot().foregroundActive, true);
  assert.equal(arbiter.snapshot().backgroundActive, failingKind === 'background' ? 1 : 0);
  assert.equal(arbiter.snapshot().stopped, true);
});

test('结算journal失败恢复原许可且全局停收，不以另一类别空槽绕过', async t => {
  const arbiter = new ModelPermitArbiter(1), failure = new Error('synthetic_journal_failed'); let fail = false;
  arbiter.attachJournal({host: worker, record: () => { if (fail) throw failure; }});
  const request = requests(t, arbiter), foreground = request('foreground'), background = request('background'); await turn();
  assert.ok(foreground.permit); assert.ok(background.permit);
  const nextForeground = request('foreground'), nextBackground = request('background');
  fail = true; assert.throws(() => foreground.permit.settle(), error => error === failure); await turn();
  assert.equal(arbiter.snapshot().foregroundActive, true); assert.equal(arbiter.snapshot().backgroundActive, 1);
  for (const item of [nextForeground, nextBackground]) assert.match(item.error?.message ?? '', /model_work_stopped/);
  fail = false;
});
