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

test('群聊暂停撤销生成资格且不能手动绕过，返回私聊恢复而授权后台同步继续', async () => {
  await ports.withVerifiedForegroundFixture(async fixture => {
    const [a, b] = fixture.data.contact_ids;
    const sessions = [
      { username: 'wxid_synthetic_a', display_name: '合成私聊甲', chat_type: 'private', last_timestamp: 1700000000 },
      { username: 'wxid_synthetic_b', display_name: '合成私聊乙 (8)', chat_type: 'private', last_timestamp: 1700000000 },
      { username: 'synthetic_group', display_name: '合成讨论', chat_type: 'group', last_timestamp: 1700000000 },
    ];
    await fixture.setCli({ sessions, messages: {} });
    assert.equal((await fixture.request('/api/sync/cli-bindings/confirm', { selections: [
      { locator: 'wxid_synthetic_a', contact_id: a }, { locator: 'wxid_synthetic_b', contact_id: b },
    ] })).status, 200);
    assert.equal((await fixture.request('/api/sync/enable', {})).status, 200);
    const client = new ports.JsonClient(await ports.readConnection(fixture.infoPath));
    const requests = [];
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
      async requestJson(request) { requests.push(request.path); return { ...await client.perform(request), generation: 1 }; } };
    const contacts = new ports.ContactSession(() => ports.readContactDirectory(backend));
    contacts.setConnection(1); await contacts.refreshContacts();
    const foreground = new ports.ForegroundController(backend, contacts);
    const observe = async (name, extra = {}) => {
      await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify({
        capture_version: 'automatic-header-v3', display_name: name, ...extra }));
      await foreground.observeBeforeShow();
      return foreground.getState();
    };
    const confirm = () => foreground.confirm({ contactId: a, contactScopeRevision: contacts.getState().scopeRevision,
      foregroundRevision: foreground.getState().foregroundRevision });
    try {
      await observe('合成私聊甲');
      contacts.setDraft({ contactId: a, scopeRevision: contacts.getState().scopeRevision, text: '甲的合成未发送草稿' });
      for (const name of ['合成讨论 (23)', '合成讨论（２３）', '合成讨论', '未知会话 (8)']) {
        const state = await observe(name);
        assert.equal(state.phase, 'paused');
        assert.equal(state.unsupportedConversation, true);
        assert.equal(state.recognizedName, null, '群聊标题不能继续作为联系人名称展示');
        assert.equal(state.confirmedContactId, null);
        assert.equal(foreground.getGenerationBlock(), 'foreground-confirmation-required');
        assert.equal(contacts.getState().selectedContactId, a);
        assert.equal(contacts.getState().draft, '甲的合成未发送草稿');
        assert.throws(confirm, '群聊状态不能用人工确认沿用上一私聊');
        const html = ports.renderToStaticMarkup(ports.createElement(ports.ForegroundPanel, { state }));
        assert.ok(html.includes('群聊暂不支持'));
        assert.ok(!html.includes(name));
        foreground.notifyHelperLifecycle('focused');
        assert.throws(confirm, '打开助手不能解除群聊暂停');
        foreground.notifyHelperLifecycle('blurred');
        await observe('合成私聊甲', { wechat_in_front: false });
        assert.throws(confirm, '离开微信不能解除群聊暂停');
        await observe('合成私聊甲');
        assert.equal(foreground.getState().unsupportedConversation, false);
        assert.equal(foreground.getState().confirmation, 'verified-binding');
      }
      const tails = (await fixture.tails()).length;
      await observe('合成讨论 (23)', { display_name_confidence: 0.5 });
      assert.equal(foreground.getState().phase, 'paused', '疑似群标题仅用于保守暂停，不授予身份');
      assert.equal((await fixture.request('/api/sync/status')).data.sync_enabled, true);
      assert.equal((await fixture.request('/api/sync/check', {})).status, 200);
      const after = await fixture.tails();
      assert.ok(after.length > tails, '群聊前台期间授权私聊仍可同步');
      assert.ok(after.every(locator => ['wxid_synthetic_a', 'wxid_synthetic_b'].includes(locator)));
      assert.equal(requests.some(value => /\/(generate|prepare|rewrite)$/.test(value)), false);
      await observe('合成私聊甲');
      await observe('合成私聊甲', { display_name_confidence: 0.2 });
      await observe('合成讨论 (23)');
      await observe('合成私聊甲');
      assert.equal(foreground.getState().reason, 'manual_confirmation_required', '群聊往返不能解除既有低分人工门');
      assert.equal(foreground.getGenerationBlock(), 'foreground-confirmation-required');
      confirm();
      await observe('合成私聊乙 (8)');
      assert.equal(foreground.getState().confirmedContactId, b, '完整名称本身带数字括号的唯一已绑定私聊仍可核验');
      assert.equal(foreground.getState().unsupportedConversation, false);
    } finally { foreground.dispose(); client.cancelPending(); }
  });
});

test('首次无人数群标题即使候选截断或识别低分也按群元数据暂停', async () => {
  await ports.withVerifiedForegroundFixture(async fixture => {
    const name = '合成首次讨论';
    const group = { username: 'synthetic_first_group', display_name: name,
      chat_type: 'group', last_timestamp: 1700000000 };
    await fixture.setCli({ sessions: [group, ...Array.from({ length: 50 }, (_, index) => ({
      username: `synthetic_group_${index}`, display_name: `${name}${index}`,
      chat_type: 'group', last_timestamp: 1700000000,
    }))], messages: {} });
    assert.equal((await fixture.request('/api/sync/enable', {})).status, 200);
    const observe = async extra => {
      await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify({
        capture_version: 'automatic-header-v3', display_name: name, ...extra,
      }));
      const result = await fixture.request('/api/sync/foreground/observe', {});
      assert.equal(result.status, 200);
      assert.equal(result.data.phase, 'paused');
      assert.equal(result.data.reason, 'group_chat_unsupported');
      assert.equal(Object.hasOwn(result.data, 'recognized_name'), false);
      assert.equal(result.data.contact_id, null);
    };
    await observe({});
    await fixture.setCli({ sessions: [group], messages: {} });
    await observe({ display_name_confidence: 0.5 });
    await observe({ name_complete: false });
  });
});

test('顶部单名称经正式HTTP自动跟随已确认A与B，极低分或截断不能获得生成资格', async () => {
  await ports.withVerifiedForegroundFixture(async fixture => {
    const [a, b] = fixture.data.contact_ids;
    const names = ['唯一合成会话', '另一合成会话'];
    await fixture.setCli({ sessions: names.map((display_name, index) => ({
      username: `wxid_synthetic_${index ? 'b' : 'a'}`, display_name,
      chat_type: 'private', last_timestamp: 1_700_000_000,
    })), messages: {} });
    assert.equal((await fixture.request('/api/sync/cli-bindings/confirm', { selections: [
      { locator: 'wxid_synthetic_a', contact_id: a }, { locator: 'wxid_synthetic_b', contact_id: b },
    ] })).status, 200);
    assert.equal((await fixture.request('/api/sync/enable', {})).status, 200);
    const client = new ports.JsonClient(await ports.readConnection(fixture.infoPath));
    const requests = [];
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
      async requestJson(request) {
        requests.push(request.path);
        return { ...await client.perform(request), generation: 1 };
      } };
    const contacts = new ports.ContactSession(() => ports.readContactDirectory(backend));
    contacts.setConnection(1); await contacts.refreshContacts();
    const foreground = new ports.ForegroundController(backend, contacts);
    const observe = async (name, extra = {}) => {
      await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify({
        capture_version: 'automatic-header-v3', display_name: name, ...extra,
      }));
      await foreground.observeBeforeShow();
      return foreground.getState();
    };
    try {
      const tails = await fixture.tails();
      let state = await observe(names[0]);
      assert.equal(state.confirmation, 'verified-binding');
      assert.equal(state.confirmedContactId, a);
      assert.equal(state.recognizedName, names[0]);
      state = await observe(names[1]);
      assert.equal(state.confirmedContactId, b);
      assert.equal(contacts.getState().selectedContactId, b);
      state = await observe(names[0]);
      assert.equal(state.generationBlock, null);
      assert.deepEqual(await fixture.tails(), tails);
      assert.equal(requests.some(value => /\/(generate|prepare|rewrite)$/.test(value)), false);
      for (const extra of [{ display_name_confidence: 0.2 }, { name_complete: false }]) {
        state = await observe(names[0], extra);
        assert.equal(state.phase, 'manual-required');
        assert.equal(state.confirmedContactId, null);
        assert.equal(state.generationBlock, 'foreground-confirmation-required');
        assert.equal(state.recognizedName, names[0], '未确认身份时也显示实际顶部OCR文字');
        const html = ports.renderToStaticMarkup(ports.createElement(ports.ForegroundPanel, { state }));
        assert.ok(html.includes(names[0]));
        if (extra.display_name_confidence) assert.ok(html.includes('20%'));
      }
      state = await observe('尚未绑定的合成会话');
      assert.equal(state.recognizedName, '尚未绑定的合成会话');
      assert.equal(state.confirmedContactId, null);
      assert.equal(state.generationBlock, 'foreground-confirmation-required');
      state = await observe(names[0], { wechat_in_front: false });
      assert.equal(state.recognizedName, null, '微信离开前台后清除名称预览');
      assert.equal(state.recognitionConfidence, null);
    } finally { foreground.dispose(); client.cancelPending(); }
  });
});

test('系统前台未知经认证观察保留原因，助手不得显示为普通非前台暂停', async () => {
  await ports.withVerifiedForegroundFixture(async fixture => {
    assert.equal((await fixture.request('/api/sync/enable', {})).status, 200);
    await writeFile(path.join(fixture.directory, 'probe-state.json'),
      JSON.stringify({ error: 'foreground_application_unavailable' }));
    const tails = await fixture.tails();
    const observed = await fixture.request('/api/sync/foreground/observe', {});
    assert.equal(observed.status, 200);
    assert.equal(observed.data.phase, 'unavailable');
    assert.equal(observed.data.reason, 'foreground_application_unavailable');
    assert.equal(observed.data.contact_id, null);
    const client = new ports.JsonClient(await ports.readConnection(fixture.infoPath));
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
      async requestJson(request) { return { ...await client.perform(request), generation: 1 }; } };
    const contacts = new ports.ContactSession(() => ports.readContactDirectory(backend));
    contacts.setConnection(1); await contacts.refreshContacts();
    const foreground = new ports.ForegroundController(backend, contacts);
    try {
      await foreground.observeBeforeShow();
      const state = foreground.getState();
      assert.equal(state.phase, 'unavailable');
      assert.equal(state.confirmation, 'required');
      assert.equal(state.generationBlock, 'foreground-confirmation-required');
      const html = ports.renderToStaticMarkup(ports.createElement(ports.ForegroundPanel, { state }));
      assert.ok(html.includes('系统前台状态未知'));
      assert.ok(!html.includes('前台定位已暂停'));
      assert.deepEqual(await fixture.tails(), tails);
    } finally { foreground.dispose(); }
  });
});

test('固定原生名称失败经认证HTTP显示具体原因，未知错误不泄露且不能获得联系人资格', async () => {
  await ports.withVerifiedForegroundFixture(async fixture => {
    assert.equal((await fixture.request('/api/sync/enable', {})).status, 200);
    const tails = await fixture.tails();
    await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify({ error: 'session_name_confidence_low' }));
    const observed = await fixture.request('/api/sync/foreground/observe', {});
    assert.equal(observed.data.reason, 'session_name_confidence_low');
    assert.equal(observed.data.phase, 'unavailable');
    assert.equal(observed.data.contact_id, null);
    const client = new ports.JsonClient(await ports.readConnection(fixture.infoPath));
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
      async requestJson(request) { return { ...await client.perform(request), generation: 1 }; } };
    const contacts = new ports.ContactSession(() => ports.readContactDirectory(backend));
    contacts.setConnection(1); await contacts.refreshContacts();
    const foreground = new ports.ForegroundController(backend, contacts);
    try {
      await foreground.observeBeforeShow();
      const state = foreground.getState();
      assert.equal(state.generationBlock, 'foreground-confirmation-required');
      assert.equal(state.confirmedContactId, null);
      const html = ports.renderToStaticMarkup(ports.createElement(ports.ForegroundPanel, { state }));
      assert.ok(html.includes('名称识别置信度不足'));
      await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify({ error: 'PRIVATE_RAW_ERROR' }));
      const unknown = await fixture.request('/api/sync/foreground/observe', {});
      assert.equal(unknown.data.reason, 'probe_failed');
      assert.ok(!JSON.stringify(unknown.data).includes('PRIVATE'));
      assert.deepEqual(await fixture.tails(), tails);
    } finally { foreground.dispose(); client.cancelPending(); }
  });
});

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
