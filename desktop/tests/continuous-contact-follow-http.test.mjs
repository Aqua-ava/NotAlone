import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test, after } from 'node:test';
import { build } from 'esbuild';

const built = await build({ stdin: { contents: `
 export { ForegroundController } from './src/main/foreground/controller';
 export { ContactSession } from './src/main/contacts/session';
 export { readContactDirectory } from './src/main/contacts/directory';
 export { installReplyBridge } from './src/main/reply/bridge';
 export { JsonClient } from './src/main/backend/json-client';
 export { readConnection } from './src/main/backend/connection';
 export { withContinuousForegroundFixture } from './tests/foreground-backend-fixture';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
 banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const directory = await mkdtemp(path.join(tmpdir(), 'notalone-continuous-http-'));
await writeFile(path.join(directory, 'production.mjs'), built.outputFiles[0].text);
const ports = await import(path.join(directory, 'production.mjs'));
after(() => rm(directory, { recursive: true, force: true }));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// 时钟只控制下一轮；观察仍经过认证 HTTP、真实绑定判断和隔离 PG。
test('持续观察自动 A → B → A，保留输入且不生成；同联系人不重建范围', async () => {
 await ports.withContinuousForegroundFixture(async fixture => {
  const [a, b] = fixture.data.contact_ids;
  const names = ['唯一合成会话', '另一合成会话'];
  await fixture.setCli({ sessions: [a,b].map((id,i) => ({ username: `wxid_synthetic_${i ? 'b':'a'}`,
   display_name: names[i], chat_type: 'private', last_timestamp: 1700000000 })), messages: {} });
  assert.equal((await fixture.request('/api/sync/cli-bindings/confirm', { selections: [a,b].map((id,i) =>
   ({ locator: `wxid_synthetic_${i ? 'b':'a'}`, contact_id: id })) })).status, 200);
  assert.equal((await fixture.request('/api/sync/enable', {})).status, 200);
  const client = new ports.JsonClient(await ports.readConnection(fixture.infoPath));
  const requests = []; let delivery; let generation = 1; const listeners = new Set();
  const backend = { getConnectionGeneration: () => generation, onStateChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
   subscribeMessages: () => {}, async requestJson(request) {
    const capturedGeneration = generation; requests.push(request.path); const response = await client.perform(request);
    if (request.path.endsWith('/observe') && delivery) { const held = delivery; delivery = undefined;
     held.received.resolve(); await held.release.promise; }
    return { ...response, generation: capturedGeneration };
   } };
  const contacts = new ports.ContactSession(() => ports.readContactDirectory(backend));
  contacts.setConnection(1); await contacts.refreshContacts();
  const scheduled = new Map(); let token = 0;
  const clock = { schedule(callback, delay) { const id = ++token; scheduled.set(id, { callback, delay }); return id; },
   cancel(id) { scheduled.delete(id); } };
  const foreground = new ports.ForegroundController(backend, contacts, clock);
  const replies = ports.installReplyBridge({ handle() {}, publish() {} }, backend, contacts, () => foreground.getGenerationBlock());
  const observe = async (name, extra = {}) => {
   await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify({ display_name: name, selected_row_name: name, ...extra }));
   assert.equal(scheduled.size, 1, '每轮结束仅一个定时任务');
   const [id, task] = scheduled.entries().next().value; scheduled.delete(id);
   await task.callback();
   const selected = contacts.getState();
   if (selected.selectedContactId) await replies.readSavedSession({ contactId:selected.selectedContactId, scopeRevision:selected.scopeRevision });
   assert.equal(replies.getState().savedSession.phase, "ready");
  };
  try {
   foreground.startContinuous();
   await observe(names[0]);
   assert.equal(contacts.getState().selectedContactId, a);
   contacts.setDraft({ contactId:a, scopeRevision:contacts.getState().scopeRevision, text:'甲未提交草稿' });
   const scope = contacts.getState().scopeRevision;
   await observe(names[0]);
   assert.equal(contacts.getState().scopeRevision, scope);
   assert.equal(contacts.getState().draft, '甲未提交草稿');
   await observe(names[1]);
   assert.equal(contacts.getState().selectedContactId, b);
   contacts.setDraft({ contactId:b, scopeRevision:contacts.getState().scopeRevision, text:'乙未提交草稿' });
   await observe(names[0]);
   assert.equal(contacts.getState().draft, '甲未提交草稿');
   assert.equal(foreground.getGenerationBlock(), null);
   assert.equal(requests.some(value => /\/(generate|prepare|rewrite)$/.test(value)), false);
   foreground.notifyHelperLifecycle('focused');
   assert.equal(scheduled.size, 0);
   assert.equal(foreground.getGenerationBlock(), null);
   assert.equal(foreground.getState().phase, 'paused');
   foreground.notifyHelperLifecycle('blurred');
   const held = { received: deferred(), release: deferred() }; delivery = held;
   const pending = observe(names[1]); await held.received.promise;
   assert.equal(scheduled.size, 0, '等待旧传输结束前没有下一轮');
   foreground.notifyHelperLifecycle('focused');
   held.release.resolve(); await pending;
   assert.equal(contacts.getState().selectedContactId, a);
   assert.equal(scheduled.size, 0);
   foreground.notifyHelperLifecycle('blurred');
   await observe(names[1]);
   assert.equal(contacts.getState().draft, '乙未提交草稿');
   await observe(names[1], { wechat_in_front: false });
   assert.equal(foreground.getState().phase, 'paused');
   assert.equal(foreground.getGenerationBlock(), null, '其他 App 前台正常暂停保留确认');
   await observe(names[1], { selected_row_name_confidence: 0.5 });
   assert.equal(foreground.getState().phase, 'manual-required');
   assert.equal(foreground.getGenerationBlock(), 'foreground-confirmation-required');
   assert.equal(contacts.getState().draft, '乙未提交草稿');
   const tailsBefore = (await fixture.tails()).length;
   assert.equal((await fixture.request('/api/sync/check', {})).status, 200);
   assert.ok((await fixture.tails()).length > tailsBefore, '定位失败不阻止已确认范围 CLI 后台检查');
   const stale = { contactId:b, contactScopeRevision:contacts.getState().scopeRevision,
    foregroundRevision:foreground.getState().foregroundRevision };
   foreground.confirm(stale);
   await observe(names[1], { selected_row_name_confidence: 0.5 });
   assert.equal(foreground.getGenerationBlock(), 'foreground-confirmation-required');
   assert.throws(() => foreground.confirm(stale));
   assert.equal(scheduled.values().next().value.delay, 8000, '重复失败有界退避');
   await observe(names[1]);
   assert.equal(foreground.getGenerationBlock(), 'foreground-confirmation-required', '可靠新观察也不能替代失败后的人工选择');
   foreground.confirm({ contactId:b, contactScopeRevision:contacts.getState().scopeRevision, foregroundRevision:foreground.getState().foregroundRevision });
   await observe(names[1]);
   assert.equal(scheduled.values().next().value.delay, 2000);
   const finishChange = foreground.beginReadingScopeChange();
   assert.equal(scheduled.size, 0);
   assert.equal(foreground.getGenerationBlock(), 'foreground-confirmation-required');
   await foreground.observeBeforeShow();
   assert.equal(scheduled.size, 0);
   finishChange();
   await observe(names[1]);
   const timed = { received: deferred(), release: deferred() }; delivery = timed;
   const delayed = observe(names[0]); await timed.received.promise;
   await delayed; // UI 1.5 秒到期，传输仍未交付。
   assert.equal(foreground.getState().reason, 'observation_timeout');
   assert.equal(scheduled.size, 0);
   const count = requests.filter(p => p.endsWith('/observe')).length;
   await foreground.observeBeforeShow();
   assert.equal(requests.filter(p => p.endsWith('/observe')).length, count);
   timed.release.resolve();
   await new Promise(resolve => setImmediate(resolve));
   assert.equal(contacts.getState().selectedContactId, b, '超时后旧结果不能切换');
   assert.equal(scheduled.size, 1);
   foreground.confirm({ contactId:b, contactScopeRevision:contacts.getState().scopeRevision, foregroundRevision:foreground.getState().foregroundRevision });
   const stopped = { received: deferred(), release: deferred() }; delivery = stopped;
   const beforeStop = observe(names[0]); await stopped.received.promise;
   foreground.stopContinuous(); foreground.startContinuous();
   assert.equal(scheduled.size, 0, '重启仍等待旧传输结算');
   stopped.release.resolve(); await beforeStop;
   assert.equal(contacts.getState().selectedContactId, b);
   assert.equal(foreground.getGenerationBlock(), 'foreground-confirmation-required');
   await observe(names[1]);
   const revoked = { received: deferred(), release: deferred() }; delivery = revoked;
   const beforeRevoke = observe(names[0]); await revoked.received.promise;
   const endRevoke = foreground.beginReadingScopeChange();
   const bindings = await fixture.request('/api/sync/cli-bindings');
   const binding = bindings.data.bindings.find(item => item.contact_id === a);
   assert.equal((await fixture.request('/api/sync/cli-bindings/revoke', { contact_id:a, binding_id:binding.binding_id })).status, 200);
   endRevoke(); revoked.release.resolve(); await beforeRevoke;
   assert.equal(contacts.getState().selectedContactId, b);
   assert.equal(foreground.getGenerationBlock(), 'foreground-confirmation-required');
   await observe(names[0]);
   assert.equal(foreground.getState().phase, 'manual-required');
   assert.equal(contacts.getState().selectedContactId, b, '新观察也不能恢复已撤销绑定');
   const old = { received: deferred(), release: deferred() }; delivery = old;
   const oldFlight = observe(names[0]); await old.received.promise;
   generation += 1; for (const listener of listeners) listener();
   old.release.resolve(); await oldFlight;
   assert.equal(foreground.getGenerationBlock(), 'foreground-confirmation-required');
   generation = undefined; for (const listener of listeners) listener();
   await foreground.observeBeforeShow();
   assert.equal(scheduled.size, 1, '无连接直接唤出不能取消持续调度');
   generation = 3; for (const listener of listeners) listener();
   assert.equal(scheduled.size, 1);
   foreground.stopContinuous();
   assert.equal(scheduled.size, 0);
   assert.equal(foreground.getGenerationBlock(), 'foreground-confirmation-required');
  } finally { foreground.dispose(); client.cancelPending(); }
 });
});
