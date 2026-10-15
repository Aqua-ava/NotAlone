import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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

test('慢单帧及同步繁忙不误开人工门，真正超时仍有限拒绝', async () => {
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
  const probe = path.join(fixture.directory, 'unavailable-probe');
  const source = await readFile(probe, 'utf8');
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
   await writeFile(probe, source.replace('\n', '\nimport time\ntime.sleep(1.05)\n'));
   await foreground.observeBeforeShow();
   assert.equal(foreground.getState().confirmation, 'verified-binding',
    `完整单帧被拒绝：${foreground.getState().reason}`);
   await writeFile(probe, source);
   deliveryDelay = 1700;
   await foreground.observeBeforeShow();
   assert.equal(foreground.getState().confirmation, 'verified-binding', '有效HTTP响应不能被旧1.5秒UI预算截断');
   deliveryDelay = 0;
   await foreground.observeBeforeShow();
   assert.equal(foreground.getState().confirmation, 'verified-binding');
   assert.equal(foreground.getGenerationBlock(), null);
   assert.equal(contacts.getState().draft, '合成恢复草稿');
   await withBusyCycle(async () => {
    await foreground.observeBeforeShow();
    assert.equal(foreground.getState().reason, 'foreground_observation_busy', '认证HTTP繁忙应保留固定原因');
    assert.equal(foreground.getGenerationBlock(), 'foreground-confirmation-required');
    assert.equal(foreground.getState().recognizedName, null);
   });
   await foreground.observeBeforeShow();
   assert.equal(foreground.getState().confirmation, 'verified-binding', '同步锁释放后可靠绑定应自动恢复');
   await writeFile(probe, source.replace('\n', '\nimport time\ntime.sleep(5)\n'));
   const started = Date.now();
   await foreground.observeBeforeShow();
   assert.equal(foreground.getState().reason, 'probe_timeout', '真正挂起的探针仍须有限退出');
   assert.ok(Date.now() - started < 4000, '单轮不能无限等待');
   assert.equal(foreground.getGenerationBlock(), 'foreground-confirmation-required');
   await writeFile(probe, source);
   await withBusyCycle(() => foreground.observeBeforeShow());
   await foreground.observeBeforeShow();
   assert.equal(foreground.getState().reason, 'manual_confirmation_required', '真实超时不能被后续窗口恢复静默解除');
   assert.equal(contacts.getState().draft, '合成恢复草稿');
  } finally { foreground.dispose(); client.cancelPending(); }
 });
});
