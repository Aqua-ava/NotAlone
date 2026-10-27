import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const built = await build({
  stdin: { contents: `export { BackgroundTaskController } from './src/main/background-tasks/controller';`,
    resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { BackgroundTaskController } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

const contactId = '10000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
const task = (id, task_type, status, actions) => ({
  task_id: id, task_type, contact_id: contactId, scope_kind: 'contact', status,
  phase: task_type === 'layered_memory' ? 'organize_memory' : 'extract_memory',
  message_count: 4, retry_count: 1, error_code: status === 'failed' ? 'synthetic_failed' : null,
  processed_count: 2, total_count: 4, work_revision: task_type === 'layered_memory' ? 7 : null,
  settings_generation: task_type === 'layered_memory' ? 3 : null,
  updated_at: '2026-10-25T00:00:00Z',
  steps: [{ name: 'extract_memory', status: 'failed', attempt_count: 3,
    processed_count: 2, total_count: 4, error_code: 'synthetic_failed', lease_expires_at: null }],
  actions,
});

function fixture(t) {
  const calls = [];
  let generation = 1;
  let selected = contactId;
  let scopeRevision = 4;
  const tasks = [
    task('20000000-0000-4000-8000-000000000001', 'import', 'running', []),
    task('20000000-0000-4000-8000-000000000002', 'import', 'failed', []),
    task('20000000-0000-4000-8000-000000000003', 'skill_learning', 'failed',
      [{ kind: 'recover', target: 'skill_learning' }]),
    task('20000000-0000-4000-8000-000000000004', 'layered_memory', 'failed', []),
    task('20000000-0000-4000-8000-000000000005', 'delete', 'failed', []),
  ];
  const ownerTasks = [
    { ...task('20000000-0000-4000-8000-000000000006', 'layered_memory', 'running', []),
      contact_id: null, scope_kind: 'owner' },
    { ...task('20000000-0000-4000-8000-000000000007', 'layered_memory', 'failed', []),
    contact_id: null, scope_kind: 'owner' },
  ];
  const backend = {
    getConnectionGeneration: () => generation,
    async requestJson(request) {
      calls.push(request);
      const current = generation;
      if (request.path.startsWith('/api/tasks?')) {
        const requested = request.path === '/api/tasks?scope=owner&limit=100' ? ownerTasks : tasks;
        return { generation: current, data: { tasks: requested, has_more: false } };
      }
      if (request.path === '/api/tasks/stop') {
        return { generation: current, data: { task_id: request.body.task_id, status: 'stopped' } };
      }
      if (request.path === '/api/tasks/recover') {
        return { generation: current, data: { task_id: request.body.task_id, status: 'queued' } };
      }
      if (request.path.includes('/skill-learning')) {
        return { generation: current, data: { enabled: true, drafts: [], task: null,
          recent_outcomes: [], scope_revision: 2 } };
      }
      if (request.path.includes('/layered-memory/continue')) {
        return { generation: current, data: { layered_memory: {} } };
      }
      throw new Error('unexpected request');
    },
  };
  const contacts = {
    getState: () => ({ selectedContactId: selected, scopeRevision }),
  };
  const controller = new BackgroundTaskController(backend, contacts);
  return {
    controller, calls,
    select(contact, revision) { selected = contact; scopeRevision = revision; },
    setGeneration(value) { generation = value; },
  };
}

test('后台任务控制器只经统一入口读取并严格验证全部动作', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.controller.read({ scope: 'contact', contactId, scopeRevision: 4 });
  assert.equal(f.calls[0].path, `/api/tasks?contact_id=${contactId}&limit=100`);
  assert.equal(f.calls[0].method, 'GET');
  const state = f.controller.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.tasks.length, 5);
  assert.deepEqual(state.tasks.map(item => item.status),
    ['running', 'failed', 'failed', 'failed', 'failed']);
  assert.deepEqual(state.tasks[2].actions, [{ kind: 'recover', target: 'skill_learning' }]);
  assert.deepEqual(state.tasks[3].actions, []);
  f.controller.cancelRead();
});

test('只执行后端公开动作，记忆任务不能经通用任务入口停止或恢复', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const read = () => f.controller.read({ scope: 'contact', contactId, scopeRevision: 4 });
  await read();
  await assert.rejects(f.controller.stop({ scope: 'contact', contactId, scopeRevision: 4,
    taskId: '20000000-0000-4000-8000-000000000001' }), /不允许/);
  await assert.rejects(f.controller.recover({ scope: 'contact', contactId, scopeRevision: 4,
    taskId: '20000000-0000-4000-8000-000000000002' }), /不允许/);
  assert.equal(f.calls.some(call => call.path === '/api/tasks/stop'), false);
  assert.equal(f.calls.some(call => call.path === '/api/tasks/recover'), false);
  await f.controller.recover({ scope: 'contact', contactId, scopeRevision: 4,
    taskId: '20000000-0000-4000-8000-000000000003' });
  assert.equal(f.calls.find(call => call.path === `/api/contacts/${contactId}/skill-learning`).body.resume, true);
  await assert.rejects(f.controller.recover({ scope: 'contact', contactId, scopeRevision: 4,
    taskId: '20000000-0000-4000-8000-000000000004' }), /不允许/);
  assert.equal(f.calls.some(call => call.path === `/api/contacts/${contactId}/layered-memory/continue`), false);
  await assert.rejects(f.controller.recover({ scope: 'contact', contactId, scopeRevision: 4,
    taskId: '20000000-0000-4000-8000-000000000005' }), /不允许/);
  f.controller.cancelRead();
});

test('切换联系人、旧连接或迟到读取不能提交任务动作', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.controller.read({ scope: 'contact', contactId, scopeRevision: 4 });
  f.select(otherId, 5);
  await assert.rejects(f.controller.stop({ scope: 'contact', contactId, scopeRevision: 4,
    taskId: '20000000-0000-4000-8000-000000000001' }), /范围已变化/);
  assert.equal(f.calls.some(call => call.path === '/api/tasks/stop'), false);
  f.select(contactId, 4);
  await f.controller.read({ scope: 'contact', contactId, scopeRevision: 4 });
  f.setGeneration(2);
  await assert.rejects(f.controller.recover({ scope: 'contact', contactId, scopeRevision: 4,
    taskId: '20000000-0000-4000-8000-000000000002' }), /范围已变化/);
  f.controller.cancelRead();
});

test('本人任务使用独立owner范围，不混入当前联系人', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const selection = { scope: 'owner', scopeRevision: 4 };
  await f.controller.read(selection);
  assert.equal(f.calls[0].path, '/api/tasks?scope=owner&limit=100');
  assert.deepEqual(f.controller.getState().tasks.map(item => item.taskId), [
    '20000000-0000-4000-8000-000000000006',
    '20000000-0000-4000-8000-000000000007',
  ]);
  assert.equal(f.controller.getState().contactId, null);
  await assert.rejects(
    f.controller.stop({ ...selection, taskId: '20000000-0000-4000-8000-000000000006' }),
    /不允许/,
  );
  await assert.rejects(
    f.controller.recover({ ...selection, taskId: '20000000-0000-4000-8000-000000000007' }),
    /不允许/,
  );
  assert.equal(f.calls.some(call => call.path === '/api/tasks/stop'
    || call.path === '/api/tasks/recover'
    || call.path.includes('/layered-memory/continue')), false);
  f.controller.cancelRead();
});
