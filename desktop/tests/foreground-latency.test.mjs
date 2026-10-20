import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(tmpdir(), 'notalone-foreground-latency-'));
const built = await build({ entryPoints: ['src/main/foreground/controller.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false });
await writeFile(path.join(directory, 'controller.mjs'), built.outputFiles[0].text);
const { ForegroundController } = await import(path.join(directory, 'controller.mjs'));
after(() => rm(directory, { recursive: true, force: true }));
const ids = [1, 2, 3].map(n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const flush = async () => { for (let i = 0; i < 12; ++i) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const confirmed = contact => ({ observation_id: ids[0], observed_at: new Date().toISOString(), phase: 'confirmed',
  reason: 'confirmed_active_binding', probe_available: true, wechat_in_front: true,
  binding_id: ids[0], contact_id: contact });

function fixture() {
  let state = { scopeRevision: 0, selectedContactId: ids[0], directoryPhase: 'ready', contacts: ids.map(contactId => ({ contactId })) };
  const listeners = new Set(), tasks = new Map(), selections = [], metrics = [];
  let taskId = 0, calls = 0, respond = async () => confirmed(ids[0]);
  const contacts = { getState: () => state, onStateChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    selectContact({ contactId }) { if (state.selectedContactId !== contactId) state = { ...state, selectedContactId: contactId, scopeRevision: state.scopeRevision + 1 };
      selections.push(contactId); for (const listener of listeners) listener(state); return state; } };
  const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
    async requestJson() { ++calls; return { generation: 1, data: await respond() }; } };
  const clock = { schedule(callback, delay) { tasks.set(++taskId, { callback, delay }); return taskId; }, cancel(id) { tasks.delete(id); } };
  const controller = new ForegroundController(backend, contacts, clock);
  controller.observeMeasurements(metric => metrics.push(metric));
  return { controller, tasks, selections, metrics, calls: () => calls, respond: callback => { respond = callback; },
    async next() { const [id, task] = tasks.entries().next().value; tasks.delete(id); await task.callback(); } };
}

test('变化通知立即取消两秒兜底，计时不携带身份且异常诊断不改变观察', async () => {
  const f = fixture();
  try {
    f.controller.startContinuous(); await f.next();
    assert.equal(f.tasks.values().next().value.delay, 2000);
    f.respond(async () => confirmed(ids[1]));
    f.controller.notifyForegroundChange(); await flush();
    assert.equal(f.calls(), 2); assert.equal(f.selections.at(-1), ids[1]);
    assert.equal(f.metrics.filter(x => x.event === 'request_started').length, 2);
    assert.equal(f.metrics.filter(x => x.event === 'result_published' && x.changedContact).length, 1);
    assert.ok(f.metrics.some(x => x.event === 'poll_scheduled' && x.durationMs === 2000));
    assert.ok(!JSON.stringify(f.metrics).includes(ids[0]));
    f.controller.observeMeasurements(() => { throw new Error('synthetic'); });
    f.controller.notifyForegroundChange(); await flush(); assert.equal(f.calls(), 3);
  } finally { f.controller.dispose(); }
});

test('在途变化合并为立即复查，旧身份不发布且最多一轮在途', async () => {
  const f = fixture(), held = deferred();
  try {
    f.controller.startContinuous(); await f.next();
    f.respond(() => held.promise);
    f.controller.notifyForegroundChange(); await flush();
    for (let i = 0; i < 20; ++i) f.controller.notifyForegroundChange();
    assert.equal(f.calls(), 2); assert.equal(f.tasks.size, 0);
    f.respond(async () => confirmed(ids[2])); held.resolve(confirmed(ids[1])); await flush();
    assert.equal(f.calls(), 3); assert.equal(f.selections.includes(ids[1]), false);
    assert.equal(f.selections.at(-1), ids[2]);
    assert.ok(f.metrics.some(x => x.event === 'change_queued'));
  } finally { held.resolve(confirmed(ids[0])); f.controller.dispose(); }
});
