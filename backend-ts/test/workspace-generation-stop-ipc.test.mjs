import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { pureTsFixture } from './pure-ts-runtime-fixture.mjs';
import { syntheticProvider, actualEvidenceId } from './pure-ts-provider-fixture.mjs';
import { sendEvents, useTool } from './reply-service-runtime-support.mjs';

const require = createRequire(new URL('../../desktop/package.json', import.meta.url));
const { build } = require('esbuild');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// 仅替换 Electron 的进程传输；窗口身份、角色、广播、preload 和工作区动作均用生产代码。
async function desktopPorts(t) {
  const directory = await mkdtemp(join(tmpdir(), 'notalone-stop-ipc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = await build({ stdin: { contents: `
    export { ContactSession } from './src/main/contacts/session';
    export { installReplyBridge } from './src/main/reply/bridge';
    export { electronPageCommands } from './src/main/electron-page-commands';
    export { AppWindows } from './src/main/windows';
    export { createReplyBridge } from './src/preload/reply';
    export { BackendHost } from './src/main/backend/host';
    export { RuntimeClient } from './src/main/backend/runtime-client';
    export { useReplySession } from './src/renderer/RewritePanel';
    export { AssistantSessionPanel } from './src/renderer/AssistantSessionPanel';
    export { createElement } from 'react';
    export { renderToStaticMarkup } from 'react-dom/server';
    export { handlers } from 'electron';
  `, resolveDir: new URL('../../desktop/', import.meta.url).pathname },
  bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(new URL('../../desktop/package.json', import.meta.url).pathname)});` },
  plugins: [{ name: 'electron-transport-only', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'synthetic' }));
    builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({ contents: `
      export const handlers = new Map();
      export const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
      export const app = {};
      export class BrowserWindow {}
    ` }));
  } }] });
  const file = join(directory, 'production.mjs');
  await writeFile(file, output.outputFiles[0].text, { mode: 0o600 });
  return import(file);
}

function renderer(ports, windows, role) {
  const listeners = new Map(), notifications = [], calls = [], delivery = {}, inflight = new Set();
  const url = `notalone://app/index.html#${role}`;
  const webContents = { getURL: () => url, mainFrame: { url }, send(channel, value) {
    notifications.push({ channel, value });
    for (const listener of listeners.get(channel) ?? []) listener(undefined, structuredClone(value));
    delivery.send?.(channel, structuredClone(value));
  } };
  windows.windows.set(role, { window: { webContents, isDestroyed: () => false }, failed: false });
  const transport = {
    invoke(channel, ...args) {
      const call = { channel, args }; calls.push(call);
      const result = Promise.resolve().then(() => ports.handlers.get(channel)({ sender: webContents,
        senderFrame: webContents.mainFrame }, ...structuredClone(args))).then(value => structuredClone(value), error => {
        call.error = error.message;
        throw error;
      });
      inflight.add(result); void result.finally(() => inflight.delete(result)).catch(() => {});
      return result;
    },
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set);
    },
    removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
  };
  const bridge = ports.createReplyBridge(transport);
  const states = [];
  const unsubscribe = bridge.onStateChanged(state => states.push(state));
  return { bridge, states, notifications, calls, unsubscribe, delivery, transport, inflight };
}

async function workspacePage(t, helper, contacts) {
  const { chromium, expect } = require('@playwright/test');
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 520, height: 640 } });
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  t.after(() => { if (errors.length) t.diagnostic(JSON.stringify({ renderer_errors: errors })); });
  await page.route('**/*', route => route.abort());
  await page.exposeFunction('__invoke', (channel, ...args) => helper.transport.invoke(channel, ...args));
  await page.exposeFunction('__setDraft', text => {
    const state = contacts.getState();
    contacts.setDraft({ contactId: state.selectedContactId, scopeRevision: state.scopeRevision, text });
    return contacts.getState();
  });
  let delivering = Promise.resolve();
  helper.delivery.send = (channel, value) => {
    delivering = delivering.then(() => page.evaluate(({ channel, value }) => window.__receive?.(channel, value), { channel, value }));
  };
  const source = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { createReplyBridge } from './src/preload/reply';
    import { useReplySession, ReplyCandidates } from './src/renderer/RewritePanel';
    import { UnifiedReplyWorkspace } from './src/renderer/UnifiedReplyWorkspace';
    const listeners = new Map();
    window.__receive = (channel, value) => { for (const listener of listeners.get(channel) ?? []) listener(undefined, value); };
    const replies = createReplyBridge({ invoke: window.__invoke,
      on(channel, listener) { const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set); },
      removeListener: (channel, listener) => listeners.get(channel)?.delete(listener) });
    window.notalone = { replies, expressionPreferences: {
      getState: async () => ({ revision: 0, scopeRevision: 0, contactId: null, erasureRevision: 0, preferences: [], phase: 'ready' }),
      onStateChanged: () => () => {}, refresh: async () => {},
    } };
    function View() {
      const replies = useReplySession();
      const [state, setState] = useState(${JSON.stringify(contacts.getState())});
      const contacts = { state, setDraft: async text => setState(await window.__setDraft(text)) };
      window.__replyState = replies.state;
      return <main className="ime-pane"><UnifiedReplyWorkspace contacts={contacts} replies={replies}/>
        <ReplyCandidates replies={replies} currentDraft={state.draft}/></main>;
    }
    createRoot(document.getElementById('root')).render(<View/>);
  `, resolveDir: new URL('../../desktop/', import.meta.url).pathname, loader: 'tsx' },
  bundle: true, platform: 'browser', format: 'iife', write: false, loader: { '.css': 'empty' } });
  await page.setContent('<div id="root"></div>');
  for (const file of ['rewrite.css', 'helper-layout.css']) {
    await page.addStyleTag({ content: await readFile(new URL('../../desktop/src/renderer/' + file, import.meta.url), 'utf8') });
  }
  await page.addScriptTag({ content: source.outputFiles[0].text });
  await expect(page.getByRole('button', { name: '帮我想想', exact: true })).toBeEnabled();
  return { page, expect, errors, flush: () => delivering };
}

async function within(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), 10_000);
  })]); } finally { clearTimeout(timer); }
}

for (const stage of ['preparation', 'provider']) test(`工作区表达${stage === 'preparation' ? '准备等待' : '供应商等待'}经输入小窗IPC可停止，保留已完成历史`, { timeout: 60_000 }, async t => {
  const oldMask = process.umask(0o077); t.after(() => process.umask(oldMask));
  const ports = await desktopPorts(t);
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = await pureTsFixture(t), owner = randomUUID(), contact = randomUUID(), binding = randomUUID();
  await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')", [owner]);
  await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')", [contact, owner]);
  await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)', [binding, owner, contact]);
  let held = false;
  const provider = await syntheticProvider(t, async (body, res) => {
    const events = [{ type: 'message_start', message: { id: 'synthetic', model: 'deepseek-flash', usage: { input_tokens: 12, output_tokens: 0 } } },
      {}, {}, {}, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }, { type: 'message_stop' }];
    useTool(events, 'ReplyRuntimeOutput', { used_skill_version_id: null, candidates: [{
      text: held ? '停止后的晚合成候选' : '先前已完成的合成候选', basis: '本次合成想法',
      citation_ids: [actualEvidenceId(body)], risk_notes: [],
    }] });
    if (held) { entered.resolve(); await release.promise; }
    sendEvents(res, events);
  });
  const app = await f.start({ NOTALONE_OWNER_ID: owner, NOTALONE_DEEPSEEK_API_KEY: 'synthetic-only',
    NOTALONE_SYNTHETIC_PROVIDER_URL: provider.url });
  const runtime = new ports.RuntimeClient({ ...app.connection, port: Number(app.connection.address.split(':')[1]) });
  t.after(() => runtime.cancelPending());
  // 仅接入本轮已认证握手，不运行配置发现，也不读取用户的环境或资料。
  const backend = new ports.BackendHost(f.directory);
  backend.target = runtime; backend.generation = 1; backend.state = { phase: 'connected', revision: 1 };
  backend.confirmManualInput(contact, 1);
  const preparationEntered = deferred(), originalRequest = backend.requestJson.bind(backend);
  let observePreparation = false;
  backend.requestJson = options => {
    const pending = originalRequest(options);
    if (observePreparation && options.asyncPreparation) preparationEntered.resolve();
    return pending;
  };
  const contacts = new ports.ContactSession(async () => ({ generation: 1,
    contacts: [{ contactId: contact, displayName: '合成联系人', messageCount: 0, sourceCount: 0 }] }));
  const windows = new ports.AppWindows({});
  const helper = renderer(ports, windows, 'helper'), manager = renderer(ports, windows, 'manager');
  const replies = ports.installReplyBridge(ports.electronPageCommands(windows), backend, contacts);
  t.after(() => { helper.unsubscribe(); manager.unsubscribe(); });
  contacts.setConnection(1); await contacts.refreshContacts();
  contacts.selectContact({ contactId: contact, scopeRevision: contacts.getState().scopeRevision });
  const scope = { contactId: contact, scopeRevision: contacts.getState().scopeRevision };
  await helper.bridge.readSavedSession(scope);
  await helper.bridge.enterWorkspace(scope);
  const ui = await workspacePage(t, helper, contacts), { page, expect } = ui;
  t.after(async () => {
    const admin = new pg.Client({ host: '/tmp', database: 'postgres' });
    await admin.connect();
    try { assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1', [f.client.database])).rows[0].n, 0); }
    finally { await admin.end(); }
    assert.equal(app.host.isRunning(), false);
    await assert.rejects(readFile(join(f.directory, 'runtime.env')), { code: 'ENOENT' });
    t.diagnostic(JSON.stringify({ cleanup: { stage, owned_database_remaining: false,
      owned_host_running: false, fixture_removed: true, electron_started: false } }));
  });
  const draft = page.getByRole('textbox', { name: '有什么想说的', exact: true });
  await draft.fill('先前已完成的合成想法');
  await page.getByRole('button', { name: '帮我表达', exact: true }).click();
  await expect(page.getByText('正在等待本次生成结果…', { exact: true })).toHaveCount(0);
  await page.waitForFunction(() => window.__replyState.phase === 'ready');
  await page.waitForFunction(() => window.__replyState.savedSession?.phase === 'ready'
    && window.__replyState.savedSession.turns.some(turn => turn.state === 'completed'));
  const initial = await helper.bridge.getState();
  t.diagnostic(JSON.stringify({ setup_phase: initial.phase, setup_error: initial.errorCode,
    setup_jobs: initial.generationJobs?.map(item => item.phase), calls: helper.calls.map(call => call.channel),
    provider_calls: provider.requests.length, saved_phase: initial.savedSession?.phase }));
  const oldTurn = initial.savedSession.turns.at(-1);
  assert.ok(oldTurn, '复现前须先有同联系人的已完成工作区表达');
  assert.equal(oldTurn.state, 'completed');
  const oldReply = oldTurn.reply.replyRequestId;
  await expect(draft).toBeEnabled();
  await draft.fill('这次希望温和拒绝合成邀请');
  let locked = false;
  if (stage === 'preparation') {
    await f.client.query('BEGIN');
    await f.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`owner:${owner}`]);
    locked = true;
  }
  held = true;
  observePreparation = true;
  await page.getByRole('button', { name: '帮我表达', exact: true }).click();
  try {
    if (stage === 'provider') await within(entered.promise, '工作区表达须进入本机阻塞供应商');
    else {
      await within(preparationEntered.promise, '原工作区请求须进入真实准备传输');
      await page.waitForFunction(() => window.__replyState.phase === 'waiting');
    }
    await ui.flush();
    // 必须取小窗已订阅到的状态；主动 getState 会掩盖通知缺失。
    const state = helper.states.at(-1);
    const job = state.generationJobs?.find(item => item.contactId === contact
      && item.phase === (stage === 'preparation' ? 'preparing' : 'generating'));
    t.diagnostic(JSON.stringify({ provider_calls: provider.requests.length, phase: state.phase,
      helper_job_phases: state.generationJobs?.map(item => item.phase),
      authoritative_job_phases: replies.getState().generationJobs?.map(item => item.phase),
      tracked_stages: [...replies.generationJobs.jobs.values()].map(item => item.stage) }));
    assert.ok(job, '等待期间输入小窗订阅状态必须含当前可停止作业，不能仅显示旧 completed');
    await expect(page.getByRole('button', { name: '停止本次生成', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '停止本次生成', exact: true })).toBeEnabled();
    assert.deepEqual(helper.calls.filter(call => ['reply:update-options', 'reply:generate'].includes(call.channel)).slice(-2)
      .map(call => call.channel), ['reply:update-options', 'reply:generate']);
    await assert.rejects(manager.bridge.stopGeneration({ ...scope, sessionId: job.sessionId,
      requestKey: job.requestKey, inputVersionId: job.inputVersionId }), /页面操作不可用/);
    await page.getByRole('button', { name: '停止本次生成', exact: true }).click();
    if (locked) {
      await page.waitForFunction(() => window.__replyState.generationJobs.some(job => job.phase === 'stopping'));
      await f.client.query('ROLLBACK'); locked = false;
    }
    await page.waitForFunction(() => window.__replyState.generationJobs.some(job => job.phase === 'cancelled'));
    t.diagnostic(JSON.stringify({ stop_error: helper.calls.findLast(call => call.channel === 'reply:stop-generation')?.error ?? null }));
    assert.equal((await helper.bridge.getState()).generationJobs.find(item => item.requestKey === job.requestKey).phase, 'cancelled');
    release.resolve();
    const turns = (await f.client.query('SELECT state,interruption_reason FROM assistant_session_turn ORDER BY created_at,id')).rows;
    assert.equal(turns.length, 2); assert.equal(turns[0].state, 'completed');
    assert.deepEqual(turns[1], { state: 'failed', interruption_reason: 'user_cancelled' });
    const candidates = (await f.client.query('SELECT candidate_text AS text FROM reply_candidate')).rows;
    assert.deepEqual(candidates, [{ text: '先前已完成的合成候选' }]);
    await helper.bridge.readSavedSession(scope);
    assert.equal((await helper.bridge.getState()).savedSession.turns[0].reply.replyRequestId, oldReply);
    assert.equal(provider.requests.length, stage === 'preparation' ? 1 : 2);
    assert.equal(manager.notifications.length, 0, '回复中间状态只广播到输入小窗');
    assert.deepEqual(ui.errors, []);
  } finally {
    if (locked) await f.client.query('ROLLBACK');
    release.resolve();
    await within(Promise.allSettled([...helper.inflight]), '本轮IPC请求须收尾');
  }
});
