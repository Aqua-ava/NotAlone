import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const built = await build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { SourceDeletionController } from './src/main/sources/controller';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const ports = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const ids = [1, 2, 3, 4].map(n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const [contactId, otherId, sourceId, taskId] = ids;
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const barrier = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const control = { gate: null, failure: false, writeGate: null };
  const listeners = new Set(), calls = [];
  let generation = 1;
  const backend = { getConnectionGeneration: () => generation,
    onStateChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    async requestJson(request) {
      calls.push(request);
      const captured = generation;
      if (request.method === 'DELETE' || request.path === '/api/tasks/run') {
        if (control.writeGate) await control.writeGate.promise;
        return { generation: captured, data: { task_id: taskId, status: request.method === 'DELETE' ? 'queued' : 'started' } };
      }
      const reading = request.path.endsWith('/sources') || request.path.startsWith('/api/tasks/status');
      if (reading && control.gate) await control.gate.promise;
      if (reading && control.failure) throw new Error('合成读取故障');
      if (request.path.endsWith('/sources')) return { generation: captured, data: { sources: [{ source_id: sourceId, file_name: 'synthetic.jsonl', record_count: 1, status: 'deleting', task_id: taskId }] } };
      if (request.path.startsWith('/api/tasks/status')) {
        const names = ['mark_deleted', 'delete_derived', 'delete_index', 'clear_cache', 'verify_not_retrievable'];
        return { generation: captured, data: { task_id: taskId, task_type: 'delete', status: 'running', step: names[0], message_count: 1, retry_count: 0, error_code: null,
          steps: names.map(name => ({ name, status: 'pending', attempt_count: 0, processed_count: 0, total_count: 1, error_code: null })) } };
      }
      return { generation: captured, data: {} };
    } };
  const contacts = new ports.ContactSession(async () => ({ generation, contacts: [contactId, otherId].map(id => ({ contactId: id, displayName: '合成联系人', messageCount: 1, sourceCount: 1 })) }));
  contacts.setConnection(1); await contacts.refreshContacts();
  const select = id => contacts.selectContact({ contactId: id, scopeRevision: contacts.getState().scopeRevision });
  select(contactId);
  const controller = new ports.SourceDeletionController(backend, contacts, async () => {});
  const scope = () => ({ contactId: contacts.getState().selectedContactId, scopeRevision: contacts.getState().scopeRevision });
  const revision = () => controller.getState().selectionRevision;
  async function start() { return controller.refresh(scope()); }
  t.after(() => { generation = undefined; for (const listener of listeners) listener(); contacts.setConnection(undefined); });
  return { controller, control, calls, select, scope, revision, start };
}

const snapshot = f => ({ phase: f.controller.getState().phase, sources: f.controller.getState().sources, busy: f.controller.getState().busySourceId });
const interval = 500;
test('来源删除首次读取仍明确显示加载中，不伪造已有结果', async t => {
  const f = await fixture(t); f.control.gate = barrier();
  const opening = f.start(); await flush();
  assert.equal(f.controller.getState().phase, 'loading'); assert.deepEqual(f.controller.getState().sources, []);
  f.control.gate.release(); await opening;
});
test('来源删除自动轮询在途保留已有内容和按钮状态，显式刷新仍显示忙碌', async t => {
  const f = await fixture(t); await f.start();
  const before = snapshot(f); assert.equal(before.busy, null);
  const readsBefore = f.calls.length;
  f.control.gate = barrier(); t.mock.timers.tick(interval); await flush();
  assert.equal(f.calls.length, readsBefore + 1);
  assert.equal(f.calls.at(-1).method, 'GET');
  t.mock.timers.tick(interval * 5); await flush();
  assert.equal(f.calls.length, readsBefore + 1, '慢请求期间不重复调度后台查询');
  assert.deepEqual(snapshot(f), before);
  f.control.gate.release(); await flush(); f.control.gate = barrier();
  const explicit = f.controller.refresh(f.scope());
  assert.equal(f.controller.getState().phase, 'loading');
  f.control.gate.release(); await explicit;
});
test('来源删除后台读取失败撤下旧结果，迟到结果不能覆盖新联系人', async t => {
  const f = await fixture(t); await f.start();
  f.control.failure = true; t.mock.timers.tick(interval); await flush();
  assert.equal(f.controller.getState().phase, 'failed'); assert.deepEqual(f.controller.getState().sources, []);
  f.control.failure = false; await f.controller.refresh(f.scope());
  f.control.gate = barrier(); t.mock.timers.tick(interval); await flush(); f.select(otherId);
  const switched = f.controller.getState(); f.control.gate.release(); await flush();
  assert.deepEqual(f.controller.getState(), switched);
});
test('来源删除用户写入优先于后台读取，忙碌状态不能被旧快照清除', async t => {
  const f = await fixture(t); await f.start();
  f.control.gate = barrier(); t.mock.timers.tick(interval); await flush();
  f.control.writeGate = barrier();
  const writing = f.controller.delete({ ...f.scope(), sourceId });
  await flush();
  assert.equal(snapshot(f).busy, sourceId);
  f.control.gate.release(); await flush();
  assert.equal(snapshot(f).busy, sourceId);
  f.control.writeGate.release(); await writing;
});
