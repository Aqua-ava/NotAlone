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
 export { JsonClient } from './src/main/backend/json-client';
 export { readConnection } from './src/main/backend/connection';
 export { withContinuousForegroundFixture } from './tests/foreground-backend-fixture';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
 banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const directory = await mkdtemp(path.join(tmpdir(), 'notalone-observation-budget-'));
await writeFile(path.join(directory, 'production.mjs'), built.outputFiles[0].text);
const ports = await import(path.join(directory, 'production.mjs'));
after(() => rm(directory, { recursive: true }));

test('后台尾读不阻塞前台身份，慢单帧可完成且真正超时仍有限拒绝', async t => {
 await ports.withContinuousForegroundFixture(async fixture => {
  const [a] = fixture.data.contact_ids;
  await fixture.setCli({ sessions: [{ username: 'wxid_synthetic_a', display_name: '合成窗口预算甲',
   chat_type: 'private', last_timestamp: 1700000000 }], messages: {} });
  assert.equal((await fixture.request('/api/sync/cli-bindings/confirm', { selections: [
   { locator: 'wxid_synthetic_a', contact_id: a }] })).status, 200);
  assert.equal((await fixture.request('/api/sync/enable', {})).status, 200);
  await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify({
   capture_version: 'automatic-header-v3', display_name: '合成窗口预算甲' }));
  const client = new ports.JsonClient(await ports.readConnection(fixture.infoPath));
  let deliveryDelay = 0;
  const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
   async requestJson(request) {
    const response = await client.perform(request);
    if (request.path.endsWith('/observe') && deliveryDelay) await new Promise(resolve => setTimeout(resolve, deliveryDelay));
    return { ...response, generation: 1 };
   } };
  const contacts = new ports.ContactSession(() => ports.readContactDirectory(backend));
  contacts.setConnection(1); await contacts.refreshContacts();
  const foreground = new ports.ForegroundController(backend, contacts);
  // 常驻探针逐轮读合成输入；修改磁盘可执行文件不会改变已运行的进程。
  const delayObservation = async delay => writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify({
   capture_version: 'automatic-header-v3', display_name: '合成窗口预算甲', delay_seconds: delay }));
  const withBusyCycle = async use => {
   const gate = path.join(fixture.directory, 'hold-tail-wxid_synthetic_a');
   const before = (await fixture.tails()).length;
   await writeFile(gate, '');
   const cycle = fixture.request('/api/sync/check', {});
   try {
    let held = false;
    for (let attempt = 0; attempt < 150; attempt++) {
     if ((await fixture.tails()).length > before) { held = true; break; }
     await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(held, true, '真实同步周期须先进入受控CLI尾读');
    await use();
   } finally { await rm(gate); await cycle; }
  };
  try {
   await foreground.observeBeforeShow();
   assert.equal(foreground.getState().confirmation, 'verified-binding');
   contacts.setDraft({ contactId: a, scopeRevision: contacts.getState().scopeRevision, text: '合成恢复草稿' });
   await delayObservation(1.05);
   const slowStarted = Date.now();
   await foreground.observeBeforeShow();
   assert.ok(Date.now() - slowStarted >= 1000, '本轮合成观察须实际经历慢帧延迟');
   assert.equal(foreground.getState().confirmation, 'verified-binding',
    `完整单帧被拒绝：${foreground.getState().reason}`);
   await delayObservation(0);
   deliveryDelay = 1700;
   await foreground.observeBeforeShow();
   assert.equal(foreground.getState().confirmation, 'verified-binding', '有效HTTP响应不能被旧1.5秒UI预算截断');
   deliveryDelay = 0;
   await foreground.observeBeforeShow();
   assert.equal(foreground.getState().confirmation, 'verified-binding');
   assert.equal(foreground.getGenerationBlock(), null);
   assert.equal(contacts.getState().draft, '合成恢复草稿');
   await withBusyCycle(async () => {
    const began = Date.now();
    await foreground.observeBeforeShow();
    assert.equal(foreground.getState().confirmation, 'verified-binding', '后台CLI尾读阻塞时仍应独立完成正式识别');
    assert.equal(foreground.getGenerationBlock(), null);
    const elapsed = Date.now() - began;
    assert.ok(elapsed < 3000, '前台身份不能等待受控后台尾读释放');
    t.diagnostic(`后台尾读保持阻塞时，合成前台观察完成耗时${elapsed}ms`);
   });
   await foreground.observeBeforeShow();
   assert.equal(foreground.getState().confirmation, 'verified-binding', '同步锁释放后可靠绑定应自动恢复');
   await delayObservation(5);
   const started = Date.now();
   await foreground.observeBeforeShow();
   assert.equal(foreground.getState().reason, 'probe_timeout', '真正挂起的探针仍须有限退出');
   assert.ok(Date.now() - started < 4000, '单轮不能无限等待');
   assert.equal(foreground.getGenerationBlock(), 'foreground-confirmation-required');
   await delayObservation(0);
   await withBusyCycle(() => foreground.observeBeforeShow());
   await foreground.observeBeforeShow();
   assert.equal(foreground.getState().reason, 'manual_confirmation_required', '真实超时不能被后续窗口恢复静默解除');
   assert.equal(contacts.getState().draft, '合成恢复草稿');
  } finally { foreground.dispose(); client.cancelPending(); }
 });
});
