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

test('本轮参考读取冻结表达样本，旧快照保持未知，重新读取清除旧内容', async () => {
  const f = await fixture(); await f.restore();
  const sampleId = randomUUID();
  f.records.evidence.style_references = [{ sample_id: sampleId, text: '合成当时保存的简短说法。' }];
  await f.bridge.loadEvidence(f.selection);
  assert.deepEqual((await f.bridge.getEvidenceState()).styleReferences,
    [{ sampleId, text: '合成当时保存的简短说法。' }]);
  await f.bridge.closeEvidence(f.selection);
  assert.equal((await f.bridge.getEvidenceState()).styleReferences, undefined);
  delete f.records.evidence.style_references;
  await f.bridge.loadEvidence(f.selection);
  assert.equal((await f.bridge.getEvidenceState()).styleReferences, null);
  f.records.evidence.style_references = [{ sample_id: sampleId, text: 'a'.repeat(601) }];
  await f.bridge.loadEvidence(f.selection);
  assert.equal((await f.bridge.getEvidenceState()).phase, 'failed');
  assert.equal((await f.bridge.getEvidenceState()).styleReferences, undefined);
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

test('本次参考默认收起，展示冻结材料与来源，切换请求后清除旧内容', async t => {
  const { build } = await import('esbuild');
  const { chromium, expect } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const f = await fixture(); await f.restore();
  const position = { message_id: f.messageId, char_start: 0, char_end: 4 };
  const temporal = {
    valid_at: '2026-08-01T00:00:00+08:00', invalid_at: '2026-09-01T00:00:00+08:00',
    event: { version: 2, stage: 'planned', stage_verified: true, stage_evidence: [position],
      occurrence_start: '2026-08-01T00:00:00+08:00', occurrence_end: '2026-09-01T00:00:00+08:00',
      occurrence_verified: true, occurrence_evidence: [position], occurrence_precision: 'month',
      occurrence_expression: '八月', anchor_message_id: f.messageId },
    conditions: { version: 1, items: [{ text: '出差期间', source_supported: true, evidence: [position] }] },
    evolution: { version: 1, kind: 'unresolved_conflict', explanation: '两条来源对安排的描述尚未一致。',
      related_versions: [{ memory_id: f.memoryId, revision: 1 }], evidence_message_ids: [f.messageId],
      source_supported: true, claim_changed: false, condition_changed: false },
  };
  const item = f.records.evidence.evidence[0];
  Object.assign(item, temporal);
  item.timing = { ...item.timing, recorded_at: '2026-10-20T01:00:00Z',
    source_started_at: '2026-08-01T00:15:00+08:00', source_ended_at: '2026-08-01T00:15:00+08:00', source_time_complete: true };
  const context = f.records.evidence.layered_context;
  const reference = { ...context.profile_entries[0].references[0], ...temporal, timing: item.timing };
  context.profile_entries[0].references = [reference];
  const scenarioId = randomUUID(), versionId = randomUUID();
  context.directory = [{ scenario_id: scenarioId, version_id: versionId, title: '合成冻结安排', hint: '只反映当时安排',
    paragraph_count: 1, paragraph_range: [0, 1] }];
  context.scenario_read_budget = { call_limit: 3, paragraph_limit: 4, character_limit: 1800 };
  f.records.evidence.layered_scenario_reads = [{ schema_version: 1, status: 'succeeded', reason: '已读取冻结正文。',
    scenario_id: scenarioId, paragraph_range: [0, 1],
    budget: { ...context.scenario_read_budget, used_calls: 1, used_paragraphs: 1, used_characters: 16 },
    document: { scenario_id: scenarioId, version_id: versionId, title: '合成冻结安排', hint: '只反映当时安排',
      system_generated: true, updated_at: '2026-10-20T01:00:00Z', organization_generation: 3, paragraph_range: [0, 1],
      paragraphs: [{ text: '合成冻结主题正文。', references: [reference] }] } }];
  const styleSampleId = randomUUID();
  f.records.evidence.style_references = [{ sample_id: styleSampleId, text: '合成冻结说法：好呀，晚点聊。' }];
  for (const text of ['合成其他候选的参考消息。', '合成未引用的背景消息。']) {
    f.records.evidence.evidence.push({ ...f.records.evidence.evidence[0], evidence_id: randomUUID(), kind: 'message', text, cited: false });
  }
  await page.exposeFunction('evidenceCommand', async (name, selection) => {
    if (name === 'getEvidenceState') return f.bridge.getEvidenceState();
    assert(['loadEvidence', 'closeEvidence'].includes(name));
    await f.bridge[name](selection);
    return f.bridge.getEvidenceState();
  });
  const bundled = await build({ stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { useReplyEvidence } from './src/renderer/ReplyEvidence';
    import { ReplyReferences } from './src/renderer/ReplyReferences';
    const listeners = new Set();
    window.notalone = { replies: {
      getEvidenceState: () => window.evidenceCommand('getEvidenceState'),
      onEvidenceChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      loadEvidence: async selection => { const state = await window.evidenceCommand('loadEvidence', selection); for (const l of listeners) l(state); }
    } };
    function View(props) { const evidence = useReplyEvidence(); return React.createElement(ReplyReferences, { ...props, evidence }); }
    const root = createRoot(document.getElementById('root'));
    window.renderEvidence = props => root.render(React.createElement(View, props));
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false,
    loader: { '.css': 'empty' } });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  const candidate = (await f.bridge.getState()).savedSession.turns[0].reply.candidates[0];
  const props = { selection: f.selection, candidates: [candidate], styleSampleIds: [styleSampleId], waiting: false };
  await page.evaluate(props => window.renderEvidence(props), { ...props, waiting: true });
  await expect(page.getByRole('button', { name: '本次参考', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(props => window.renderEvidence(props), props);
  const toggle = page.getByRole('button', { name: '本次参考', exact: true });
  await expect(toggle).toContainText('聊天 2 条');
  await expect(toggle).toContainText('关系资料 3 条');
  await expect(toggle).toContainText('表达样本 1 条');
  await expect(page.getByRole('region', { name: '本次参考内容' })).toHaveCount(0);
  await toggle.click();
  const evidence = page.getByRole('region', { name: '本次参考内容', exact: true });
  await expect(evidence.getByText('合成冻结说法：好呀，晚点聊。', { exact: true })).toBeVisible();
  await expect(evidence.getByText('合成未引用的背景消息。', { exact: true })).toBeVisible();
  await expect(evidence.getByText('合成生成时L1背景。', { exact: true }).first()).toBeVisible();
  await expect(evidence.getByText('以下材料实际提供给了模型，不代表每条候选都引用了每一项。')).toBeVisible();
  const source = evidence.getByRole('region', { name: '关系资料', exact: true }).locator('.record-metadata').first();
  await expect(source.getByText('入选原因：与本次合成安排相关。', { exact: true })).toBeHidden();
  await source.locator(':scope > summary').click();
  await expect(source.getByText('入选原因：与本次合成安排相关。', { exact: true })).toBeVisible();
  for (const text of ['合成当时资料：周末有空。', '合成生成时L1背景。', '合成冻结主题正文。']) {
    const card = evidence.getByRole('article').filter({ has: page.getByText(text, { exact: true }) });
    const metadata = card.locator('.record-metadata');
    if (await metadata.getAttribute('open') === null) await metadata.locator(':scope > summary').click();
    await expect(card.getByText('来源日期：2026年8月1日（UTC+08:00）', { exact: true })).toBeVisible();
    await expect(card.getByText('适用期间：2026年8月1日 00:00:00（UTC+8） 至 2026年9月1日 00:00:00（UTC+8）之前', { exact: true })).toBeVisible();
    await expect(metadata.getByText('事件阶段：计划（来源已核验）', { exact: true })).toBeVisible();
    await expect(metadata.getByText('事件发生时段：2026年8月（来源已核验）', { exact: true })).toBeVisible();
    await expect(metadata.getByText('时间精度：月；原话：八月', { exact: true })).toBeVisible();
    await expect(metadata.getByText('适用条件：出差期间', { exact: true })).toBeVisible();
    await expect(metadata.getByText('来源支持限定，当前是否满足未知', { exact: true })).toBeVisible();
    await expect(metadata.getByText('变化类型：未解决矛盾', { exact: true })).toBeVisible();
    await expect(metadata.getByText('相关来源存在未解决矛盾，当前主张仍有不确定性，不能当作已确认现状。', { exact: true })).toBeVisible();
  }
  await expect(evidence.getByRole('button', { name: /排除|重新生成|调整/ })).toHaveCount(0);
  assert.equal(f.calls.some(r => r.path.includes('/layered-context') || r.path.includes('/style-samples')), false);
  await toggle.click();
  await expect(evidence).toHaveCount(0);
  delete f.records.evidence.style_references;
  await page.evaluate(props => window.renderEvidence(props), { ...props, waiting: true });
  await expect(toggle).toContainText('正在读取本次参考');
  await page.evaluate(props => window.renderEvidence(props), props);
  await expect(toggle).toContainText('表达样本 1 条');
  await toggle.click();
  await expect(evidence.getByText('本次使用了 1 条表达样本，旧快照未保存原文，不补填当前样本。')).toBeVisible();
  await expect(evidence.getByText('合成冻结说法：好呀，晚点聊。', { exact: true })).toHaveCount(0);
  await page.evaluate(props => window.renderEvidence(props), { ...props, selection: { ...f.selection, replyRequestId: randomUUID() } });
  await expect(toggle).toContainText('本次参考读取失败');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(page.getByText('合成冻结说法：好呀，晚点聊。', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('本次参考读取失败');
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
