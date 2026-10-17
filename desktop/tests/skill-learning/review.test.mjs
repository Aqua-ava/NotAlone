import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function reviewFixture() {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-review-controller-'));
  const entry = path.join(owned, 'entry.ts');
  await writeFile(entry, [
    `export { installSkillLearningBridge } from ${JSON.stringify(path.resolve('src/main/skill-learning/bridge.ts'))};`,
    `export { createSkillLearningBridge } from ${JSON.stringify(path.resolve('src/preload/skill-learning.ts'))};`,
    `export { ContactSession } from ${JSON.stringify(path.resolve('src/main/contacts/session.ts'))};`,
    `export { BackendRequestFailure } from ${JSON.stringify(path.resolve('src/main/backend/json-client.ts'))};`,
  ].join('\n'));
  const output = path.join(owned, 'review.mjs');
  await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const ports = await import(pathToFileURL(output).href);
  const contactId = randomUUID(), otherContactId = randomUUID(), logicalId = randomUUID();
  const draft = { draft_id: randomUUID(), revision: 1, status: 'pending', logical_skill_id: logicalId, proposal_kind: 'create',
    sanitized_strategy: { name: 'confirm-meaning', description: '合成审核策略', scene: '核对安排', document: '先澄清含义再作答。',
      methods: [{ method_id: randomUUID(), logical_skill_id: logicalId, key: 'ask-first', title: '先核对',
        instruction: '先核对含义，再组织措辞。', replaces_method_ids: [], mapping_status: 'new' }],
      scope_suggestion: { kind: 'contact', reason: '只在当前联系人得到有限支持。', contact_id: contactId } },
    private_evidence: { materials: [], existing_skills: [], source_dependencies: [] }, target_versions: [],
    comparison: null, last_decision: null };
  const records = { generation: 1, calls: [], failAfterCommit: null, barrier: null, lateFailure: false, deleted: false, replies: new Map(), malformed: null, published: null, histories: [], policyState: { revision: 0, policies: [] } };
  const listeners = new Set();
  const backend = { getConnectionGeneration: () => records.generation,
    onStateChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    requestJson: async (request) => {
      records.calls.push(structuredClone({ ...request, signal: undefined }));
      const generation = records.generation;
      let data;
      if (request.path.includes('/skill-learning/policies/') && request.path.endsWith('/undo')) {
        if (records.replies.has(request.body.operation_key)) data = records.replies.get(request.body.operation_key);
        else {
          assert.equal(request.body.expected_revision, records.policyState.revision);
          records.policyState.revision++;
          records.policyState.policies = records.policyState.policies.filter(item => !request.path.endsWith(`/${item.policy_id}/undo`));
          data = structuredClone(records.policyState); records.replies.set(request.body.operation_key, data);
          if (records.failAfterCommit === 'undo-policy') { records.failAfterCommit = null; throw new Error('合成撤销响应丢失'); }
        }
      } else if (request.path.endsWith('/skill-learning/policies')) {
        if (request.method === 'GET') data = records.policyState;
        else if (records.replies.has(request.body.operation_key)) data = records.replies.get(request.body.operation_key);
        else {
          assert.equal(request.body.expected_revision, records.policyState.revision);
          records.policyState.revision++;
          records.policyState.policies.push({ policy_id: randomUUID(), skill_id: request.body.skill_id, name: 'confirm-meaning',
            method_id: request.body.method_id, scope: request.body.scope, revision: records.policyState.revision });
          data = structuredClone(records.policyState); records.replies.set(request.body.operation_key, data);
          if (records.failAfterCommit === 'policy') { records.failAfterCommit = null; throw new Error('合成范围停用响应丢失'); }
        }
      } else if (request.path.includes('/skill-learning/skills')) {
        if (request.method === 'GET') {
          records.onHistoryRead?.();
          data = { skills: records.deleted ? [] : records.histories };
        }
        else if (records.historyFailure) throw new ports.BackendRequestFailure('response', records.historyFailure);
        else if (records.replies.has(request.body.operation_key)) data = records.replies.get(request.body.operation_key);
        else {
          const history = records.histories.find(item => request.path.endsWith(`/skills/${item.skill_id}/rollback`));
          assert.ok(history);
          assert.equal(request.body.expected_revision, history.revision);
          assert.equal(request.body.expected_current_version_id, history.current_version_id);
          history.current_version_id = request.body.version_id; history.revision += 1;
          for (const version of history.versions) version.is_current = version.version_id === history.current_version_id;
          data = structuredClone(history); records.replies.set(request.body.operation_key, data);
          if (records.failAfterCommit === 'rollback') {
            records.failAfterCommit = null;
            if (records.failWithStatus) throw new ports.BackendRequestFailure('response', records.failWithStatus);
            throw new Error('合成回滚响应丢失');
          }
        }
      } else if (request.path.endsWith('/skill-learning')) {
        const summary = structuredClone(draft);
        delete summary.comparison;
        data = { enabled: true, scope_revision: 1, task: null,
          recent_outcomes: [], drafts: records.deleted || draft.status !== 'pending' ? [] : [summary] };
      }
      else if (request.method === 'GET') {
        if (records.deleted) throw new Error('合成草稿来源已删除');
        data = { draft: structuredClone(draft), ...(records.published ? { published: records.published } : {}) };
      }
      else {
        assert.equal(request.path.startsWith(`/api/contacts/${contactId}/skill-learning/drafts/${draft.draft_id}/`), true);
        const action = request.path.split('/').at(-1), body = request.body;
        if (records.replies.has(body.operation_key)) data = records.replies.get(body.operation_key);
        else {
          assert.equal(body.expected_revision, draft.revision);
          if (action === 'edit') {
            Object.assign(draft.sanitized_strategy, body.strategy, { methods: body.strategy.methods.map(method => ({ ...method,
              method_id: randomUUID(), logical_skill_id: logicalId, mapping_status: 'new' })) });
            draft.revision += 1; draft.comparison = null;
          } else if (action === 'compare') {
            const comparisonId = randomUUID();
            draft.comparison = { comparison_id: comparisonId, draft_revision: draft.revision, input_version: randomUUID(),
              input: body.input, scope: body.scope, valid: true,
              before: { name: null, version_id: null, load_state: 'not_used',
                candidates: [{ text: '合成旧回复', basis: '同一冻结输入', risk_notes: [] }] },
              after: { name: draft.sanitized_strategy.name, version_id: comparisonId, load_state: 'loaded',
                candidates: [{ text: '合成新回复', basis: '待审草稿方法', risk_notes: ['核对事实和承诺'] }] } };
          } else if (action === 'approve') { draft.status = 'published'; draft.last_decision = 'approve'; draft.revision += 1; draft.comparison = null; }
          else if (action === 'decision') { draft.status = body.decision === 'reject' ? 'rejected' : 'pending'; draft.last_decision = body.decision; draft.revision += 1; draft.comparison = null; }
          else assert.fail(`未约定动作 ${action}`);
          data = { draft: structuredClone(draft), ...(action === 'approve' ? { published: { skill_id: logicalId,
            version_id: randomUUID(), version_number: 1, name: draft.sanitized_strategy.name,
            scope: body.scope, revision: 2 } } : {}) };
          records.replies.set(body.operation_key, structuredClone(data));
          if (data.published) records.published = data.published;
        }
        if (records.failAfterCommit === action) {
          records.failAfterCommit = null;
          if (records.failWithStatus) throw new ports.BackendRequestFailure('response', records.failWithStatus);
          throw new Error('合成响应丢失');
        }
      }
      const barrier = records.barrier; records.barrier = null;
      if (barrier) await barrier.promise;
      if (records.lateFailure) throw new Error('合成迟到异常');
      if (records.malformed && data.draft?.comparison) records.malformed(data.draft.comparison);
      return { generation, data: structuredClone(data) };
    } };
  const contacts = new ports.ContactSession(async () => ({ generation: records.generation,
    contacts: [contactId, otherContactId].map(id => ({ contactId: id, displayName: '合成审核联系人', messageCount: 0, sourceCount: 1 })) }));
  contacts.setConnection(1); await contacts.refreshContacts();
  contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
  const handlers = new Map();
  const controller = ports.installSkillLearningBridge({
    handle: (channel, handler, role) => { assert.equal(role, 'manager'); handlers.set(channel, handler); }, publish: () => {},
  }, backend, contacts);
  const bridge = ports.createSkillLearningBridge({ invoke: (channel, ...args) => Promise.resolve().then(() => handlers.get(channel)(...args)),
    on: () => {}, removeListener: () => {} });
  const scope = () => ({ contactId: contacts.getState().selectedContactId, scopeRevision: contacts.getState().scopeRevision });
  const selected = () => ({ ...scope(), draftId: draft.draft_id, expectedRevision: controller.getState().review.draft.revision });
  await bridge.refresh(scope());
  return { owned, records, contacts, backend, listeners, controller, bridge, handlers, scope, selected, draft, contactId, otherContactId };
}

test('生产历史桥可回滚保留版本，未知结果重试同一动作，删除与换联系人撤下历史', async () => {
  const f = await reviewFixture();
  try {
    const old = randomUUID(), current = randomUUID(), skill = randomUUID();
    f.records.histories = [{ skill_id: skill, name: 'confirm-meaning', status: 'active', revision: 3, current_version_id: current,
      versions: [current, old].map((id, index) => ({ version_id: id, version_number: 2 - index, document: `合成方法版本${2 - index}`,
        is_current: index === 0, enabled: true, scope: { kind: 'contact', contact_id: f.contactId, scene: null },
        methods: [], source_dependency_count: 2 })) }];
    await f.bridge.openHistory(f.scope());
    assert.equal(f.controller.getState().history.skills[0].versions[1].document, '合成方法版本1');
    f.records.failAfterCommit = 'rollback';
    await f.bridge.rollbackHistory({ ...f.scope(), skillId: skill, versionId: old });
    assert.equal(f.controller.getState().history.retry, true);
    await f.bridge.retryHistory(f.scope());
    const calls = f.records.calls.filter(call => call.path.endsWith('/rollback'));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body, calls[1].body);
    assert.equal(f.controller.getState().history.skills[0].current_version_id, old);
    assert.equal(f.records.calls.at(-1).method, 'GET', '回滚成功后读取权威目录');
    const settled = f.controller.beginDeletion();
    assert.equal(f.controller.getState().history, null);
    await f.bridge.openHistory(f.scope());
    assert.equal(f.controller.getState().history, null);
    settled();
    await f.bridge.openHistory(f.scope());
    f.contacts.selectContact({ contactId: f.otherContactId, scopeRevision: f.contacts.getState().scopeRevision });
    assert.equal(f.controller.getState().history, null);
  } finally { await rm(f.owned, { recursive: true, force: true }); }
});

for (const transition of ['联系人往返', '后端重连', '删除期间联系人往返']) {
  test(`历史回滚在途${transition}后迟到响应不能恢复正文或操作许可`, async () => {
    const f = await reviewFixture(), barrier = Promise.withResolvers();
    let settled;
    try {
      const old = randomUUID(), current = randomUUID(), skill = randomUUID();
      f.records.histories = [{ skill_id: skill, name: 'confirm-meaning', status: 'disabled', revision: 3, current_version_id: current,
        versions: [current, old].map((id, index) => ({ version_id: id, version_number: 2 - index,
          document: `合成在途版本${2 - index}`, is_current: index === 0, enabled: true,
          scope: { kind: 'contact', contact_id: f.contactId, scene: null }, methods: [], source_dependency_count: 2 })) }];
      await f.bridge.openHistory(f.scope());
      f.records.barrier = barrier;
      const pending = f.bridge.rollbackHistory({ ...f.scope(), skillId: skill, versionId: old });
      await new Promise(resolve => setImmediate(resolve));
      if (transition.startsWith('删除')) settled = f.controller.beginDeletion();
      if (transition.includes('联系人往返')) {
        f.contacts.selectContact({ contactId: f.otherContactId, scopeRevision: f.scope().scopeRevision });
        f.contacts.selectContact({ contactId: f.contactId, scopeRevision: f.scope().scopeRevision });
      } else { f.records.generation = 2; for (const listener of f.listeners) listener(); }
      if (settled) {
        const calls = f.records.calls.length;
        await f.bridge.openHistory(f.scope());
        assert.equal(f.records.calls.length, calls, '往返联系人不能解除未结算删除隔离');
      }
      barrier.resolve(); await pending;
      assert.equal(f.controller.getState().history, null);
      await assert.rejects(f.bridge.retryHistory(f.scope()));
    } finally { barrier.resolve(); settled?.(); await rm(f.owned, { recursive: true, force: true }); }
  });
}

test('历史回滚500未知回执只重试完整原动作，具名桥拒绝附加字段和旧范围', async () => {
  const f = await reviewFixture();
  try {
    const old = randomUUID(), current = randomUUID(), skill = randomUUID();
    f.records.histories = [{ skill_id: skill, name: 'confirm-meaning', status: 'disabled', revision: 3, current_version_id: current,
      versions: [current, old].map((id, index) => ({ version_id: id, version_number: 2 - index, document: `合成停用版本${2 - index}`,
        is_current: index === 0, enabled: true, scope: { kind: 'contact', contact_id: f.contactId, scene: null },
        methods: [], source_dependency_count: 2 })) }];
    await f.bridge.openHistory(f.scope());
    const selection = { ...f.scope(), skillId: skill, versionId: old }, count = f.records.calls.length;
    await assert.rejects(f.bridge.rollbackHistory({ ...selection, path: '/api/skills' }));
    await assert.rejects(f.bridge.rollbackHistory({ ...selection, scopeRevision: selection.scopeRevision + 1 }));
    assert.equal(f.records.calls.length, count);
    f.records.failAfterCommit = 'rollback'; f.records.failWithStatus = 500;
    await f.bridge.rollbackHistory(selection);
    assert.equal(f.controller.getState().history.retry, true);
    const original = f.records.calls.at(-1).body;
    await f.bridge.refresh(f.scope());
    assert.deepEqual(f.records.calls.at(-1).body, original, '轮询不取消或替换未知回滚动作');
    await assert.rejects(f.bridge.rollbackHistory(selection));
    await f.bridge.retryHistory(f.scope());
    const calls = f.records.calls.filter(call => call.path.endsWith('/rollback'));
    assert.deepEqual(calls[1].body, original);
    assert.equal(f.controller.getState().history.skills[0].status, 'disabled');
    assert.equal(f.controller.getState().history.skills[0].current_version_id, old);
  } finally { await rm(f.owned, { recursive: true, force: true }); }
});

test('回滚成功以后以重新读取的权威目录为准，冲突撤销旧回滚许可', async () => {
  const f = await reviewFixture();
  try {
    const old = randomUUID(), current = randomUUID(), skill = randomUUID();
    const history = { skill_id: skill, name: 'confirm-meaning', status: 'active', revision: 3, current_version_id: current,
      versions: [current, old].map((id, index) => ({ version_id: id, version_number: 2 - index, document: `合成权威版本${2 - index}`,
        is_current: index === 0, enabled: true, scope: { kind: 'contact', contact_id: f.contactId, scene: null },
        methods: [], source_dependency_count: 2 })) };
    f.records.histories = [history];
    await f.bridge.openHistory(f.scope());
    f.records.onHistoryRead = () => {
      f.records.onHistoryRead = null;
      history.current_version_id = current; history.revision = 5;
      for (const version of history.versions) version.is_current = version.version_id === current;
    };
    await f.bridge.rollbackHistory({ ...f.scope(), skillId: skill, versionId: old });
    assert.equal(f.controller.getState().history.skills[0].current_version_id, current,
      'POST之后其他权威写入改变了current，页面不能复制原回滚回执');
    assert.equal(f.controller.getState().history.skills[0].revision, 5);
    f.records.historyFailure = 409;
    await f.bridge.rollbackHistory({ ...f.scope(), skillId: skill, versionId: old });
    assert.equal(f.controller.getState().history.phase, 'failed');
    assert.equal(f.controller.getState().history.retry, false);
    assert.deepEqual(f.controller.getState().history.skills, []);
    await assert.rejects(f.bridge.retryHistory(f.scope()));
  } finally { await rm(f.owned, { recursive: true, force: true }); }
});

test('生产列表不携对照时轮询沿详情核验，保留有效对照并撤下失效结果', async () => {
  const f = await reviewFixture();
  try {
    await f.bridge.openReview({ ...f.scope(), draftId: f.draft.draft_id });
    const form = structuredClone(f.controller.getState().review.form);
    form.input = { incoming_text: '合成审核输入', intent: '先说明想法', scene: '核对安排' };
    f.bridge.updateReview({ ...f.selected(), form });
    await f.bridge.compareReview(f.selected());
    const comparison = f.controller.getState().review.comparison;
    assert.ok(comparison);
    await f.bridge.refresh(f.scope());
    assert.equal(f.controller.getState().review.comparison?.comparison_id, comparison.comparison_id);
    f.draft.comparison = null;
    await f.bridge.refresh(f.scope());
    assert.equal(f.controller.getState().review.comparison, null);
  } finally { await rm(f.owned, { recursive: true, force: true }); }
});

test('用户通过生产审核桥看到同输入两侧、改输入撤下旧对照并确认后发布实际版本', async () => {
  const f = await reviewFixture();
  try {
    await f.bridge.openReview({ ...f.scope(), draftId: f.draft.draft_id });
    const form = f.controller.getState().review.form;
    form.input = { incoming_text: '合成来话：时间方便吗？', intent: '先核对安排，不作承诺。', scene: '核对安排' };
    await f.bridge.updateReview({ ...f.selected(), form });
    await f.bridge.compareReview(f.selected());
    let review = f.controller.getState().review;
    assert.equal(review.comparison.before.candidates[0].text, '合成旧回复');
    assert.equal(review.comparison.after.candidates[0].text, '合成新回复');
    assert.deepEqual(review.comparison.input, form.input);
    const oldComparisonId = review.comparison.comparison_id;
    form.input.intent = '只询问，不承诺赴约。';
    await f.bridge.updateReview({ ...f.selected(), form });
    assert.equal(f.controller.getState().review.comparison, null);
    await assert.rejects(f.bridge.approveReview({ ...f.selected(), comparisonId: oldComparisonId, confirmed: true, replacementsConfirmed: true }));
    await f.bridge.compareReview(f.selected());
    review = f.controller.getState().review;
    await f.bridge.approveReview({ ...f.selected(), comparisonId: review.comparison.comparison_id, confirmed: true, replacementsConfirmed: true });
    const published = f.controller.getState().review.published;
    assert.equal(published.name, 'confirm-meaning');
    assert.equal(published.version_number, 1);
    assert.deepEqual(published.scope, { kind: 'contact', contact_id: f.contactId, scene: null });
    assert.deepEqual(f.controller.getState().drafts, []);
    f.records.published.revision = 3;
    await f.bridge.refresh(f.scope());
    assert.equal(f.controller.getState().review.published.revision, 3, '发布后的刷新读取真实权威回执');
    f.records.deleted = true; await f.bridge.refresh(f.scope());
    assert.equal(f.controller.getState().review, null, '发布后来源删除也必须清除策略与回执');
  } finally { await rm(f.owned, { recursive: true, force: true }); }
});

for (const [label, malformed] of [
  ['新侧loaded但缺版本', comparison => { comparison.after.version_id = null; }],
  ['新侧版本不属于本次对照', comparison => { comparison.after.version_id = randomUUID(); }],
  ['新侧名称不属于当前草稿', comparison => { comparison.after.name = 'other-skill'; }],
  ['旧侧loaded但缺名称版本', comparison => { comparison.before.load_state = 'loaded'; }],
]) {
  test(`审核拒绝${label}的畸形结果`, async () => {
    const f = await reviewFixture();
    try {
      await f.bridge.openReview({ ...f.scope(), draftId: f.draft.draft_id });
      const form = f.controller.getState().review.form;
      form.input = { incoming_text: '合成来话', intent: '核对安排', scene: '核对安排' };
      await f.bridge.updateReview({ ...f.selected(), form }); f.records.malformed = malformed;
      await f.bridge.compareReview(f.selected());
      assert.equal(f.controller.getState().review.phase, 'failed');
      assert.equal(f.controller.getState().review.comparison, null);
    } finally { await rm(f.owned, { recursive: true, force: true }); }
  });
}

test('审核具名桥严格拒绝扩张读取、伪造方法身份及未确认发布', async () => {
  const f = await reviewFixture();
  try {
    await f.bridge.openReview({ ...f.scope(), draftId: f.draft.draft_id });
    const selected = f.selected(), form = f.controller.getState().review.form;
    const before = f.records.calls.length;
    await assert.rejects(f.bridge.openReview({ ...f.scope(), draftId: f.draft.draft_id, path: '/api/skills/publish' }));
    await assert.rejects(f.bridge.updateReview({ ...selected, form: { ...form, owner_id: f.contactId } }));
    await assert.rejects(f.bridge.updateReview({ ...selected, form: { ...form, strategy: { ...form.strategy,
      methods: [{ ...form.strategy.methods[0], method_id: randomUUID() }] } } }));
    await assert.rejects(f.bridge.updateReview({ ...selected, form: { ...form, scope: { kind: 'contact', contact_id: f.otherContactId, scene: null } } }));
    await assert.rejects(f.bridge.updateReview({ ...selected, form: { ...form, strategy: { ...form.strategy,
      methods: [{ ...form.strategy.methods[0], replaces_method_ids: [randomUUID()] }] } } }));
    await assert.rejects(f.bridge.approveReview({ ...selected, comparisonId: randomUUID(), confirmed: false, replacementsConfirmed: true }));
    assert.equal(f.records.calls.length, before, '无效参数不能到达受控HTTP边界');
  } finally { await rm(f.owned, { recursive: true, force: true }); }
});

test('暂留可从权威草稿继续审核，拒绝后不再进入待审核列表', async () => {
  const f = await reviewFixture();
  try {
    await f.bridge.openReview({ ...f.scope(), draftId: f.draft.draft_id });
    await f.bridge.decideReview({ ...f.selected(), decision: 'defer' });
    assert.equal(f.controller.getState().review, null);
    assert.equal(f.controller.getState().drafts[0].last_decision, 'defer');
    await f.bridge.openReview({ ...f.scope(), draftId: f.draft.draft_id });
    assert.equal(f.controller.getState().review.draft.revision, 2);
    await f.bridge.decideReview({ ...f.selected(), decision: 'reject' });
    await f.bridge.refresh(f.scope());
    assert.equal(f.controller.getState().review, null);
    assert.deepEqual(f.controller.getState().drafts, []);
  } finally { await rm(f.owned, { recursive: true, force: true }); }
});

test('原草稿同修订但来源或Skill对照失效时，轮询撤下预览且不能使用旧批准', async () => {
  const f = await reviewFixture();
  try {
    await f.bridge.openReview({ ...f.scope(), draftId: f.draft.draft_id });
    const form = f.controller.getState().review.form;
    form.input = { incoming_text: '合成来话', intent: '核对安排', scene: '核对安排' };
    await f.bridge.updateReview({ ...f.selected(), form }); await f.bridge.compareReview(f.selected());
    const comparisonId = f.controller.getState().review.comparison.comparison_id;
    f.draft.comparison.valid = false;
    await f.bridge.refresh(f.scope());
    assert.equal(f.controller.getState().review.comparison, null);
    await assert.rejects(f.bridge.approveReview({ ...f.selected(), comparisonId, confirmed: true, replacementsConfirmed: true }));
    f.records.deleted = true;
    await f.bridge.refresh(f.scope());
    assert.equal(f.controller.getState().review, null, '权威待审核中已删除草稿必须连同表单清空');
  } finally { await rm(f.owned, { recursive: true, force: true }); }
});

test('对照失效后相同表单发起新操作，响应丢失只重试原操作', async () => {
  const f = await reviewFixture();
  try {
    await f.bridge.openReview({ ...f.scope(), draftId: f.draft.draft_id });
    const form = f.controller.getState().review.form;
    form.input = { incoming_text: '合成来话', intent: '先核对安排', scene: '核对安排' };
    await f.bridge.updateReview({ ...f.selected(), form });
    await f.bridge.compareReview(f.selected());
    const firstComparison = f.controller.getState().review.comparison.comparison_id;
    const firstKey = f.records.calls.at(-1).body.operation_key;
    f.draft.comparison = null;
    await f.bridge.refresh(f.scope());
    assert.equal(f.controller.getState().review.comparison, null);
    await f.bridge.compareReview(f.selected());
    assert.notEqual(f.records.calls.at(-1).body.operation_key, firstKey, '明确重新生成不能复用已完成且失效的操作');
    assert.notEqual(f.controller.getState().review.comparison.comparison_id, firstComparison);
    f.records.failAfterCommit = 'compare';
    await f.bridge.compareReview(f.selected());
    const uncertainBody = f.records.calls.at(-1).body;
    assert.equal(f.controller.getState().review.phase, 'failed');
    await f.bridge.retryReview(f.selected());
    assert.deepEqual(f.records.calls.at(-1).body, uncertainBody, '未知提交结果保留完整原操作身份');
    assert.equal(f.controller.getState().review.phase, 'ready');
    assert.equal(f.controller.getState().review.comparison.valid, true);
  } finally { await rm(f.owned, { recursive: true, force: true }); }
});

for (const transition of ['删除', '联系人切换', '后端重连', '删除且迟到异常']) {
  test(`${transition}后迟到对照不会恢复旧输入、私人依据或发布动作`, async () => {
    const f = await reviewFixture();
    const barrier = Promise.withResolvers();
    let settleDeletion;
    try {
      await f.bridge.openReview({ ...f.scope(), draftId: f.draft.draft_id });
      const form = f.controller.getState().review.form;
      form.input = { incoming_text: '合成待撤下来话', intent: '核对安排', scene: '核对安排' };
      await f.bridge.updateReview({ ...f.selected(), form });
      f.records.barrier = barrier;
      const comparing = f.bridge.compareReview(f.selected());
      await new Promise(resolve => setImmediate(resolve));
      if (transition.startsWith('删除')) {
        settleDeletion = f.controller.beginDeletion(); f.records.deleted = true;
        const calls = f.records.calls.length;
        await f.bridge.refresh(f.scope());
        assert.equal(f.records.calls.length, calls, '删除实际结算前不重新读取权威库中的旧内容');
      } else if (transition === '联系人切换') f.contacts.selectContact({ contactId: f.otherContactId, scopeRevision: f.scope().scopeRevision });
      else { f.records.generation = 2; for (const listener of f.listeners) listener(); }
      if (transition.endsWith('异常')) f.records.lateFailure = true;
      barrier.resolve(); await comparing;
      assert.equal(f.controller.getState().review, null);
      assert.deepEqual(f.controller.getState().drafts, []);
      assert.equal(f.controller.getState().phase, 'idle');
    } finally { barrier.resolve(); settleDeletion?.(); await rm(f.owned, { recursive: true, force: true }); }
  });
}

test('方法编辑经轮询保留，显式保存和批准响应丢失后用同一次操作恢复真实回执', async () => {
  const f = await reviewFixture();
  try {
    await f.bridge.openReview({ ...f.scope(), draftId: f.draft.draft_id });
    let form = f.controller.getState().review.form;
    form.strategy.description = '明确核对安排并保留当前意图';
    await f.bridge.updateReview({ ...f.selected(), form });
    await f.bridge.refresh(f.scope());
    assert.equal(f.controller.getState().review.form.strategy.description, '明确核对安排并保留当前意图');
    assert.equal(f.controller.getState().review.dirty, true);
    await assert.rejects(f.bridge.compareReview(f.selected()));
    f.records.failAfterCommit = 'edit';
    await f.bridge.saveReview(f.selected());
    assert.equal(f.controller.getState().review.phase, 'failed');
    await f.bridge.retryReview(f.selected());
    assert.equal(f.controller.getState().review.draft.revision, 2);
    assert.equal(f.controller.getState().review.dirty, false);
    const saves = f.records.calls.filter(request => request.path.endsWith('/edit'));
    assert.equal(saves.length, 2);
    assert.deepEqual(saves[0].body, saves[1].body, '响应丢失重试沿用完整操作身份和期望修订');
    form = f.controller.getState().review.form;
    form.input = { incoming_text: '合成来话', intent: '先核实', scene: '核对安排' };
    form.scope = { kind: 'scene', contact_id: null, scene: '核对安排' };
    await f.bridge.updateReview({ ...f.selected(), form });
    await f.bridge.compareReview(f.selected());
    const comparisonId = f.controller.getState().review.comparison.comparison_id;
    f.records.failAfterCommit = 'approve';
    await f.bridge.approveReview({ ...f.selected(), comparisonId, confirmed: true, replacementsConfirmed: true });
    assert.equal(f.controller.getState().review.comparison, null, '未确认完成的发布不得留下可批准旧对照');
    await f.bridge.refresh(f.scope());
    assert.equal(f.controller.getState().review.published.version_number, 1);
    assert.deepEqual(f.controller.getState().review.published.scope, { kind: 'scene', contact_id: null, scene: '核对安排' });
    const approvals = f.records.calls.filter(request => request.path.endsWith('/approve'));
    assert.deepEqual(approvals[0].body, approvals[1].body);
  } finally { await rm(f.owned, { recursive: true, force: true }); }
});

test('审核POST未结算时轮询保持原对照任务，500未知批准沿原body和key恢复', async () => {
  const f = await reviewFixture(), barrier = Promise.withResolvers();
  try {
    await f.bridge.openReview({ ...f.scope(), draftId: f.draft.draft_id });
    const form = f.controller.getState().review.form;
    form.input = { incoming_text: '合成在途审核输入', intent: '只核对安排', scene: '核对安排' };
    await f.bridge.updateReview({ ...f.selected(), form });
    f.records.barrier = barrier;
    const comparing = f.bridge.compareReview(f.selected());
    await new Promise(resolve => setImmediate(resolve));
    const callCount = f.records.calls.length;
    await f.bridge.refresh(f.scope());
    assert.equal(f.records.calls.length, callCount);
    assert.equal(f.controller.getState().review.phase, 'comparing');
    barrier.resolve(); await comparing;
    const comparisonId = f.controller.getState().review.comparison.comparison_id;
    f.records.failAfterCommit = 'approve'; f.records.failWithStatus = 500;
    await f.bridge.approveReview({ ...f.selected(), comparisonId, confirmed: true, replacementsConfirmed: true });
    assert.equal(f.controller.getState().review.retry, 'approve');
    const original = f.records.calls.at(-1).body;
    await f.bridge.refresh(f.scope());
    assert.deepEqual(f.records.calls.at(-1).body, original);
    assert.equal(f.records.replies.size, 2, '同一次对照和批准只各保存一份权威结果');
    assert.equal(f.controller.getState().review.published.version_number, 1);
  } finally { barrier.resolve(); await rm(f.owned, { recursive: true, force: true }); }
});

test('生产反馈桥显式绑定方法与范围，未知结果重试原动作，删除期间和换联系人不复活', async () => {
  const f = await reviewFixture();
  try {
    const skill = randomUUID(), version = randomUUID(), method = randomUUID();
    f.records.histories = [{ skill_id: skill, name: 'confirm-meaning', status: 'active', revision: 1, current_version_id: version,
      versions: [{ version_id: version, version_number: 1, document: '合成原不可变方法', is_current: true, enabled: true,
        scope: { kind: 'owner', contact_id: null, scene: null }, source_dependency_count: 1,
        methods: [{ method_id: method, title: '合成明确方法', instruction: '先核对', replaces_method_ids: [], mapping_state: 'new' }] }] }];
    await f.bridge.openHistory(f.scope());
    await f.bridge.openPolicies(f.scope());
    f.records.failAfterCommit = 'policy';
    const command = { ...f.scope(), skillId: skill, versionId: version, methodId: method,
      policyScope: { kind: 'contact', contact_id: f.contactId, scene: null } };
    await f.bridge.changePolicy(command);
    assert.equal(f.controller.getState().policies.retry, true);
    await f.bridge.retryPolicy(f.scope());
    const calls = f.records.calls.filter(call => call.method === 'POST' && call.path.endsWith('/policies'));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body, calls[1].body);
    assert.equal(f.controller.getState().policies.policies[0].method_id, method);
    const policyId = f.controller.getState().policies.policies[0].policy_id;
    f.records.failAfterCommit = 'undo-policy';
    await f.bridge.undoPolicy({ ...f.scope(), policyId });
    assert.equal(f.controller.getState().policies.retry, true);
    await f.bridge.retryPolicy(f.scope());
    assert.deepEqual(f.controller.getState().policies.policies, []);
    const undo = f.records.calls.filter(call => call.path.endsWith('/undo'));
    assert.equal(undo.length, 2);
    assert.deepEqual(undo[0].body, undo[1].body);
    const count = f.records.calls.length;
    await assert.rejects(f.bridge.changePolicy({ ...command, owner_id: randomUUID() }));
    assert.equal(f.records.calls.length, count);
    const settled = f.controller.beginDeletion();
    assert.equal(f.controller.getState().policies, null);
    await f.bridge.openPolicies(f.scope());
    assert.equal(f.controller.getState().policies, null);
    settled();
    await f.bridge.openPolicies(f.scope());
    f.contacts.selectContact({ contactId: f.otherContactId, scopeRevision: f.contacts.getState().scopeRevision });
    assert.equal(f.controller.getState().policies, null);
  } finally { await rm(f.owned, { recursive: true, force: true }); }
});


test('审核保留实际允许方法凭证，畸形或重复方法身份不能成为有效对照', async () => {
  const f = await reviewFixture();
  try {
    await f.bridge.openReview({ ...f.scope(), draftId: f.draft.draft_id });
    const form = f.controller.getState().review.form;
    form.input = { incoming_text: '合成来话', intent: '核对安排', scene: '核对安排' };
    await f.bridge.updateReview({ ...f.selected(), form });
    const method = randomUUID();
    f.records.malformed = comparison => { comparison.after.execution_view = { policy_revision: 1, method_ids: [method], sha256: 'a'.repeat(64) }; };
    await f.bridge.compareReview(f.selected());
    assert.equal(f.controller.getState().review.phase, 'ready');
    assert.deepEqual(f.controller.getState().review.comparison.after.execution_view.method_ids, [method]);
    f.records.malformed = comparison => { comparison.after.execution_view = { policy_revision: 1, method_ids: [method, method], sha256: 'a'.repeat(64) }; };
    await f.bridge.compareReview(f.selected());
    assert.equal(f.controller.getState().review.phase, 'failed');
    assert.equal(f.controller.getState().review.comparison, null);
  } finally { await rm(f.owned, { recursive: true, force: true }); }
});

test('政策面板轮询仍复验历史来源，并保留未知政策动作的原重试身份', async () => {
  const f = await reviewFixture();
  try {
    const skill = randomUUID(), version = randomUUID();
    f.records.histories = [{ skill_id: skill, name: 'confirm-meaning', status: 'active', revision: 1, current_version_id: version,
      versions: [{ version_id: version, version_number: 1, document: '合成应随来源撤下的历史正文', is_current: true, enabled: true,
        scope: { kind: 'owner', contact_id: null, scene: null }, source_dependency_count: 1, methods: [] }] }];
    await f.bridge.openHistory(f.scope()); await f.bridge.openPolicies(f.scope());
    f.records.failAfterCommit = 'policy';
    await f.bridge.changePolicy({ ...f.scope(), skillId: skill, versionId: version, methodId: null,
      policyScope: { kind: 'contact', contact_id: f.contactId, scene: null } });
    assert.equal(f.controller.getState().policies.retry, true);
    f.records.deleted = true; await f.bridge.refresh(f.scope());
    assert.deepEqual(f.controller.getState().history.skills, []);
    assert.equal(f.controller.getState().policies.retry, true);
    await f.bridge.retryPolicy(f.scope());
    const calls = f.records.calls.filter(call => call.method === 'POST' && call.path.endsWith('/policies'));
    assert.deepEqual(calls[0].body, calls[1].body);
  } finally { await rm(f.owned, { recursive: true, force: true }); }
});

for (const close of ['closePolicies', 'closeHistory']) test(`历史来源复验迟到后不会撤销用户的${close}关闭动作`, async () => {
  const f = await reviewFixture();
  try {
    await f.bridge.openHistory(f.scope()); await f.bridge.openPolicies(f.scope());
    let release;
    f.records.barrier = { promise: new Promise(resolve => { release = resolve; }) };
    const refreshing = f.bridge.refresh(f.scope());
    await new Promise(resolve => setTimeout(resolve, 0));
    await f.bridge[close](f.scope());
    release(); await refreshing;
    assert.equal(f.controller.getState().policies, null);
    if (close === 'closeHistory') assert.equal(f.controller.getState().history, null);
  } finally { await rm(f.owned, { recursive: true, force: true }); }
});
