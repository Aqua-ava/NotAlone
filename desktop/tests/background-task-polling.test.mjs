import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const built = await build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { SourceDeletionController } from './src/main/sources/controller';
  export { ImportController } from './src/main/imports/controller';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const ports = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const ids = [1, 2, 3, 4].map(n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const [contactId, otherId, sourceId, taskId] = ids;
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const barrier = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function fixture(t, kind) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const control = { gate: null, failure: false, writeGate: null, status: kind === 'import' ? 'queued' : 'running' };
  const listeners = new Set(), calls = [];
  let generation = 1;
  const backend = { getConnectionGeneration: () => generation,
    onStateChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    async requestJson(request) {
      calls.push(request);
      const captured = generation;
      if (request.path === '/api/imports/preview') return { generation: captured, data: { valid: true, file_name: 'synthetic.jsonl', content_sha256: 'a'.repeat(64), record_count: 1, kind_counts: { text: 1 }, owner_channel_identity: { external_id: 'synthetic-owner', observed_name: '合成本人' }, contact_channel_identity: { external_id: 'synthetic-contact', observed_name: '合成联系人' } } };
      if (request.path === '/api/imports/commit') return { generation: captured, data: { contact_id: contactId, task_id: taskId, imported_count: 1, skipped_duplicates: 0 } };
      if (request.method === 'DELETE' || request.path === '/api/tasks/run') {
        if (control.writeGate) await control.writeGate.promise;
        return { generation: captured, data: { task_id: taskId, status: request.method === 'DELETE' ? 'queued' : 'started' } };
      }
      const reading = request.path.endsWith('/sources') || request.path.startsWith('/api/tasks/status');
      if (reading && control.gate) await control.gate.promise;
      if (reading && control.failure) throw new Error('合成读取故障');
      if (request.path.endsWith('/sources')) return { generation: captured, data: { sources: [{ source_id: sourceId, file_name: 'synthetic.jsonl', record_count: 1, status: kind === 'import' ? 'active' : 'deleting', task_id: kind === 'import' ? null : taskId }] } };
      if (request.path.startsWith('/api/tasks/status')) {
        const names = kind === 'import' ? ['parse', 'normalize', 'extract_memory', 'index', 'verify'] : ['mark_deleted', 'delete_derived', 'delete_index', 'clear_cache', 'verify_not_retrievable'];
        return { generation: captured, data: { task_id: taskId, task_type: kind, status: control.status, step: names[0], message_count: 1, retry_count: 0, error_code: null,
          steps: names.map(name => ({ name, status: 'pending', attempt_count: 0, processed_count: 0, total_count: 1, error_code: null })) } };
      }
      return { generation: captured, data: {} };
    } };
  const contacts = new ports.ContactSession(async () => ({ generation, contacts: [contactId, otherId].map(id => ({ contactId: id, displayName: '合成联系人', messageCount: 1, sourceCount: 1 })) }));
  contacts.setConnection(1); await contacts.refreshContacts();
  const select = id => contacts.selectContact({ contactId: id, scopeRevision: contacts.getState().scopeRevision });
  select(contactId);
  const controller = kind === 'import' ? new ports.ImportController(backend, contacts) : new ports.SourceDeletionController(backend, contacts, async () => {});
  const scope = () => ({ contactId: contacts.getState().selectedContactId, scopeRevision: contacts.getState().scopeRevision });
  const revision = () => controller.getState().selectionRevision;
  async function start() {
    if (kind === 'delete') return controller.refresh(scope());
    await controller.chooseFile(async () => ({ canceled: false, filePaths: ['/synthetic/import.jsonl'] }));
    controller.setTarget({ kind: 'existing', contactId });
    await controller.preview(revision()); await controller.confirmPreview(revision()); await controller.submit(revision());
  }
  t.after(() => { generation = undefined; for (const listener of listeners) listener(); contacts.setConnection(undefined); });
  return { controller, control, calls, select, scope, revision, start };
}

for (const kind of ['delete', 'import']) {
  const title = kind === 'delete' ? '来源删除' : '导入任务';
  const snapshot = f => kind === 'delete' ? { phase: f.controller.getState().phase, sources: f.controller.getState().sources, busy: f.controller.getState().busySourceId }
    : { task: f.controller.getState().submission.task, busy: f.controller.getState().submission.taskBusy };
  const interval = kind === 'delete' ? 500 : 1500;
  test(`${title}首次读取仍明确显示加载中，不伪造已有结果`, async t => {
    const f = await fixture(t, kind); f.control.gate = barrier();
    const opening = f.start(); await flush();
    if (kind === 'delete') { assert.equal(f.controller.getState().phase, 'loading'); assert.deepEqual(f.controller.getState().sources, []); }
    else { assert.equal(f.controller.getState().submission.taskBusy, 'refresh'); assert.equal(f.controller.getState().submission.task, null); }
    f.control.gate.release(); await opening;
  });
  test(`${title}自动轮询在途保留已有内容和按钮状态，显式刷新仍显示忙碌`, async t => {
    const f = await fixture(t, kind); await f.start();
    const before = snapshot(f); assert.equal(before.busy, null);
    const readsBefore = f.calls.length;
    f.control.gate = barrier(); t.mock.timers.tick(interval); await flush();
    assert.equal(f.calls.length, readsBefore + 1);
    assert.equal(f.calls.at(-1).method, 'GET');
    t.mock.timers.tick(interval * 5); await flush();
    assert.equal(f.calls.length, readsBefore + 1, '慢请求期间不重复调度后台查询');
    assert.deepEqual(snapshot(f), before);
    f.control.gate.release(); await flush(); f.control.gate = barrier();
    const explicit = kind === 'delete' ? f.controller.refresh(f.scope()) : f.controller.refreshTask(f.revision());
    assert.equal(kind === 'delete' ? f.controller.getState().phase : f.controller.getState().submission.taskBusy, kind === 'delete' ? 'loading' : 'refresh');
    f.control.gate.release(); await explicit;
  });
  test(`${title}后台读取失败撤下旧结果，迟到结果不能覆盖新联系人`, async t => {
    const f = await fixture(t, kind); await f.start();
    f.control.failure = true; t.mock.timers.tick(interval); await flush();
    if (kind === 'delete') { assert.equal(f.controller.getState().phase, 'failed'); assert.deepEqual(f.controller.getState().sources, []); }
    else { assert.equal(f.controller.getState().submission.task, null); assert.ok(f.controller.getState().submission.taskError); }
    f.control.failure = false;
    if (kind === 'delete') await f.controller.refresh(f.scope()); else await f.controller.refreshTask(f.revision());
    f.control.gate = barrier(); t.mock.timers.tick(interval); await flush(); f.select(otherId);
    const switched = f.controller.getState(); f.control.gate.release(); await flush();
    assert.deepEqual(f.controller.getState(), switched);
  });
  test(`${title}用户写入优先于后台读取，忙碌状态不能被旧快照清除`, async t => {
    const f = await fixture(t, kind); await f.start();
    f.control.gate = barrier(); t.mock.timers.tick(interval); await flush();
    f.control.writeGate = barrier();
    const writing = kind === 'delete' ? f.controller.delete({ ...f.scope(), sourceId }) : f.controller.runTask(f.revision());
    await flush();
    assert.equal(snapshot(f).busy, kind === 'delete' ? sourceId : 'run');
    f.control.gate.release(); await flush();
    assert.equal(snapshot(f).busy, kind === 'delete' ? sourceId : 'run');
    f.control.writeGate.release(); await writing;
  });
}
