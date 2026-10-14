import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test, after } from 'node:test';
import { build } from 'esbuild';

const production = await build({ stdin: { contents: [
  "export { ForegroundController } from './src/main/foreground/controller';",
  "export { ForegroundPanel } from './src/renderer/ForegroundPanel';",
  "export { createElement } from 'react';",
  "export { renderToStaticMarkup } from 'react-dom/server';",
  "export { ContactSession } from './src/main/contacts/session';",
  "export { readContactDirectory } from './src/main/contacts/directory';",
  "export { JsonClient } from './src/main/backend/json-client';",
  "export { readConnection } from './src/main/backend/connection';",
  "export { withVerifiedForegroundFixture } from './tests/foreground-backend-fixture';",
].join('\n'), resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const bundleDirectory = await mkdtemp(path.join(tmpdir(), 'notalone-single-frame-http-'));
await writeFile(path.join(bundleDirectory, 'production.mjs'), production.outputFiles[0].text);
const ports = await import(path.join(bundleDirectory, 'production.mjs'));
after(() => rm(bundleDirectory, { recursive: true, force: true }));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// 真实认证 HTTP/隔离 PG 与生产控制器；仅探针、CLI 为合成输入，不启动 App。
test('单帧采集时点经认证观察传到助手，定位不读取正文或发起生成', async () => {
  await ports.withVerifiedForegroundFixture(async (fixture) => {
    const contactId = fixture.data.contact_ids[0];
    await fixture.setCli({ sessions: [
      { username: 'wxid_synthetic_a', display_name: '唯一合成会话', chat_type: 'private', last_timestamp: 1_700_000_000 },
      { username: 'wxid_synthetic_b', display_name: '另一合成会话', chat_type: 'private', last_timestamp: 1_700_000_000 },
    ], messages: {} });
    assert.equal((await fixture.request('/api/sync/cli-bindings/confirm', { selections: [
      { locator: 'wxid_synthetic_a', contact_id: contactId },
    ] })).status, 200);
    assert.equal((await fixture.request('/api/sync/enable', {})).status, 200);
    const capturedAt = new Date().toISOString();
    await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify({ captured_at: capturedAt }));
    const tails = await fixture.tails();
    const routeStartedAt = performance.now();
    const observed = await fixture.request('/api/sync/foreground/observe', {});
    const routeElapsedMs = performance.now() - routeStartedAt;
    assert.equal(observed.status, 200);
    assert.equal(observed.data.phase, 'confirmed');
    assert.equal(observed.data.contact_id, contactId);
    assert.equal(Date.parse(observed.data.observed_at), Date.parse(capturedAt));
    assert.deepEqual(Object.keys(observed.data).sort(), [
      'binding_id', 'contact_id', 'observation_id', 'observed_at', 'phase', 'probe_available', 'reason', 'wechat_in_front',
    ]);
    const client = new ports.JsonClient(await ports.readConnection(fixture.infoPath));
    const requests = [];
    let pendingDelivery;
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
      async requestJson(request) {
        requests.push(request.path);
        const response = await client.perform(request);
        if (pendingDelivery && request.path === '/api/sync/foreground/observe') {
          const delivery = pendingDelivery;
          pendingDelivery = undefined;
          delivery.received.resolve();
          await delivery.released.promise;
        }
        return { ...response, generation: 1 };
      } };
    const contacts = new ports.ContactSession(() => ports.readContactDirectory(backend));
    contacts.setConnection(1);
    await contacts.refreshContacts();
    const foreground = new ports.ForegroundController(backend, contacts);
    try {
      const controllerStartedAt = performance.now();
      await foreground.observeBeforeShow();
      const controllerElapsedMs = performance.now() - controllerStartedAt;
      const state = foreground.getState();
      assert.equal(state.phase, 'confirmed');
      assert.equal(state.confirmation, 'verified-binding');
      assert.equal(state.confirmedContactId, contactId);
      assert.equal(Date.parse(state.observedAt), Date.parse(capturedAt));
      assert.equal(contacts.getState().selectedContactId, contactId);
      assert.equal(state.generationBlock, null);
      assert.equal(requests.some(value => value.includes('/replies')), false);
      assert.deepEqual(await fixture.tails(), tails);
      process.stdout.write(`single_frame_synthetic_timing: ${JSON.stringify({
        routeElapsedMs: Math.round(routeElapsedMs), controllerElapsedMs: Math.round(controllerElapsedMs),
        realAppVerified: false,
      })}\n`);
      await foreground.observeBeforeShow();
      const suggested = foreground.getState();
      assert.equal(suggested.confirmedContactId, contactId);
      assert.equal(suggested.confirmation, 'verified-binding', '已有编辑不阻止可信绑定自动跟随');
      assert.equal(Date.parse(suggested.observedAt), Date.parse(capturedAt));
      const suggestionHtml = ports.renderToStaticMarkup(ports.createElement(ports.ForegroundPanel,
        { state: suggested, session: { state: contacts.getState() } }));
      assert.ok(suggestionHtml.includes(suggested.observedAt), '保留编辑时仍展示建议的采集时点');
      assert.ok(suggestionHtml.includes('之后的切换可能尚未反映'));
      foreground.confirm({ contactId, contactScopeRevision: contacts.getState().scopeRevision,
        foregroundRevision: foreground.getState().foregroundRevision });
      const delivery = { received: deferred(), released: deferred() };
      pendingDelivery = delivery;
      const inFlight = foreground.observeBeforeShow();
      try {
        await delivery.received.promise;
        foreground.notifyHelperLifecycle('focused');
        const paused = foreground.getState();
        assert.equal(paused.confirmation, 'manual-confirmed', '助手获焦仅暂停，不能撤销已手选联系人');
        assert.equal(paused.generationBlock, null);
        assert.equal(paused.confirmedContactId, contactId);
        assert.equal(paused.phase, 'paused');
        delivery.released.resolve();
        await inFlight;
        assert.equal(foreground.getState().suspendedByHelperFocus, true);
        assert.equal(foreground.getState().confirmation, 'manual-confirmed', '迟到观察不能覆盖暂停后的手选');
        assert.equal(foreground.getState().phase, 'paused');
      } finally { delivery.released.resolve(); await inFlight; }
      foreground.notifyHelperLifecycle('blurred');
      for (const version of ['minimal-region-v1', 'automatic-window-v1']) {
        await writeFile(path.join(fixture.directory, 'probe-state.json'),
          JSON.stringify({ capture_version: version, captured_at: capturedAt }));
        await foreground.observeBeforeShow();
        const legacy = foreground.getState();
        assert.equal(legacy.phase, 'manual-required', '旧协议不能冒充单帧观察');
        assert.equal(legacy.confirmation, 'required');
        assert.equal(legacy.generationBlock, 'foreground-confirmation-required');
      }
      const selection = contacts.getState();
      foreground.confirm({ contactId, contactScopeRevision: selection.scopeRevision,
        foregroundRevision: foreground.getState().foregroundRevision });
      assert.equal(foreground.getState().generationBlock, null);
      for (const [input, phase] of [
        [{ captured_at: capturedAt, selected_row_name_confidence: 0.89 }, 'manual-required'],
        [{ captured_at: capturedAt, selected_row_name: '另一合成会话' }, 'manual-required'],
        [{ captured_at: '2026-10-14T06:30:00' }, 'unavailable'],
        [{ captured_at: '无效采集时间' }, 'unavailable'],
      ]) {
        await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify(input));
        await foreground.observeBeforeShow();
        const rejected = foreground.getState();
        assert.equal(rejected.phase, phase);
        assert.equal(rejected.confirmation, 'required', '新的不可靠观察不能继承上次手动确认');
        assert.equal(rejected.generationBlock, 'foreground-confirmation-required');
      }
      await fixture.setCli({ sessions: [
        { username: 'wxid_synthetic_a', display_name: '唯一合成会话', chat_type: 'private', last_timestamp: 1_700_000_000 },
        { username: 'wxid_synthetic_b', display_name: '唯一合成会话', chat_type: 'private', last_timestamp: 1_700_000_000 },
      ], messages: {} });
      await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify({ captured_at: capturedAt }));
      const ambiguous = await fixture.request('/api/sync/foreground/observe', {});
      assert.equal(ambiguous.data.phase, 'manual-required');
      assert.equal(ambiguous.data.reason, 'ambiguous_requires_selection');
      assert.equal(ambiguous.data.contact_id, null);
      await fixture.setCli({ sessions: [
        { username: 'wxid_synthetic_a', display_name: '改名合成会话', chat_type: 'private', last_timestamp: 1_700_000_000 },
      ], messages: {} });
      await writeFile(path.join(fixture.directory, 'probe-state.json'),
        JSON.stringify({ captured_at: capturedAt, display_name: '改名合成会话', selected_row_name: '改名合成会话' }));
      const renamed = await fixture.request('/api/sync/foreground/observe', {});
      assert.equal(renamed.data.phase, 'manual-required');
      assert.equal(renamed.data.reason, 'unmatched_requires_selection');
      assert.equal(renamed.data.contact_id, null);
    } finally { foreground.dispose(); client.cancelPending(); }
  });
});
