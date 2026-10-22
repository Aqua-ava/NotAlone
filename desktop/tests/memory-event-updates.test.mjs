import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { MemoryReadingController } from './src/main/memory/controller';
  export { installMemoryBridge } from './src/main/memory/bridge';
  export { createMemoryBridge } from './src/preload/memory';
  export { BackendRequestFailure } from './src/main/backend/json-client';
  export * from './src/renderer/MemoryPage';
  export { MemoryEventDetails } from './src/renderer/MemoryEventDetails';
  export { memoryRemovalTarget } from './src/renderer/memory-availability';
  export { renderToStaticMarkup } from 'react-dom/server';
  export { createElement } from 'react';
`, resolveDir: process.cwd() }, bundle: true, packages: 'external', jsx: 'automatic', platform: 'node', format: 'cjs',
  loader: { '.css': 'empty' }, write: false });
const compiledModule = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
  createRequire(import.meta.url), compiledModule, compiledModule.exports,
);
const ports = compiledModule.exports;

test('管理列表同时展示当前和失效记忆，失效条目划线且不能作为候选更新目标', async () => {
  const current = memoryDto('contact', { memory_id: ids.current, text: '目前住在合成城市乙。' });
  const retired = memoryDto('contact', { status: 'invalidated', retirement_reason: 'state_changed', text: '以前住在合成城市甲。' });
  const candidate = candidateDto();
  let writes = 0;
  const { controller, selection } = await controllerFixture(async (request) => {
    if (request.method === 'POST') writes++;
    const data = request.path.endsWith('/memory-candidates') ? { candidates: [candidate] }
      : request.path.endsWith('/owner-memories') ? { memories: [] }
      : request.path.endsWith('/sources') ? { sources: [] } : { memories: [current, retired] };
    return { generation: 1, data };
  });
  await controller.refresh(selection());
  const entries = controller.getState().contact.items;
  assert.deepEqual(entries.map(item => item.status), ['active', 'invalidated']);
  const html = entries.map(memory => ports.renderToStaticMarkup(ports.createElement(ports.MemoryCard, {
    content: memory, memory, sources: { phase: 'ready', items: [] }, trace: () => {},
    correct: async () => {}, remove: async () => {},
  }))).join('');
  assert.match(html, /<s>以前住在合成城市甲。<\/s>/);
  assert.match(html, /已失效 · 不再引用/);
  assert.doesNotMatch(html, /有效记忆 · 可用于回复/);
  // 最简卡片不展示版本历史；失效旧版继续禁止修改。
  assert.doesNotMatch(html, /查看版本历史/);
  const retiredHtml = ports.renderToStaticMarkup(ports.createElement(ports.MemoryCard, {
    content: retired, memory: retired, sources: { phase: 'ready', items: [] }, trace: () => {},
    correct: async () => {}, remove: async () => {},
  }));
  assert.doesNotMatch(retiredHtml, /查看版本历史|修正资料：以前住在/);
  assert.match(html, /删除资料：以前住在/);
  await assert.rejects(controller.applyCandidateUpdate({ ...selection(), candidateId: ids.candidate,
    previousMemoryId: ids.previous, expectedRevision: 2 }));
  await assert.rejects(controller.correct({ ...selection(), level: 'contact', memoryId: ids.previous,
    revision: 2, text: '不允许修改失效旧版。', category: 'common_fact' }));
  assert.equal(writes, 0);
  await controller.remove({ ...selection(), level: 'contact', memoryId: ids.previous, revision: 2 });
  assert.equal(writes, 1);
});

test('到期记忆划线，未来生效与普通历史事件不会被误标为过期', () => {
  const base = { memoryId: ids.current, level: 'contact', status: 'active', adoptionMethod: 'manual',
    revision: 1, supersedesMemoryId: null, sourceCandidateId: null, text: '合成有效期条目。',
    category: 'common_fact', topic: 'other', sourceIds: [ids.source], confidence: 1, riskFlags: [],
    validAt: null, invalidAt: null, timing: { recordedAt: null, sourceStartedAt: null, sourceEndedAt: null,
      sourceTimeComplete: false, currentStatus: 'historical', currentStatusReason: '过去发生的事件。' } };
  const render = overrides => {
    const memory = { ...base, ...overrides };
    return ports.renderToStaticMarkup(ports.createElement(ports.MemoryCard, {
      memory, content: memory, sources: { phase: 'ready', items: [] }, trace: () => {},
    }));
  };
  assert.match(render({ invalidAt: '2000-01-01T00:00:00Z' }), /<s>合成有效期条目。<\/s>/);
  assert.match(render({ invalidAt: '2000-01-01T00:00:00Z' }), /已过期 · 不再引用/);
  assert.doesNotMatch(render({}), /<s>/);
  assert.match(render({ validAt: '2100-01-01T00:00:00Z' }), /尚未生效 · 暂不引用/);
});

const ids = { contact: '11111111-1111-4111-8111-111111111111', other: '99999999-9999-4999-8999-999999999999',
  previous: '22222222-2222-4222-8222-222222222222', current: '33333333-3333-4333-8333-333333333333',
  candidate: '44444444-4444-4444-8444-444444444444', decision: '55555555-5555-4555-8555-555555555555',
  message: '66666666-6666-4666-8666-666666666666', source: '77777777-7777-4777-8777-777777777777' };
const content = { category: 'relationship_note', topic: 'other', source_ids: [ids.message], confidence: 0.9,
  risk_flags: [], valid_at: null, invalid_at: null, timing: { recorded_at: '2026-10-14T11:00:00+08:00',
    source_started_at: '2026-10-01T10:00:00+08:00', source_ended_at: '2026-10-01T10:00:00+08:00',
    source_time_complete: true, current_status: 'current_unverified', current_status_reason: '历史安排，当前未核实。' } };
const event = { version: 1, stage: 'agreed', stage_verified: true,
  stage_evidence: [{ message_id: ids.message, char_start: 0, char_end: 6 }],
  occurrence_start: '2026-10-20T14:00:00+08:00', occurrence_end: '2026-10-20T16:00:00+08:00',
  occurrence_verified: true, occurrence_evidence: [{ message_id: ids.message, char_start: 7, char_end: 14 }] };
function memoryDto(level = 'contact', overrides = {}) {
  return { ...content, memory_id: ids.previous, level, contact_id: ids.contact, text: '计划参加这次读书会。',
    status: 'active', adoption_method: 'manual', revision: 2, supersedes_memory_id: null,
    source_candidate_id: null, ...overrides };
}
function candidateDto(subject = 'contact', overrides = {}) {
  return { ...content, candidate_id: ids.candidate, subject, status: 'pending', text: '已参加完这次读书会。', ...overrides };
}
async function controllerFixture(requestJson) {
  let generation = 1;
  const backend = { getConnectionGeneration: () => generation, requestJson, onStateChanged: () => () => {} };
  const contacts = new ports.ContactSession(async () => ({ generation,
    contacts: [ids.contact, ids.other].map((contactId) => ({ contactId, displayName: '合成事件联系人', messageCount: 2, sourceCount: 1 })) }));
  contacts.setConnection(generation); await contacts.refreshContacts();
  contacts.selectContact({ contactId: ids.contact, scopeRevision: contacts.getState().scopeRevision });
  const controller = new ports.MemoryReadingController(backend, contacts);
  const selection = () => ({ contactId: contacts.getState().selectedContactId, scopeRevision: contacts.getState().scopeRevision });
  return { controller, backend, contacts, selection, disconnect: () => { generation = undefined; contacts.setConnection(undefined); } };
}

test('用户明确选择旧版并应用新候选，保留当前纠正决定和手动身份', async () => {
  const previous = memoryDto();
  const candidate = candidateDto('contact', { correction_review: [{ decision_id: ids.decision,
    decision: 'corrected', previous_text: '旧错误。', corrected_text: '原人工判断。', new_message_ids: [ids.message],
    new_source_ids: [ids.source], semantic_relation: 'uncertain', reason: '新依据待确认，原人工判断仍有效。' }] });
  let committed = false, posted;
  const { controller, selection } = await controllerFixture(async (request) => {
    if (request.method === 'POST') { posted = request; committed = true; return { generation: 1, data: {} }; }
    const data = request.path.endsWith('/memory-candidates') ? { candidates: committed ? [] : [candidate] }
      : { memories: [committed ? memoryDto('contact', { memory_id: ids.current, text: candidate.text,
        supersedes_memory_id: ids.previous, source_candidate_id: ids.candidate, revision: 3 }) : previous] };
    return { generation: 1, data };
  });
  await controller.refresh({ ...selection(), section: 'contact' });
  await controller.refresh({ ...selection(), section: 'pending' });
  await controller.applyCandidateUpdate({ ...selection(), candidateId: ids.candidate,
    previousMemoryId: ids.previous, expectedRevision: 2 });
  assert.equal(posted.path, `/api/contacts/${ids.contact}/memory-candidates/${ids.candidate}/apply-update`);
  assert.deepEqual(posted.body, { previous_memory_id: ids.previous, expected_revision: 2, correction_decision_ids: [ids.decision] });
  assert.equal(controller.getState().mutation.phase, 'success');
  assert.deepEqual(controller.getState().pending.items, []);
  assert.equal(controller.getState().contact.items[0].adoptionMethod, 'manual');
  assert.equal(controller.getState().contact.items[0].supersedesMemoryId, ids.previous);
  const html = ports.renderToStaticMarkup(ports.createElement(ports.PendingMemoryUpdate, {
    candidate: { ...controller.getState().contact.items[0], candidateId: ids.candidate, subject: 'contact' },
    memories: { phase: 'ready', items: [{ ...controller.getState().contact.items[0], memoryId: ids.previous, text: previous.text }] },
    apply: async () => {},
  }));
  assert.match(html, /选择要更新的当前资料/);
  assert.match(html, /请先选择并核对旧资料/);
  assert.match(html, /旧条目划线保留且不再引用/);
});

test('用户主动查看变化历史，旧版保留原采纳身份和独立来源时间', async () => {
  const previous = memoryDto('contact', { status: 'invalidated', adoption_method: 'auto' });
  const current = memoryDto('contact', { memory_id: ids.current, revision: 3, text: '已参加完这次读书会。',
    supersedes_memory_id: ids.previous, timing: { ...content.timing, recorded_at: '2026-10-14T12:00:00+08:00' } });
  const { controller, selection } = await controllerFixture(async (request) => ({ generation: 1,
    data: request.path.endsWith('/versions') ? { versions: [current, previous] } : { memories: [current] } }));
  await controller.refresh({ ...selection(), section: 'contact' });
  await controller.openVersions({ ...selection(), level: 'contact', memoryId: ids.current, revision: 3 });
  const history = controller.getState().history;
  assert.equal(history.phase, 'ready');
  assert.deepEqual(history.items.map((item) => item.text), ['已参加完这次读书会。', '计划参加这次读书会。']);
  assert.equal(history.items[1].adoptionMethod, 'auto');
});

for (const reason of [undefined, 'unknown', 'error_correction', 'state_changed']) {
  test(`公开历史读取保留失效原因 ${reason ?? '旧载荷缺省'}`, async () => {
    const previous = memoryDto('contact', { status: 'invalidated', ...(reason === undefined ? {} : {
      retirement_reason: reason, retired_at: '2026-10-18T12:00:00+08:00' }) });
    const current = memoryDto('contact', { memory_id: ids.current, revision: 3, supersedes_memory_id: ids.previous,
      retirement_reason: 'unknown', retired_at: null });
    const { controller, selection } = await controllerFixture(async request => ({ generation: 1,
      data: request.path.endsWith('/versions') ? { versions: [current, previous] } : { memories: [current] } }));
    await controller.refresh({ ...selection(), section: 'contact' });
    assert.equal(controller.getState().contact.phase, 'ready');
    await controller.openVersions({ ...selection(), level: 'contact', memoryId: ids.current, revision: 3 });
    const history = controller.getState().history;
    assert.equal(history.phase, 'ready');
    assert.equal(history.items[1].retirementReason, reason ?? 'unknown');
    assert.equal(history.items[1].retiredAt, reason === undefined ? null : '2026-10-18T12:00:00+08:00');
  });
}

test('只有服务端核对仍合法的自动版本可以撤销，未知旧证明不提供恢复', async () => {
  for (const level of ['contact', 'owner']) for (const eligible of [true, false]) {
    const previous = memoryDto(level, { adoption_method: 'auto' });
    const current = memoryDto(level, { memory_id: ids.current, revision: 3, adoption_method: 'auto',
      text: '读书会改到二号会议室举行。', supersedes_memory_id: ids.previous,
      ...(eligible ? { can_revert_auto_update: true, version_evidence_source_current: true } : {}) });
    let reverted = false, posted;
    const { controller, selection } = await controllerFixture(async (request) => {
      if (request.method === 'POST') { posted = request; reverted = true; return { generation: 1, data: {} }; }
      return { generation: 1, data: request.path.endsWith('/versions')
        ? { versions: [current, { ...previous, status: 'invalidated' }] }
        : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [reverted ? previous : current] } };
    });
    await controller.refresh({ ...selection(), section: level });
    await controller.openVersions({ ...selection(), level, memoryId: ids.current, revision: 3 });
    if (!eligible) {
      await assert.rejects(controller.revertAutoUpdate({ ...selection(), level, memoryId: ids.current, revision: 3 }));
      assert.equal(posted, undefined);
      continue;
    }
    await controller.revertAutoUpdate({ ...selection(), level, memoryId: ids.current, revision: 3 });
    assert.equal(posted.path, level === 'owner' ? `/api/contacts/${ids.contact}/owner-memories/${ids.current}/revert-auto-update`
      : `/api/contacts/${ids.contact}/memories/${ids.current}/revert-auto-update`);
    assert.deepEqual(posted.body, { expected_revision: 3 });
    assert.equal(controller.getState().mutation.phase, 'success');
    assert.equal(controller.getState().history.phase, 'idle');
    assert.equal(controller.getState()[level].items[0].text, previous.text);
    assert.equal(controller.getState()[level].items[0].adoptionMethod, 'auto');
  }
});

test('来源支持的事件阶段、发生时段与聊天和保存时间分别呈现，约定到期不会显示已发生', async () => {
  const { controller, selection } = await controllerFixture(async () => ({ generation: 1,
    data: { memories: [memoryDto('contact', { event, valid_at: '2026-10-01T00:00:00+08:00',
      invalid_at: '2026-10-02T00:00:00+08:00' })] } }));
  await controller.refresh({ ...selection(), section: 'contact' });
  const entry = controller.getState().contact.items[0];
  assert.equal(entry.event.stage, 'agreed');
  const html = ports.renderToStaticMarkup(ports.createElement(ports.MemoryEventDetails, { event: entry.event }));
  assert.match(html, /事件阶段：约定/);
  assert.match(html, /2026年10月20日 14:00:00/);
  assert.match(html, /2026年10月20日 16:00:00/);
  assert.match(html, /来源已核验/);
  assert.match(html, /阶段依据/);
  assert.match(html, /发生时段依据/);
  assert.ok(html.includes(ids.message));
  assert.doesNotMatch(html, /事件阶段：已发生/);
  assert.doesNotMatch(html, /2026年10月1日|2026年10月14日/);
  assert.match(html, /时间到期不会自动标记已发生/);
});

test('旧版本应用或撤销遇到冲突或来源删除后清空旧视图，必须重新核对后操作', async () => {
  for (const level of ['contact', 'owner']) for (const operation of ['apply', 'undo']) for (const status of [409, 404]) {
    const current = memoryDto(level, { memory_id: ids.current, revision: 3, adoption_method: 'auto',
      supersedes_memory_id: ids.previous, can_revert_auto_update: true, version_evidence_source_current: true });
    const candidate = candidateDto(level === 'owner' ? 'self' : 'contact');
    let posts = 0;
    const { controller, selection } = await controllerFixture(async (request) => {
      if (request.method === 'POST') { posts++; throw new Error(`合成 HTTP 状态 ${status}`); }
      const data = request.path.endsWith('/versions')
        ? { versions: [current, memoryDto(level, { status: 'invalidated', adoption_method: 'auto' })] }
        : request.path.endsWith('/memory-candidates') ? { candidates: [candidate] } : { memories: [current] };
      return { generation: 1, data };
    });
    await controller.refresh({ ...selection(), section: level });
    await controller.refresh({ ...selection(), section: 'pending' });
    await controller.openVersions({ ...selection(), level, memoryId: ids.current, revision: 3 });
    const act = () => operation === 'apply'
      ? controller.applyCandidateUpdate({ ...selection(), candidateId: ids.candidate, previousMemoryId: ids.current, expectedRevision: 3 })
      : controller.revertAutoUpdate({ ...selection(), level, memoryId: ids.current, revision: 3 });
    await act();
    const after = controller.getState();
    assert.equal(after.mutation.phase, 'error');
    assert.deepEqual(after[level].items, []);
    assert.deepEqual(after.pending.items, []);
    assert.equal(after.history.phase, 'idle');
    await assert.rejects(act());
    assert.equal(posts, 1, '冲突后不得复用旧版本发起第二次请求');
  }
});

test('记忆页面组通过两层有限启动守卫，已删除的版本历史页面不再登记', async () => {
  const source = await readFile('scripts/test-pages.mjs', 'utf8');
  const parser = source.slice(source.indexOf('function parse(args)'), source.indexOf('async function run(options)'));
  for (const name of ['memory-current-status', 'memory-correction-protection']) {
    const parsed = runInNewContext(`${parser}; parse(args)`, { args: ['--case', name, '--timeout-seconds', '180'] });
    assert.equal(JSON.stringify(parsed), JSON.stringify({ names: [name], timeout: 180 }));
  }
  assert.throws(() => runInNewContext(`${parser}; parse(args)`, {
    args: ['--case', 'memory-event-updates', '--timeout-seconds', '180'],
  }), /page_test_arguments/);
  const runner = await readFile('tests/headless/run.ts', 'utf8');
  const guard = runner.slice(runner.indexOf('if (!Array.isArray(cases)'), runner.indexOf('let browser:'));
  assert.doesNotThrow(() => runInNewContext(guard, { cases: ['memory-current-status'] }));
  assert.throws(() => runInNewContext(guard, { cases: ['memory-event-updates'] }), /page_test_arguments/);
  assert.throws(() => runInNewContext(guard, { cases: ['unknown-page'] }), /page_test_arguments/);
  assert.doesNotMatch(runner, /memoryEventUpdates/);
});

test('旧空事件保持未知，阶段和部分发生时段的来源核验各自独立', async () => {
  const variants = [undefined, null,
    { ...event, stage: 'planned', occurrence_verified: false, occurrence_evidence: [] },
    { ...event, stage: 'occurred', stage_verified: false, stage_evidence: [], occurrence_end: null },
    { ...event, stage: 'unknown', stage_verified: false, stage_evidence: [], occurrence_start: null,
      occurrence_end: null, occurrence_verified: false, occurrence_evidence: [] }];
  for (const proposed of variants) {
    const candidate = candidateDto('self', { event: proposed });
    const { controller, selection } = await controllerFixture(async () => ({ generation: 1, data: { candidates: [candidate] } }));
    await controller.refresh({ ...selection(), section: 'pending' });
    const result = controller.getState().pending.items[0];
    assert.equal(result.status, 'pending');
    const html = ports.renderToStaticMarkup(ports.createElement(ports.MemoryEventDetails, { event: result.event }));
    if (proposed == null) {
      assert.equal(result.event, null);
      assert.match(html, /事件阶段：未知（未核验）/);
      assert.match(html, /事件发生时段：未知（未核验）/);
      assert.doesNotMatch(html, /2026年10月1日|2026年10月14日/);
    } else if (proposed.stage === 'planned') {
      assert.match(html, /事件阶段：计划（来源已核验）/);
      assert.match(html, /16:00:00（UTC\+8）.*（未核验）/);
    } else if (proposed.stage === 'occurred') {
      assert.match(html, /事件阶段：已发生（未核验）/);
      assert.match(html, /结束时间未知（来源已核验）/);
    } else {
      assert.match(html, /阶段依据：未知/);
      assert.match(html, /发生时段依据：未知/);
    }
  }
});

test('事件契约或范围不可核对时不展示条目，也不能从旧history执行动作', async () => {
  const invalidEvents = [{ ...event, version: 2 }, { ...event, stage: 'completed' },
    { ...event, stage: 'unknown' }, { ...event, stage_evidence: [] },
    { ...event, occurrence_start: null }, { ...event, occurrence_end: '2026-10-19T14:00:00+08:00' },
    { ...event, occurrence_start: '2026-10-20T14:00:00' },
    { ...event, stage_evidence: [{ message_id: ids.message, char_start: 0, char_end: 1.2 }] },
    { ...event, occurrence_evidence: [] }];
  for (const proposed of invalidEvents) {
    const { controller, selection } = await controllerFixture(async () => ({ generation: 1,
      data: { candidates: [candidateDto('contact', { event: proposed })] } }));
    await controller.refresh({ ...selection(), section: 'pending' });
    assert.deepEqual(controller.getState().pending, { phase: 'error', items: [] });
    await assert.rejects(controller.applyCandidateUpdate({ ...selection(), candidateId: ids.candidate,
      previousMemoryId: ids.previous, expectedRevision: 2 }));
  }
  for (const overrides of [{ contact_id: ids.other }, { level: 'owner' }, { memory_id: ids.previous }, { revision: 4 }]) {
    const current = memoryDto('contact', { memory_id: ids.current, revision: 3 });
    const { controller, selection } = await controllerFixture(async (request) => ({ generation: 1,
      data: request.path.endsWith('/versions') ? { versions: [{ ...current, ...overrides }] } : { memories: [current] } }));
    await controller.refresh({ ...selection(), section: 'contact' });
    await controller.openVersions({ ...selection(), level: 'contact', memoryId: ids.current, revision: 3 });
    assert.equal(controller.getState().history.phase, 'error');
    assert.deepEqual(controller.getState().history.items, []);
  }
});

test('切换联系人、断连、刷新和来源删除都拒绝迟到历史与旧范围操作', async () => {
  for (const invalidation of ['contact', 'connection', 'refresh', 'source']) {
    const current = memoryDto('contact', { memory_id: ids.current, revision: 3,
      adoption_method: 'auto', supersedes_memory_id: ids.previous, can_revert_auto_update: true });
    let releaseLate, lateSignal, sourceDeleted = false;
    const fixture = await controllerFixture(async (request) => {
      if (request.path.endsWith('/versions')) {
        lateSignal = request.signal;
        return new Promise((resolve) => { releaseLate = () => resolve({ generation: 1,
          data: { versions: [current, memoryDto('contact', { status: 'invalidated', adoption_method: 'auto' })] } }); });
      }
      return { generation: 1, data: request.path.endsWith('/memory-candidates') ? { candidates: [] }
        : request.path.endsWith('/sources') ? { sources: [] }
          : { memories: sourceDeleted || request.path.includes('/owner') ? [] : [current] } };
    });
    const { controller, contacts, selection, disconnect } = fixture;
    await controller.refresh({ ...selection(), section: 'contact' });
    const previousSelection = selection();
    const late = controller.openVersions({ ...previousSelection, level: 'contact', memoryId: ids.current, revision: 3 });
    if (invalidation === 'contact') {
      contacts.selectContact({ contactId: ids.other, scopeRevision: contacts.getState().scopeRevision });
      controller.synchronizeScope();
    } else if (invalidation === 'connection') { disconnect(); controller.synchronizeScope(); }
    else if (invalidation === 'source') { sourceDeleted = true; await controller.revalidateDeletedSource(ids.contact); }
    else await controller.refresh({ ...selection(), section: 'contact' });
    releaseLate(); await late;
    assert.equal(lateSignal.aborted, true);
    assert.equal(controller.getState().history.phase, 'idle');
    assert.deepEqual(controller.getState().history.items, []);
    await assert.rejects(controller.revertAutoUpdate({ ...previousSelection, level: 'contact', memoryId: ids.current, revision: 3 }));
    if (invalidation !== 'refresh') assert.deepEqual(controller.getState().contact.items, []);
  }
});

test('版本历史只展示原叶版本沿替代引用的变化链，混入其他条目时要求重新核对', async () => {
  for (const older of [memoryDto('contact', { memory_id: ids.message, status: 'invalidated' }),
    memoryDto('contact', { status: 'active' })]) {
    const current = memoryDto('contact', { memory_id: ids.current, revision: 3, supersedes_memory_id: ids.previous });
    const { controller, selection } = await controllerFixture(async (request) => ({ generation: 1,
      data: request.path.endsWith('/versions') ? { versions: [current, older] } : { memories: [current] } }));
    await controller.refresh({ ...selection(), section: 'contact' });
    await controller.openVersions({ ...selection(), level: 'contact', memoryId: ids.current, revision: 3 });
    assert.equal(controller.getState().history.phase, 'error');
    assert.deepEqual(controller.getState().history.items, []);
  }
});

test('显式应用期间拒绝重复动作和迟到候选，同范围来源事件保留提交复验门', async () => {
  for (const level of ['contact', 'owner']) for (const removed of [false, true]) {
    const previous = memoryDto(level);
    const candidate = candidateDto(level === 'owner' ? 'self' : 'contact');
    let finishWrite, releaseLate, lateSignal, postedSignal, committed = false, posts = 0, reads = 0;
    const { controller, selection } = await controllerFixture(async (request) => {
      if (request.method === 'POST') {
        posts++; postedSignal = request.signal;
        return new Promise((resolve, reject) => { finishWrite = () => {
          committed = true;
          if (removed) reject(new Error('合成来源删除409'));
          else resolve({ generation: 1, data: {} });
        }; });
      }
      if (request.path.endsWith('/versions')) {
        lateSignal = request.signal;
        return new Promise((resolve) => { releaseLate = () => resolve({ generation: 1, data: { versions: [previous] } }); });
      }
      if (request.path.endsWith('/memory-candidates')) {
        reads++;
        return { generation: 1, data: { candidates: committed ? [] : [candidate] } };
      }
      if (request.path.endsWith('/sources')) return { generation: 1, data: { sources: [] } };
      const requestedLevel = request.path.includes('/owner') ? 'owner' : 'contact';
      return { generation: 1, data: { memories: requestedLevel !== level || committed && removed ? []
        : [committed ? memoryDto(level, { memory_id: ids.current, revision: 3,
          text: candidate.text, supersedes_memory_id: ids.previous }) : previous] } };
    });
    await controller.refresh({ ...selection(), section: level });
    await controller.refresh({ ...selection(), section: 'pending' });
    const late = controller.openVersions({ ...selection(), level, memoryId: ids.previous, revision: 2 });
    const action = () => controller.applyCandidateUpdate({ ...selection(), candidateId: ids.candidate,
      previousMemoryId: ids.previous, expectedRevision: 2 });
    const writing = action();
    assert.equal(lateSignal.aborted, true);
    await assert.rejects(action());
    await controller.refresh({ ...selection(), section: 'pending' });
    assert.equal(reads, 1, '提交未决期间不能重新读取旧候选');
    await controller.revalidateDeletedSource(ids.other);
    assert.equal(postedSignal.aborted, false, '来源事件不能靠客户端取消冒充服务端提交复验');
    assert.deepEqual(controller.getState().pending.items, []);
    finishWrite(); await writing;
    releaseLate(); await late;
    assert.deepEqual(controller.getState().pending.items, []);
    assert.equal(controller.getState().history.phase, 'idle');
    assert.equal(controller.getState().mutation.phase, removed ? 'error' : 'success');
    if (removed) assert.deepEqual(controller.getState()[level].items, []);
    else {
      assert.equal(controller.getState()[level].items[0].text, '已参加完这次读书会。');
      assert.equal(controller.getState()[level].items[0].adoptionMethod, 'manual');
    }
    await assert.rejects(action());
    assert.equal(posts, 1);
  }
});

test('生产预载与具名桥接仅接受完整当前范围，版本写入保持独立管理操作', async () => {
  const handlers = new Map(), publications = [];
  let posted;
  const { backend, contacts, selection } = await controllerFixture(async (request) => {
    if (request.method === 'POST') { posted = request; return { generation: 1, data: {} }; }
    return { generation: 1, data: request.path.endsWith('/memory-candidates') ? { candidates: [candidateDto()] }
      : request.path.endsWith('/versions') ? { versions: [memoryDto()] } : { memories: [memoryDto()] } };
  });
  ports.installMemoryBridge({ handle: (channel, handler, role) => handlers.set(channel, { handler, role }),
    publish: (channel, state, role) => publications.push({ channel, role }) }, backend, contacts);
  const bridge = ports.createMemoryBridge({ invoke: async (channel, ...args) => handlers.get(channel).handler(...args),
    on: () => {}, removeListener: () => {} });
  await bridge.refresh({ ...selection(), section: 'contact' });
  await bridge.refresh({ ...selection(), section: 'pending' });
  for (const request of [
    { ...selection(), candidateId: ids.candidate, previousMemoryId: ids.previous, expectedRevision: 0 },
    { ...selection(), candidateId: ids.candidate, previousMemoryId: ids.previous, expectedRevision: 2, targetContactId: ids.other },
    { ...selection(), candidateId: ids.candidate, previousMemoryId: '未知资料', expectedRevision: 2 },
    { ...selection(), candidateId: ids.candidate, previousMemoryId: ids.previous, expectedRevision: 2, correction_decision_ids: [] },
  ]) await assert.rejects(bridge.applyCandidateUpdate(request));
  await assert.rejects(bridge.openVersions({ ...selection(), level: 'contact', memoryId: ids.previous, revision: 2 }, '多余参数'));
  assert.equal(posted, undefined);
  await bridge.applyCandidateUpdate({ ...selection(), candidateId: ids.candidate, previousMemoryId: ids.previous, expectedRevision: 2 });
  assert.deepEqual(posted.body, { previous_memory_id: ids.previous, expected_revision: 2, correction_decision_ids: [] });
  for (const name of ['memory:get-state', 'memory:refresh', 'memory:apply-candidate-update', 'memory:open-versions', 'memory:revert-auto-update']) {
    assert.equal(handlers.get(name).role, 'manager');
  }
  assert.ok(publications.every((entry) => entry.role === 'manager'));
});

test('旧行历史返回404或409后撤下失效正文和更新选择，保留其他手动资料且不发写入', async () => {
  for (const level of ['contact', 'owner']) for (const status of [404, 409]) {
    const unrelatedLevel = level === 'contact' ? 'owner' : 'contact';
    const previous = memoryDto(level);
    const untouched = memoryDto(level, { memory_id: ids.current, revision: 5, source_ids: [ids.current],
      text: '另一条未受影响的手动资料。' });
    const unrelated = memoryDto(unrelatedLevel, { memory_id: ids.message, source_ids: [ids.message],
      text: '另一范围的合法手动资料。' });
    const posted = [];
    const { controller, selection } = await controllerFixture(async (request) => {
      if (request.method === 'POST') { posted.push(request); return { generation: 1, data: {} }; }
      if (request.path.endsWith('/versions')) throw new ports.BackendRequestFailure('response', status,
        status === 404 ? 'not_found' : 'memory_version_changed');
      const requestedLevel = request.path.includes('/owner') ? 'owner' : 'contact';
      return { generation: 1, data: request.path.endsWith('/memory-candidates')
        ? { candidates: [candidateDto(level === 'owner' ? 'self' : 'contact')] }
        : { memories: requestedLevel === level ? [previous, untouched] : [unrelated] } };
    });
    await controller.refresh({ ...selection(), section: level });
    await controller.refresh({ ...selection(), section: unrelatedLevel });
    await controller.refresh({ ...selection(), section: 'pending' });
    const stale = { ...selection(), level, memoryId: ids.previous, revision: 2 };
    await controller.openVersions(stale);
    const state = controller.getState();
    const html = ports.renderToStaticMarkup(ports.createElement(ports.PendingMemoryUpdate, {
      candidate: state.pending.items[0], memories: state[level], apply: async () => {},
    }));
    assert.doesNotMatch(html, /计划参加这次读书会。/);
    assert.match(html, /另一条未受影响的手动资料。/);
    assert.deepEqual(state[level].items.map((entry) => entry.memoryId), [ids.current]);
    assert.equal(state[level].phase, 'ready', '未受影响的卡片和编辑不因历史失败整体卸载');
    assert.equal(state[unrelatedLevel].items[0].text, '另一范围的合法手动资料。');
    assert.equal(state.history.phase, 'error');
    await assert.rejects(controller.openVersions(stale));
    await assert.rejects(controller.correct({ ...stale, text: '过期操作', category: 'relationship_note' }));
    await assert.rejects(controller.remove(stale));
    await assert.rejects(controller.applyCandidateUpdate({ ...selection(), candidateId: ids.candidate,
      previousMemoryId: ids.previous, expectedRevision: 2 }));
    assert.deepEqual(posted, []);
  }
});

test('历史确认失效会停止未决候选读取，迟到正文不能回填，显式刷新后才重新显示', async () => {
  for (const level of ['contact', 'owner']) for (const status of [404, 409]) {
    const untouched = memoryDto(level, { memory_id: ids.current, revision: 5, source_ids: [ids.current],
      text: '未受影响的手动资料。' });
    const lateCandidate = candidateDto(level === 'owner' ? 'self' : 'contact', { text: '旧来源的迟到候选正文。' });
    let releaseLate, lateSignal, pendingReads = 0;
    const { controller, selection } = await controllerFixture(async (request) => {
      if (request.path.endsWith('/versions')) throw new ports.BackendRequestFailure('response', status,
        status === 404 ? 'not_found' : 'memory_version_changed');
      if (request.path.endsWith('/memory-candidates')) {
        pendingReads++;
        if (pendingReads === 1) {
          lateSignal = request.signal;
          return new Promise((resolve) => { releaseLate = () => resolve({ generation: 1, data: { candidates: [lateCandidate] } }); });
        }
        return { generation: 1, data: { candidates: [candidateDto(level === 'owner' ? 'self' : 'contact', {
          text: '刷新后核对的新候选。', source_ids: [ids.current],
        })] } };
      }
      return { generation: 1, data: { memories: [memoryDto(level), untouched] } };
    });
    await controller.refresh({ ...selection(), section: level });
    const late = controller.refresh({ ...selection(), section: 'pending' });
    await controller.openVersions({ ...selection(), level, memoryId: ids.previous, revision: 2 });
    releaseLate(); await late;
    const state = controller.getState();
    const html = state.pending.items.map((candidate) => ports.renderToStaticMarkup(ports.createElement(ports.PendingMemoryUpdate, {
      candidate, memories: state[level], apply: async () => {},
    }))).join('');
    assert.doesNotMatch(html, /旧来源的迟到候选正文。/);
    assert.equal(lateSignal.aborted, true);
    assert.deepEqual(state.pending, { phase: 'error', items: [] });
    assert.equal(state[level].items[0].text, '未受影响的手动资料。');
    await controller.refresh({ ...selection(), section: 'pending' });
    assert.equal(controller.getState().pending.phase, 'ready');
    assert.equal(controller.getState().pending.items[0].text, '刷新后核对的新候选。');
  }
});

test('历史的连接或格式异常不当作资料删除，明确叶版本不匹配才撤下旧行', async () => {
  for (const level of ['contact', 'owner']) for (const outcome of ['connection', 'server', 'malformed', 'changed']) {
    const { controller, selection } = await controllerFixture(async (request) => {
      if (request.path.endsWith('/versions')) {
        if (outcome === 'connection') throw new ports.BackendRequestFailure('connection');
        if (outcome === 'server') throw new ports.BackendRequestFailure('response', 503);
        return { generation: 1, data: outcome === 'malformed' ? { versions: '无效形状' }
          : { versions: [memoryDto(level, { status: 'invalidated' })] } };
      }
      return { generation: 1, data: { memories: [memoryDto(level)] } };
    });
    await controller.refresh({ ...selection(), section: level });
    await controller.openVersions({ ...selection(), level, memoryId: ids.previous, revision: 2 });
    assert.equal(controller.getState().history.phase, 'error');
    assert.equal(controller.getState()[level].items.length, outcome === 'changed' ? 0 : 1);
    assert.equal(controller.getState()[level].phase, 'ready');
  }
});

test('人工修正优先于旧历史的迟到404或409，不撤下新的人工叶版本', async () => {
  for (const level of ['contact', 'owner']) for (const status of [404, 409]) {
    let releaseHistory, historySignal, corrected = false;
    const { controller, selection } = await controllerFixture(async (request) => {
      if (request.path.endsWith('/versions')) {
        historySignal = request.signal;
        return new Promise((_resolve, reject) => { releaseHistory = () => reject(new ports.BackendRequestFailure('response', status,
          status === 404 ? 'not_found' : 'memory_version_changed')); });
      }
      if (request.method === 'POST') { corrected = true; return { generation: 1, data: {} }; }
      return { generation: 1, data: request.path.endsWith('/memory-candidates') ? { candidates: [] }
        : { memories: [corrected ? memoryDto(level, { memory_id: ids.current, revision: 3,
          text: '用户新的人工修正。', supersedes_memory_id: ids.previous }) : memoryDto(level)] } };
    });
    await controller.refresh({ ...selection(), section: level });
    const late = controller.openVersions({ ...selection(), level, memoryId: ids.previous, revision: 2 });
    await controller.correct({ ...selection(), level, memoryId: ids.previous, revision: 2,
      text: '用户新的人工修正。', category: 'relationship_note' });
    releaseHistory(); await late;
    assert.equal(historySignal.aborted, true);
    const state = controller.getState();
    assert.equal(state[level].items[0].text, '用户新的人工修正。');
    assert.equal(state[level].items[0].adoptionMethod, 'manual');
    assert.equal(state.history.phase, 'idle');
    assert.equal(state.mutation.phase, 'success');
  }
});


test('事件详情沿来源时区显示跨日时段，不硬编码为本机或东八区日期', async () => {
  const { controller, selection } = await controllerFixture(async () => ({ generation: 1,
    data: { memories: [memoryDto('contact', { event: { ...event,
      occurrence_start: '2026-10-20T23:30:00-07:00', occurrence_end: '2026-10-21T00:30:00-07:00' } })] } }));
  await controller.refresh({ ...selection(), section: 'contact' });
  const html = ports.renderToStaticMarkup(ports.createElement(ports.MemoryEventDetails, { event: controller.getState().contact.items[0].event }));
  assert.match(html, /2026年10月20日 23:30:00（UTC-7）/);
  assert.match(html, /2026年10月21日 00:30:00（UTC-7）/);
});

test('失效记忆只沿同范围唯一替代链定位删除目标，孤立或歧义条目不猜目标', () => {
  const old = { memoryId: ids.previous, level: 'contact', status: 'invalidated', supersedesMemoryId: null };
  const current = { memoryId: ids.current, level: 'contact', status: 'active', supersedesMemoryId: ids.previous };
  assert.equal(ports.memoryRemovalTarget(old, [old, current]), current);
  assert.equal(ports.memoryRemovalTarget(old, [old]), old);
  assert.equal(ports.memoryRemovalTarget(old, [old, current, { ...current, memoryId: ids.other }]), old);
  assert.equal(ports.memoryRemovalTarget(old, [old, { ...current, level: 'owner' }]), old);
});
