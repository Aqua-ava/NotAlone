import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { historicalReplyFixture } from './fixtures/historical-reply-basis.mjs';

async function fixture() {
  const f = await historicalReplyFixture();
  f.records.evidence.layered_status = 'loaded';
  f.records.evidence.layered_context = { schema_version: 3, scope_kind: 'contact', settings_generation: 2,
    organization_generation: 3, profile_version_id: randomUUID(),
    profile_entries: [{ text: '合成生成时L1背景。', temporal_status: 'historical', uncertainty: '仅反映过去',
      references: [{ memory_id: f.memoryId, revision: 1, provenance_kind: 'source_supported', timing: f.records.evidence.evidence[0].timing }] }],
    directory: [], read_policy: 'synthetic-scoped-layered-v3', scenario_read_budget: null,
    budget: { profile_entries: 4, directory_entries: 6, characters: 1800 } };
  const original = structuredClone(f.records.saved), emptyId = randomUUID();
  const empty = { session_id: emptyId, current_input_version_id: null, turns: [], inputs: [] };
  let selected = f.sessionId;
  const request = f.backend.requestJson;
  f.backend.requestJson = async r => {
    if (r.path.endsWith('/assistant-sessions')) {
      if (r.method === 'POST') { selected = emptyId; f.records.saved = structuredClone(empty); }
      return { generation: f.records.generation, data: r.method === 'POST' ? { session_id: emptyId }
        : { current_session_id: selected, sessions: [f.sessionId, emptyId].map(session_id => ({ session_id, is_current: session_id === selected })) } };
    }
    if (r.path.endsWith('/select')) {
      selected = r.path.split('/').at(-2);
      f.records.saved = structuredClone(selected === f.sessionId ? original : empty);
      return { generation: f.records.generation, data: { session_id: selected } };
    }
    return request(r);
  };
  f.original = original;
  f.selection = { ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId };
  f.restore = async () => {
    await f.bridge.readSavedSession(f.scope);
    await f.bridge.newSavedSession(f.scope);
    await f.bridge.listSavedSessions(f.scope);
    await f.bridge.selectSavedSession({ ...f.scope, sessionId: f.sessionId });
    const restored = await f.bridge.getState();
    assert.equal(restored.savedSession.phase, 'ready');
    assert.equal(restored.result, null);
    assert.equal(restored.savedSession.turns[0].reply.candidates[0].text, '合成旧候选：先确认见面时间。');
  };
  return f;
}

test('公开新开会话、刷新目录、返回旧会话后仍能展开原候选依据', async () => {
  const f = await fixture();
  f.contacts.setDraft({ ...f.scope, text: '合成当前草稿。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  await f.bridge.loadEvidence(f.selection);
  assert.equal((await f.bridge.getEvidenceState()).phase, 'ready');
  await f.restore();
  await f.bridge.loadEvidence(f.selection);
  const evidence = await f.bridge.getEvidenceState();
  assert.equal(evidence.phase, 'ready');
  assert.equal(evidence.items[0].text, '合成当时资料：周末有空。');
  await f.bridge.closeEvidence(f.selection);
  assert.equal((await f.bridge.getEvidenceState()).phase, 'idle');
});

test('恢复依据仍拒绝其他联系人、过期范围、请求和候选；失败仅读取原快照', async () => {
  const f = await fixture(); await f.restore();
  const count = f.calls.length;
  for (const change of [{ contactId: randomUUID() }, { scopeRevision: f.scope.scopeRevision - 1 },
    { replyRequestId: randomUUID() }, { candidateId: randomUUID() }]) {
    await assert.rejects(f.bridge.loadEvidence({ ...f.selection, ...change }));
  }
  assert.equal(f.calls.length, count);
  f.records.failure = r => r.path.endsWith('/evidence') ? new Error('合成读取失败') : null;
  await f.bridge.loadEvidence(f.selection);
  assert.equal((await f.bridge.getEvidenceState()).phase, 'failed');
  assert.deepEqual((await f.bridge.getEvidenceState()).items, []);
  f.records.failure = undefined;
  await f.bridge.loadEvidence(f.selection);
  assert.equal((await f.bridge.getEvidenceState()).items[0].text, '合成当时资料：周末有空。');
});

test('恢复依据在切换会话或连接代际后丢弃迟到响应', async () => {
  for (const change of ['session', 'connection']) {
    const f = await fixture(); await f.restore();
    let release, started;
    const held = new Promise(resolve => { started = resolve; });
    f.records.beforeResponse = r => r.path.endsWith('/evidence') ? new Promise(resolve => { release = resolve; started(); }) : undefined;
    const loading = f.bridge.loadEvidence(f.selection); await held;
    if (change === 'session') await f.bridge.newSavedSession(f.scope);
    else { f.records.generation++; for (const listener of f.backendListeners) listener(); f.contacts.setConnection(f.records.generation); }
    release(); await loading;
    const state = await f.bridge.getEvidenceState();
    assert.notEqual(state.phase, 'ready'); assert.deepEqual(state.items, []);
    await assert.rejects(f.bridge.loadEvidence(f.selection));
  }
});

test('公开依据按钮的守卫拒绝显示错误，恢复候选可展开与收起原快照', async t => {
  const { build } = await import('esbuild');
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const f = await fixture(); await f.restore();
  await page.exposeFunction('evidenceCommand', async (name, selection) => {
    if (name === 'getEvidenceState') return f.bridge.getEvidenceState();
    assert(['loadEvidence', 'closeEvidence'].includes(name));
    await f.bridge[name](selection);
    return f.bridge.getEvidenceState();
  });
  const bundled = await build({ stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { ReplyEvidence, useReplyEvidence } from './src/renderer/ReplyEvidence';
    const listeners = new Set();
    window.notalone = { replies: {
      getEvidenceState: () => window.evidenceCommand('getEvidenceState'),
      onEvidenceChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      loadEvidence: async selection => { const state = await window.evidenceCommand('loadEvidence', selection); for (const l of listeners) l(state); },
      closeEvidence: async selection => { const state = await window.evidenceCommand('closeEvidence', selection); for (const l of listeners) l(state); }
    } };
    function View(props) { const evidence = useReplyEvidence(); return React.createElement(ReplyEvidence, { ...props, evidence }); }
    const root = createRoot(document.getElementById('root'));
    window.renderEvidence = props => root.render(React.createElement(View, props));
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  const candidate = (await f.bridge.getState()).savedSession.turns[0].reply.candidates[0];
  await page.evaluate(props => window.renderEvidence(props), { selection: { ...f.selection, candidateId: randomUUID() }, candidate, number: 1, waiting: false });
  await page.getByRole('button', { name: '展开候选1依据' }).click();
  await page.getByRole('alert').waitFor({ timeout: 2000 });
  assert.match(await page.getByRole('alert').textContent(), /候选依据暂不可用/);
  await page.evaluate(props => window.renderEvidence(props), { selection: f.selection, candidate, number: 1, waiting: false });
  await page.getByRole('button', { name: '展开候选1依据' }).click();
  await page.getByText('合成当时资料：周末有空。', { exact: true }).waitFor();
  await page.getByText('合成生成时L1背景。', { exact: true }).waitFor();
  assert.equal(f.calls.some(r => r.path.includes('/layered-context')), false);
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.getByRole('button', { name: '收起候选1依据' }).click();
  await page.getByRole('region', { name: '候选1依据' }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('region', { name: '候选1依据' }).count(), 0);
});


test('恢复依据只接受当前会话界面显示的最后完成候选组', async () => {
  const f = await fixture();
  const older = structuredClone(f.original.turns[0]);
  older.turn_id = randomUUID(); older.input_version_id = randomUUID(); older.request_key = randomUUID();
  older.reply.reply_request_id = randomUUID(); older.reply.candidates[0].candidate_id = randomUUID();
  f.original.turns.unshift(older);
  f.original.inputs.unshift({ ...f.original.inputs[0], turn_id: older.turn_id, input_version_id: older.input_version_id });
  await f.restore();
  await assert.rejects(f.bridge.loadEvidence({ ...f.scope, replyRequestId: older.reply.reply_request_id,
    candidateId: older.reply.candidates[0].candidate_id }));
  await f.bridge.loadEvidence(f.selection);
  assert.equal((await f.bridge.getEvidenceState()).phase, 'ready');
});
