import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundled = await build({ stdin: { contents: `
  export { BackendHost } from './src/main/backend/host';
  export { installContactSessionBridge } from './src/main/contacts/bridge';
  export { SyncControlController } from './src/main/sync/controller';
  export { SyncPriorityController } from './src/main/sync/priority';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const ports = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const a = '10000000-0000-4000-8000-000000000001';
const b = '10000000-0000-4000-8000-000000000002';

function syncReport(enabled) {
  return { sync_mode: 'cli_background', sync_enabled: enabled, cli_available: true, probe_available: false,
    wechat_in_front: false, cli_sync_phase: enabled ? 'active' : 'disabled', foreground_phase: 'waiting_foreground',
    cli_bound_count: 2, cli_failure_code: null, foreground_failure_code: null, cli_backfill_phase: 'not_required',
    cli_backfill_failure_code: null, ...Object.fromEntries(['total_contacts', 'completed_contacts', 'succeeded_contacts',
      'skipped_contacts', 'failed_contacts', 'incomplete_contacts', 'pending_contacts', 'total_message_count',
      'total_non_text_count'].map((key) => [`cli_backfill_${key}`, 0])) };
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-sync-priority-'));
  const changes = new EventEmitter(), requests = [];
  const control = { beforePriority: undefined, beforeStatus: undefined, runtimeAvailable: true, priorityFailures: 0 };
  let enabled = true;
  const server = createServer(async (request, response) => {
    const send = (value) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.headers.authorization !== 'Bearer synthetic_priority_token') { response.writeHead(401); response.end(); return; }
    if (request.url === '/api/runtime/status') {
      if (!control.runtimeAvailable) { response.writeHead(503); response.end(); return; }
      return send({ state: 'running' });
    }
    if (request.url === '/api/runtime/shutdown') return send({ state: 'stopped' });
    if (request.url === '/api/setup/status') return send({ runtime_owner_configured: true });
    if (request.url === '/api/contacts') return send({ contacts: [a, b].map((contact_id, index) => ({ contact_id,
      display_name: `合成联系人${index + 1}`, data_status: { message_count: 0, source_count: 0 } })) });
    if (request.url === '/api/sync/status') { await control.beforeStatus?.(); return send(syncReport(enabled)); }
    if (request.url === '/api/sync/enable' || request.url === '/api/sync/disable') {
      enabled = request.url.endsWith('/enable'); return send(syncReport(enabled));
    }
    if (request.url === '/api/sync/priority' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      const value = JSON.parse(body);
      requests.push(value); changes.emit('priority');
      await control.beforePriority?.(value.contact_id);
      if (control.priorityFailures > 0) {
        control.priorityFailures -= 1;
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end('{"error":"sync_status_unavailable"}'); return;
      }
      return send(syncReport(enabled));
    }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const info = path.join(directory, 'backend.info');
  await writeFile(info, `address=127.0.0.1:${server.address().port}\ntoken=synthetic_priority_token\npid=${process.pid}\n`, { mode: 0o600 });
  await writeFile(path.join(directory, 'backend-launch.json'), JSON.stringify({ backendInfoPath: info }));
  const backend = new ports.BackendHost(directory);
  const contacts = ports.installContactSessionBridge({ handle() {}, publish() {} }, backend);
  const sync = new ports.SyncControlController(backend, contacts);
  const priority = new ports.SyncPriorityController(backend, contacts, sync);
  t.after(async () => {
    await priority.dispose(); sync.dispose(); await backend.stop();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await backend.connect(); await contacts.refreshContacts(); await sync.refresh();
  const waitPriority = (contactId, occurrence = 1) => new Promise((resolve, reject) => {
    const check = () => {
      if (requests.filter((request) => request.contact_id === contactId).length < occurrence) return;
      clearTimeout(deadline); changes.removeListener('priority', check); resolve();
    };
    const deadline = setTimeout(() => { changes.removeListener('priority', check); reject(new Error('当前联系人未登记优先读取。')); }, 2000);
    changes.on('priority', check); check();
  });
  return { backend, contacts, sync, priority, requests, waitPriority, control,
    select: (contactId) => contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision }) };
}

test('已确认选择自动登记优先读取，重复目录和草稿变化不重复登记，切换跟随新联系人', async (t) => {
  const f = await fixture(t);
  await f.waitPriority(null);
  f.select(a); await f.waitPriority(a);
  f.contacts.setDraft({ contactId: a, scopeRevision: f.contacts.getState().scopeRevision, text: '本轮合成草稿。' });
  await f.contacts.refreshContacts(); await f.sync.refresh();
  f.select(b); await f.waitPriority(b);
  assert.deepEqual(f.requests, [{ contact_id: null }, { contact_id: a }, { contact_id: b }]);
});

test('慢登记期间只串行跟随最后选择，普通状态报告在途不会清除已选优先联系人', async (t) => {
  const f = await fixture(t);
  await f.waitPriority(null);
  let release, arrived;
  const held = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { arrived = resolve; });
  let releaseStatus;
  f.control.beforePriority = async (contactId) => { if (contactId === a) { arrived(); await held; } };
  try {
    f.select(a); await entered;
    f.select(b); f.select(a); f.select(b);
    await f.contacts.refreshContacts();
    assert.deepEqual(f.requests, [{ contact_id: null }, { contact_id: a }], '旧写入未结算前不能并发提交新目标。');
    release(); await f.waitPriority(b);
    let statusArrived;
    const heldStatus = new Promise((resolve) => { releaseStatus = resolve; });
    const statusEntered = new Promise((resolve) => { statusArrived = resolve; });
    f.control.beforeStatus = async () => { statusArrived(); await heldStatus; };
    const refreshing = f.sync.refresh(); await statusEntered;
    assert.equal(f.sync.getState().report, null);
    await f.contacts.refreshContacts();
    assert.deepEqual(f.requests, [{ contact_id: null }, { contact_id: a }, { contact_id: b }], '普通报告在途不能清除有效优先提示。');
    releaseStatus(); await refreshing;
    assert.deepEqual(f.requests, [{ contact_id: null }, { contact_id: a }, { contact_id: b }]);
  } finally { release(); releaseStatus?.(); }
});

test('显式关闭清除优先提示，关闭期间选择不读取，重新开启才登记当前选择', async (t) => {
  const f = await fixture(t);
  await f.waitPriority(null);
  f.select(a); await f.waitPriority(a);
  await f.sync.disable({ scopeRevision: f.contacts.getState().scopeRevision });
  await f.waitPriority(null, 2);
  f.select(b); await f.contacts.refreshContacts(); await f.sync.refresh();
  assert.deepEqual(f.requests, [{ contact_id: null }, { contact_id: a }, { contact_id: null }]);
  await f.sync.enable({ scopeRevision: f.contacts.getState().scopeRevision }); await f.waitPriority(b);
  assert.equal(f.requests.at(-1).contact_id, b);
});

test('释放协调器先清除提示并移除订阅，后续选择和状态变化不再登记', async (t) => {
  const f = await fixture(t);
  await f.waitPriority(null);
  f.select(a); await f.waitPriority(a);
  await f.priority.dispose();
  f.select(b); await f.contacts.refreshContacts(); await f.sync.refresh();
  assert.deepEqual(f.requests, [{ contact_id: null }, { contact_id: a }, { contact_id: null }]);
});

test('登记失败不冒充成功，后续同范围状态刷新重试当前目标，关闭后不重试旧目标', async (t) => {
  const f = await fixture(t);
  await f.waitPriority(null);
  f.control.priorityFailures = 1;
  f.select(a); await f.waitPriority(a);
  // HTTP 往返只观察合成服务，不能以另一条业务状态发布代替待验证的刷新事件。
  await f.backend.requestJson({ method: 'GET', path: '/api/sync/status' });
  await f.sync.refresh(); await f.waitPriority(a, 2);
  f.control.priorityFailures = 1;
  f.select(b); await f.waitPriority(b);
  await f.backend.requestJson({ method: 'GET', path: '/api/sync/status' });
  await f.sync.disable({ scopeRevision: f.contacts.getState().scopeRevision });
  await f.waitPriority(null, 2); await f.sync.refresh();
  assert.deepEqual(f.requests, [{ contact_id: null }, { contact_id: a }, { contact_id: a },
    { contact_id: b }, { contact_id: null }]);
});

test('失败期间切换联系人，后续状态刷新只重试最新目标', async (t) => {
  const f = await fixture(t);
  await f.waitPriority(null);
  let release, arrived;
  const held = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { arrived = resolve; });
  f.control.priorityFailures = 1;
  f.control.beforePriority = async (contactId) => { if (contactId === a) { arrived(); await held; } };
  try {
    f.select(a); await entered; f.select(b); release();
    await f.backend.requestJson({ method: 'GET', path: '/api/sync/status' });
    await f.sync.refresh(); await f.waitPriority(b);
    assert.deepEqual(f.requests, [{ contact_id: null }, { contact_id: a }, { contact_id: b }]);
  } finally { release(); }
});

test('真实连接断开后新代际先清旧提示，不复用上次联系人，重新选择后恢复', async (t) => {
  const f = await fixture(t);
  await f.waitPriority(null);
  f.control.priorityFailures = 1;
  f.select(a); await f.waitPriority(a);
  const disconnected = new Promise((resolve, reject) => {
    const unsubscribe = f.backend.onStateChanged((state) => {
      if (state.phase !== 'disconnected') return;
      clearTimeout(deadline); unsubscribe(); resolve();
    });
    const deadline = setTimeout(() => { unsubscribe(); reject(new Error('合成后台连接未按公开状态断开。')); }, 2500);
  });
  f.control.runtimeAvailable = false;
  await disconnected;
  assert.equal(f.contacts.getState().selectedContactId, null);
  await f.sync.refresh();
  assert.equal(f.requests.filter((request) => request.contact_id === a).length, 1, '断连后不能重试旧目标。');
  f.control.runtimeAvailable = true;
  await f.backend.connect(); await f.contacts.refreshContacts(); await f.sync.refresh();
  await f.waitPriority(null, 2);
  assert.equal(f.contacts.getState().selectedContactId, null);
  f.select(b); await f.waitPriority(b);
  assert.deepEqual(f.requests, [{ contact_id: null }, { contact_id: a }, { contact_id: null }, { contact_id: b }]);
});
