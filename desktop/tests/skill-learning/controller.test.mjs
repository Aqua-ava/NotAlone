import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';

test('明确开关携带当前修订和幂等身份，轮询不取消正在提交的授权', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-learning-consent-'));
  try {
    const output = path.join(owned, 'controller.mjs');
    await build({ entryPoints: ['src/main/skill-learning/controller.ts'], outfile: output,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { SkillLearningController } = await import(pathToFileURL(output).href);
    const contactId = randomUUID(), calls = [];
    let release;
    const contacts = { onStateChanged: () => () => {}, getState: () => ({ selectedContactId: contactId,
      scopeRevision: 1, directoryPhase: 'ready', contacts: [{ contactId }] }) };
    const directory = { enabled: false, scope_revision: 2, drafts: [], task: null, recent_outcomes: [] };
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {}, requestJson: async (request) => {
      calls.push(request);
      return request.method === 'POST' ? new Promise((resolve) => { release = resolve; })
        : { generation: 1, data: directory };
    } };
    const controller = new SkillLearningController(backend, contacts), scope = { contactId, scopeRevision: 1 };
    await controller.refresh(scope);
    const saving = controller.configure({ ...scope, enabled: true, confirmed: true });
    assert.equal(calls[1].body.expected_revision, 2);
    assert.match(calls[1].body.operation_key, /^[0-9a-f-]{36}$/);
    await controller.refresh(scope);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].signal.aborted, false);
    release({ generation: 1, data: { ...directory, enabled: true, scope_revision: 3 } });
    await saving;
    assert.equal(controller.getState().enabled, true);
    assert.equal(controller.getState().settingRevision, 3);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('待审核目录拒绝缺失私人来源列表及跨联系人范围建议，不能发布到React状态', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-learning-contract-'));
  try {
    const output = path.join(owned, 'controller.mjs');
    await build({ entryPoints: ['src/main/skill-learning/controller.ts'], outfile: output,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { SkillLearningController } = await import(pathToFileURL(output).href);
    const contactId = randomUUID(), logicalId = randomUUID();
    const valid = { enabled: true, scope_revision: 0, task: null, recent_outcomes: ['draft'], drafts: [{
      draft_id: randomUUID(), revision: 1, status: 'pending', logical_skill_id: logicalId, proposal_kind: 'create',
      sanitized_strategy: { name: 'confirm-meaning', description: '合成方法说明', scene: '合成场景', document: '合成清洗策略。',
        scope_suggestion: { kind: 'contact', reason: '仅此联系人经验。', contact_id: contactId },
        methods: [{ method_id: randomUUID(), logical_skill_id: logicalId, key: 'ask-first', title: '先询问意愿',
          instruction: '询问后组织措辞。', replaces_method_ids: [], mapping_status: 'new' }] },
      private_evidence: { materials: [{ material_id: randomUUID(), session_id: randomUUID(), kind: 'assistant_discussion',
        priority: 'correction', content: { correction: '合成纠正' }, external_messages: [] }], existing_skills: [], source_dependencies: [] },
      target_versions: [],
    }] };
    const contacts = { onStateChanged: () => () => {}, getState: () => ({ selectedContactId: contactId,
      scopeRevision: 1, directoryPhase: 'ready', contacts: [{ contactId }] }) };
    let payload = valid;
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
      requestJson: async () => ({ generation: 1, data: structuredClone(payload) }) };
    const controller = new SkillLearningController(backend, contacts);
    const scope = { contactId, scopeRevision: 1 };
    await controller.refresh(scope);
    assert.equal(controller.getState().phase, 'ready');
    const originalRequest=backend.requestJson;
    let release;
    backend.requestJson=()=>new Promise(resolve=>{release=resolve;});
    const priorDrafts=controller.getState().drafts;
    const polling=controller.poll(scope);
    assert.equal(controller.getState().phase,'ready','后台核验保留已就绪状态，不让开关周期性变灰');
    assert.deepEqual(controller.getState().drafts,priorDrafts,'同修订轮询不能卸载已展开的私人依据卡片');
    release({generation:1,data:structuredClone(valid)});
    await polling;
    backend.requestJson=originalRequest;
    for (const mutate of [
      (item) => { delete item.private_evidence.materials[0].external_messages; },
      (item) => { item.sanitized_strategy.scope_suggestion.contact_id = randomUUID(); },
      (item) => { delete item.target_versions; },
      (item) => { item.sanitized_strategy.methods[0].logical_skill_id = randomUUID(); },
    ]) {
      payload = structuredClone(valid); mutate(payload.drafts[0]);
      await controller.refresh(scope);
      assert.equal(controller.getState().phase, 'failed');
      assert.deepEqual(controller.getState().drafts, []);
    }
    payload=structuredClone(valid);
    await controller.refresh(scope);
    controller.invalidate();
    assert.deepEqual(controller.getState().drafts,[],'来源删除仍必须同步撤下私人依据');
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('待审核控制器在联系人变化后丢弃迟到旧列表并清空私人依据', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-learning-controller-'));
  try {
    const output = path.join(owned, 'controller.mjs');
    await build({ entryPoints: ['src/main/skill-learning/controller.ts'], outfile: output,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { SkillLearningController } = await import(pathToFileURL(output).href);
    const contactId = '11111111-1111-4111-8111-111111111111';
    let contactState = { selectedContactId: contactId, scopeRevision: 1, directoryPhase: 'ready', contacts: [{ contactId }] };
    let changed;
    let release;
    const contacts = { getState: () => contactState, onStateChanged: (listener) => { changed = listener; return () => {}; } };
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
      requestJson: () => new Promise((resolve) => { release = resolve; }) };
    const controller = new SkillLearningController(backend, contacts);
    const loading = controller.refresh({ contactId, scopeRevision: 1 });
    contactState = { ...contactState, selectedContactId: null, scopeRevision: 2 };
    changed();
    release({ generation: 1, data: { enabled: true, scope_revision: 0, drafts: [], task: null, recent_outcomes: ['reuse'] } });
    await loading;
    assert.deepEqual(controller.getState().drafts, []);
    assert.equal(controller.getState().contactId, null);
    assert.equal(controller.getState().enabled, false);
    assert.equal(controller.getState().phase, 'idle');
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('待审核桥接只接受当前联系人操作，不提供模型发布或任意路径入口', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-learning-bridge-'));
  try {
    const output = path.join(owned, 'bridge.mjs');
    await build({ entryPoints: ['src/main/skill-learning/bridge.ts'], outfile: output,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { installSkillLearningBridge } = await import(pathToFileURL(output).href);
    const handlers = new Map();
    const contactId = '11111111-1111-4111-8111-111111111111';
    const contacts = { onStateChanged: () => () => {}, getState: () => ({ selectedContactId: contactId,
      scopeRevision: 1, directoryPhase: 'ready', contacts: [{ contactId }] }) };
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {} };
    installSkillLearningBridge({ handle: (channel, handler, role) => { assert.equal(role, 'manager'); handlers.set(channel, handler); }, publish: () => {} }, backend, contacts);
    assert.deepEqual([...handlers.keys()], ['skill-learning:get-state', 'skill-learning:refresh', 'skill-learning:poll', 'skill-learning:configure', 'skill-learning:resume',
      'skill-learning:open-review', 'skill-learning:update-review', 'skill-learning:save-review', 'skill-learning:compare-review',
      'skill-learning:approve-review', 'skill-learning:decide-review', 'skill-learning:retry-review', 'skill-learning:close-review',
      'skill-learning:open-history', 'skill-learning:close-history', 'skill-learning:rollback-history', 'skill-learning:retry-history',
      'skill-learning:open-policies', 'skill-learning:close-policies', 'skill-learning:change-policy', 'skill-learning:undo-policy', 'skill-learning:retry-policy']);
    assert.throws(() => handlers.get('skill-learning:configure')({ contactId, scopeRevision: 1, enabled: true, confirmed: true, owner_id: contactId }));
    assert.throws(() => handlers.get('skill-learning:refresh')({ contactId, scopeRevision: 1, path: '/api/skills/publish' }));
    assert.throws(() => handlers.get('skill-learning:poll')({ contactId, scopeRevision: 1, path: '/api/skills/publish' }));
  } finally { await rm(owned, { recursive: true, force: true }); }
});

async function deletionFixture() {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-learning-deletion-'));
  const entry = path.join(owned, 'entry.ts');
  await writeFile(entry, [
    `export { SkillLearningController } from ${JSON.stringify(path.resolve('src/main/skill-learning/controller.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('src/main/skill-learning/deletion.ts'))};`,
    `export { ExpressionPreferenceController } from ${JSON.stringify(path.resolve('src/main/expression-preferences/controller.ts'))};`,
    `export { MemoryReadingController } from ${JSON.stringify(path.resolve('src/main/memory/controller.ts'))};`,
    `export { ReplySession } from ${JSON.stringify(path.resolve('src/main/reply/session.ts'))};`,
    `export { SourceDeletionController } from ${JSON.stringify(path.resolve('src/main/sources/controller.ts'))};`,
    `export { ContactSession } from ${JSON.stringify(path.resolve('src/main/contacts/session.ts'))};`,
    `export { BackendRequestFailure } from ${JSON.stringify(path.resolve('src/main/backend/json-client.ts'))};`,
  ].join('\n'));
  const output = path.join(owned, 'deletion.mjs');
  await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const ports = await import(pathToFileURL(output).href);
  const contactId = randomUUID(), otherContactId = randomUUID(), preferenceId = randomUUID(), logicalId = randomUUID();
  const memoryId = randomUUID(), sourceId = randomUUID(), sessionId = randomUUID(), taskId = randomUUID();
  const draftId = randomUUID();
  const comparisonId = randomUUID();
  const backendListeners = new Set();
  const kinds = ['preference', 'memory', 'session', 'source'];
  const deletions = Object.fromEntries(kinds.map(kind => [kind, Promise.withResolvers()]));
  const records = { generation: 1, calls: [], deleted: new Set(), failure: null, failAfterCommit: false,
    verificationBarrier: null, verificationEntered: null, learningBarrier: null,
    sourceAcknowledgments: 0, phases: Object.fromEntries(kinds.map(kind => [kind, []])) };
  const directory = (id) => ({ enabled: true, scope_revision: 1, task: null, recent_outcomes: [], drafts: records.deleted.size ? [] : [{
    draft_id: draftId, revision: 1, status: 'pending', logical_skill_id: logicalId, proposal_kind: 'create',
    sanitized_strategy: { name: 'confirm-meaning', description: '合成待审核方法', scene: '合成场景', document: '合成清洗策略。',
      scope_suggestion: { kind: 'contact', reason: '仅当前联系人。', contact_id: id },
      methods: [{ method_id: randomUUID(), logical_skill_id: logicalId, key: 'ask-first', title: '先问意愿',
        instruction: '询问后组织措辞。', replaces_method_ids: [], mapping_status: 'new' }] },
    private_evidence: { materials: [], existing_skills: [], source_dependencies: [] }, target_versions: [],
    comparison: { comparison_id: comparisonId, draft_revision: 1, input_version: randomUUID(),
      input: { incoming_text: '合成待删对照来话', intent: '核对安排', scene: '核对安排' },
      scope: { kind: 'contact', contact_id: id, scene: null }, valid: true,
      before: { name: null, version_id: null, load_state: 'not_used', candidates: [{ text: '合成旧结果', basis: '同一输入', risk_notes: [] }] },
      after: { name: 'confirm-meaning', version_id: comparisonId, load_state: 'loaded', candidates: [{ text: '合成待删新结果', basis: '合成私人来源', risk_notes: [] }] } },
  }] });
  const preference = { preference_id: preferenceId, text: '合成待删除偏好。', revision: 1,
    scope: { contact_id: null, reply_mode: null }, confirmed_operation_key: randomUUID(), origin: { kind: 'manual' },
    source_ids: [], confirmed_at: '2026-10-15T01:00:00Z', updated_at: '2026-10-15T01:00:00Z' };
  const backend = { getConnectionGeneration: () => records.generation,
    subscribeMessages: (observer) => observer.connected(), onStateChanged: (listener) => {
    backendListeners.add(listener); return () => backendListeners.delete(listener);
  }, requestJson: async (request) => {
    records.calls.push(request);
    const generation = records.generation;
    if (request.path.endsWith('/skill-learning')) {
      const data = structuredClone(directory(request.path.split('/')[3]));
      const barrier = records.learningBarrier;
      records.learningBarrier = null;
      if (barrier) await barrier.promise;
      return { generation, data };
    }
    if (request.path.includes('/skill-learning/drafts/')) {
      const draft = directory(request.path.split('/')[3]).drafts[0];
      if (!draft) throw new ports.BackendRequestFailure('response', 404, 'not_found');
      return { generation, data: { draft } };
    }
    const deleting = request.method === 'DELETE' || request.method === 'POST' && request.path.endsWith('/delete');
    if (deleting) {
      const kind = request.path.includes('/expression-preferences/') ? 'preference'
        : request.path.includes('/memories/') ? 'memory'
          : request.path.includes('/assistant-sessions/') ? 'session' : 'source';
      await deletions[kind].promise;
      if (records.failure === kind) {
        if (records.failAfterCommit) records.deleted.add(kind);
        throw new ports.BackendRequestFailure('response', 503, 'controlled_delete_failure');
      }
      records.deleted.add(kind);
      return { generation, data: kind === 'session' ? { session_id: sessionId, state: 'deleted' }
        : kind === 'source' ? { task_id: taskId, status: 'succeeded' } : { state: 'deleted' } };
    }
    if (request.path.endsWith('/assistant-session/default')) return { generation, data: { session_id: sessionId } };
    if (request.path.includes('/assistant-sessions/')) {
      if (records.verificationBarrier) {
        records.verificationEntered?.resolve();
        await records.verificationBarrier.promise;
      }
      if (records.deleted.has('session')) throw new ports.BackendRequestFailure('response', 404, 'not_found');
      return { generation, data: { session_id: sessionId, current_input_version_id: null, turns: [], inputs: [] } };
    }
    if (request.path.endsWith('/memories')) return { generation, data: { memories: records.deleted.has('memory') ? [] : [{
      level: 'contact', contact_id: request.path.split('/')[3], status: 'active', memory_id: memoryId, revision: 1,
      text: '合成待删除资料。', category: 'common_fact', topic: 'other', source_ids: [sourceId], confidence: 1,
      risk_flags: [], adoption_method: 'manual', valid_at: null, invalid_at: null,
      timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false },
      supersedes_memory_id: null, source_candidate_id: null,
    }] } };
    if (request.path.endsWith('/memory-candidates')) return { generation, data: { candidates: [] } };
    if (request.path.endsWith('/sources')) return { generation, data: { sources: [{ source_id: sourceId,
      file_name: null, record_count: 1, status: records.deleted.has('source') ? 'deleted' : 'active',
      task_id: records.deleted.has('source') ? taskId : null }] } };
    if (request.path.startsWith('/api/tasks/status')) return { generation, data: { task_id: taskId,
      task_type: 'delete', status: 'succeeded', step: 'verify_not_retrievable',
      steps: ['mark_deleted', 'delete_derived', 'delete_index', 'clear_cache', 'verify_not_retrievable']
        .map(name => ({ name, status: 'succeeded' })) } };
    return { generation, data: { preferences: records.deleted.has('preference') ? [] : [preference] } };
  } };
  const contacts = new ports.ContactSession(async () => ({ generation: records.generation,
    contacts: [contactId, otherContactId].map(id => ({ contactId: id, displayName: '合成删除联系人', messageCount: 0, sourceCount: 1 })) }));
  contacts.setConnection(records.generation); await contacts.refreshContacts();
  const learning = new ports.SkillLearningController(backend, contacts);
  const memory = new ports.MemoryReadingController(backend, contacts);
  const replies = new ports.ReplySession(contacts, backend);
  memory.onRecordDeletion(phase => records.phases.memory.push(phase));
  replies.onSessionDeletion(phase => records.phases.session.push(phase));
  const coordinator = ports.coordinateSkillLearningDeletion(learning, memory, replies,
    { started: () => records.phases.preference.push('started'), settled: async () => records.phases.preference.push('settled') });
  const preferences = new ports.ExpressionPreferenceController(backend, contacts, coordinator);
  const sources = new ports.SourceDeletionController(backend, contacts, async () => {
    records.sourceAcknowledgments += 1;
    learning.invalidate();
  });
  sources.onDeletion(phase => records.phases.source.push(phase));
  ports.coordinateSkillLearningSourceDeletion(learning, sources);
  const scope = () => ({ contactId: contacts.getState().selectedContactId, scopeRevision: contacts.getState().scopeRevision });
  const select = id => contacts.selectContact({ contactId: id, scopeRevision: contacts.getState().scopeRevision });
  select(contactId);
  await memory.refresh({ ...scope(), section: 'contact' });
  await sources.refresh(scope());
  await replies.readSavedSession(scope());
  await preferences.refresh(scope());
  await learning.refresh(scope());
  const remove = kind => kind === 'preference' ? preferences.remove({ ...scope(), preferenceId, expectedRevision: 1 })
    : kind === 'memory' ? memory.remove({ ...scope(), memoryId, level: 'contact', revision: 1 })
      : kind === 'session' ? replies.deleteSavedSession({ ...scope(), sessionId, confirmed: true })
        : sources.delete({ ...scope(), sourceId });
  const reconnect = async () => {
    records.generation += 1;
    for (const listener of backendListeners) listener();
    contacts.setConnection(records.generation);
    await contacts.refreshContacts(); select(otherContactId);
  };
  return { owned, records, contacts, backend, deletions, learning, preferences, memory, replies, sources, ports, scope,
    select, reconnect, otherContactId, remove, sessionId };
}

for (const [kind, label] of [['preference', '偏好'], ['memory', '记忆'], ['session', '助手会话'], ['source', '来源']]) {
test(`真实${label}删除未结算时迟到GET、轮询、范围切换和重连不能恢复私人草稿`, async () => {
  const f = await deletionFixture();
  const late = f.records.learningBarrier = Promise.withResolvers();
  const reading = f.learning.refresh(f.scope());
  const removing = f.remove(kind);
  try {
    late.resolve(); await reading;
    assert.deepEqual(f.learning.getState().drafts, [], '删除开始后不得发布在开始前捕获的旧草稿');
    const requests = f.records.calls.filter(call => call.path.endsWith('/skill-learning')).length;
    for (const change of ['原范围轮询', '切换范围', '重新连接']) {
      if (change === '切换范围') f.select(f.otherContactId);
      else if (change === '重新连接') await f.reconnect();
      await f.learning.refresh(f.scope());
      assert.deepEqual(f.learning.getState().drafts, [], `${change}不得在DELETE未结算期间恢复旧正文`);
    }
    assert.equal(f.records.calls.filter(call => call.path.endsWith('/skill-learning')).length, requests,
      '删除未结算期间不得重新读取旧草稿');
    f.deletions[kind].resolve();
    await removing;
    assert.deepEqual(f.records.phases[kind], ['started', 'settled']);
    await f.learning.refresh(f.scope());
    assert.equal(f.learning.getState().phase, 'ready');
    assert.deepEqual(f.learning.getState().drafts, []);
  } finally {
    late.resolve(); f.deletions[kind].resolve();
    await removing;
    await rm(f.owned, { recursive: true, force: true });
  }
});
}

for (const [kind, label] of [['preference', '偏好'], ['memory', '记忆'], ['session', '助手会话'], ['source', '来源']]) {
  test(`真实${label}删除失败结算后可以核对旧资料并精确重试，不能遗留私人草稿门禁`, async () => {
    const f = await deletionFixture();
    try {
      f.records.failure = kind;
      const removing = f.remove(kind).then(() => undefined, error => error);
      await f.learning.refresh(f.scope());
      assert.deepEqual(f.learning.getState().drafts, []);
      f.deletions[kind].resolve();
      const failure = await removing;
      assert.equal(failure instanceof Error, kind === 'preference', '偏好入口公开报告失败，其他入口通过状态报告');
      await f.learning.refresh(f.scope());
      assert.equal(f.learning.getState().phase, 'ready');
      assert.equal(f.learning.getState().drafts.length, 1, '公开核对仍存在的资料后允许再次审核');
      f.records.failure = null;
      if (kind === 'preference') await f.preferences.refresh(f.scope());
      await f.remove(kind);
      await f.learning.refresh(f.scope());
      assert.equal(f.learning.getState().phase, 'ready');
      assert.deepEqual(f.learning.getState().drafts, []);
      assert.deepEqual(f.records.phases[kind], ['started', 'settled', 'started', 'settled']);
    } finally {
      f.deletions[kind].resolve();
      await rm(f.owned, { recursive: true, force: true });
    }
  });
}

test('助手会话DELETE已提交但响应丢失时，门禁等待同SID的404复验并且重复状态不重复开启', async () => {
  const f = await deletionFixture();
  const verification = f.records.verificationBarrier = Promise.withResolvers();
  const entered = f.records.verificationEntered = Promise.withResolvers();
  f.records.failure = 'session'; f.records.failAfterCommit = true;
  const removing = f.remove('session');
  try {
    f.deletions.session.resolve();
    await entered.promise;
    const calls = f.records.calls.filter(call => call.path.endsWith('/skill-learning')).length;
    await f.learning.refresh(f.scope());
    assert.deepEqual(f.learning.getState().drafts, []);
    assert.equal(f.records.calls.filter(call => call.path.endsWith('/skill-learning')).length, calls,
      'DELETE响应未知不结束同SID存在性核对');
    assert.deepEqual(f.records.phases.session, ['started']);
    verification.resolve(); await removing;
    assert.equal(f.replies.getState().sessionDeletion, 'missing');
    assert.equal(f.replies.getState().confirmedSessionDeletion.sessionId, f.sessionId);
    const confirmedRevision = f.replies.getState().confirmedSessionDeletion.revision;
    for (const text of ['合成新草稿一。', '合成新草稿二。']) {
      f.contacts.setDraft({ ...f.scope(), text });
      assert.equal(f.replies.getState().confirmedSessionDeletion.revision, confirmedRevision);
    }
    assert.deepEqual(f.records.phases.session, ['started', 'settled']);
    await f.learning.refresh(f.scope());
    assert.equal(f.learning.getState().phase, 'ready');
    assert.deepEqual(f.learning.getState().drafts, []);
  } finally {
    verification.resolve(); f.deletions.session.resolve(); await removing;
    await rm(f.owned, { recursive: true, force: true });
  }
});

test('并行的真实删除逐次结算，来源凭据及原任务重复核验不提前解除或重新开启学习门禁', async () => {
  const f = await deletionFixture();
  f.records.failure = 'preference';
  const kinds = ['preference', 'memory', 'session', 'source'];
  const removing = Object.fromEntries(kinds.map(kind => [kind, f.remove(kind).then(() => undefined, error => error)]));
  try {
    const calls = f.records.calls.filter(call => call.path.endsWith('/skill-learning')).length;
    for (const kind of kinds.slice(0, -1)) {
      f.deletions[kind].resolve();
      const failure = await removing[kind];
      assert.equal(failure instanceof Error, kind === 'preference');
      await f.learning.refresh(f.scope());
      assert.deepEqual(f.learning.getState().drafts, []);
      assert.equal(f.records.calls.filter(call => call.path.endsWith('/skill-learning')).length, calls,
        '其他删除仍未结算时不能恢复学习读取');
    }
    f.deletions.source.resolve(); await removing.source;
    await f.sources.refresh(f.scope()); await f.sources.refresh(f.scope());
    assert(f.records.sourceAcknowledgments >= 2, '真实receipt及原任务完成均执行来源复验');
    for (const kind of kinds) assert.deepEqual(f.records.phases[kind], ['started', 'settled']);
    await f.learning.refresh(f.scope());
    assert.equal(f.learning.getState().phase, 'ready');
    assert.deepEqual(f.learning.getState().drafts, []);
  } finally {
    for (const kind of kinds) f.deletions[kind].resolve();
    await Promise.all(Object.values(removing));
    await rm(f.owned, { recursive: true, force: true });
  }
});
