import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { historicalReplyFixture, ports } from '../fixtures/historical-reply-basis.mjs';

const deferred = () => Promise.withResolvers();
const sample = (text, originKind = 'manual', originId = null) => ({ sample_id: randomUUID(), text,
  origin_kind: originKind, origin_id: originId, source_ids: [], saved_at: '2026-10-15T01:00:00Z', sending_status: 'unknown' });

async function sampleDeletionFixture() {
  const f = await historicalReplyFixture();
  const preferenceId = randomUUID();
  const preference = { preference_id: preferenceId, text: '合成待删除长期偏好。',
    scope: { contact_id: null, reply_mode: null }, revision: 1, confirmed_operation_key: randomUUID(),
    origin: { kind: 'manual' }, source_ids: [], confirmed_at: '2026-10-15T01:00:00Z', updated_at: '2026-10-15T01:00:00Z' };
  const dependent = sample('依赖待删除偏好的合成样本文字。', 'candidate', f.candidateId);
  const independent = sample('用户主动保存的独立合成样本文字。');
  const records = { deleted: false, samples: [dependent, independent], nextSampleRead: undefined,
    deleteReceipt: undefined, preferenceDirectory: undefined, directoryStarted: deferred() };
  const sampleReads = [], deletes = [];
  const requestJson = f.backend.requestJson;
  f.backend.requestJson = async (request) => {
    if (request.path.startsWith('/api/expression-preferences')) {
      if (request.method === 'DELETE') {
        deletes.push(request.body);
        await records.deleteReceipt?.promise;
        if (records.deleteFailure) throw records.deleteFailure;
        records.deleted = true;
        records.samples = records.samples.filter((item) => item.sample_id !== dependent.sample_id);
        return { generation: f.records.generation, data: { state: 'deleted' } };
      }
      if (records.deleted && records.preferenceDirectory) {
        records.directoryStarted.resolve();
        await records.preferenceDirectory.promise;
      }
      return { generation: f.records.generation, data: { preferences: records.deleted ? [] : [preference] } };
    }
    if (request.path.endsWith('/style-samples')) {
      if (request.method === 'POST') {
        const saved = sample(request.body.text, request.body.origin.kind, request.body.origin.id ?? null);
        records.samples.push(saved);
        return { generation: f.records.generation, data: { sample: saved } };
      }
      sampleReads.push(request);
      if (records.sampleFailure) throw records.sampleFailure;
      const response = structuredClone({ generation: f.records.generation, data: { samples: records.samples } });
      const delayed = records.nextSampleRead;
      records.nextSampleRead = undefined;
      if (delayed) await delayed.promise;
      return response;
    }
    return requestJson(request);
  };
  const samples = new ports.StyleSampleController(f.backend, f.contacts, f.replies);
  const deletion = ports.expressionPreferenceDeletion(new ports.TraceController(f.backend, f.contacts), f.replies, samples);
  const preferences = new ports.ExpressionPreferenceController(f.backend, f.contacts, deletion);
  await preferences.refresh(f.scope);
  await samples.refresh(f.scope);
  return { ...f, samples, preferences, deletion, sampleRecords: records, sampleReads, deletes,
    dependent, independent, removal: { ...f.scope, preferenceId, expectedRevision: 1 } };
}

test('实际偏好删除边界在目录结算前撤下样本，旧GET与显式刷新不能复活已删正文', async () => {
  const f = await sampleDeletionFixture();
  const oldRead = deferred(), deletionReceipt = deferred(), directory = deferred();
  f.sampleRecords.nextSampleRead = oldRead;
  const pendingRead = f.samples.refresh(f.scope);
  const pendingSignal = f.sampleReads.at(-1).signal;
  const beforeErasure = f.samples.getState().erasureRevision;
  f.sampleRecords.deleteReceipt = deletionReceipt;
  f.sampleRecords.preferenceDirectory = directory;
  const removing = f.preferences.remove(f.removal);
  const started = f.samples.getState();
  try {
    deletionReceipt.resolve();
    await f.sampleRecords.directoryStarted.promise;
    assert.equal(f.sampleRecords.deleted, true);
    oldRead.resolve();
    await pendingRead;
    assert.deepEqual(f.samples.getState().samples, [], '已提交删除期间的旧样本响应不能恢复正文');
    assert.equal(pendingSignal.aborted, true);
    assert(started.erasureRevision > beforeErasure);
    assert.deepEqual(started.samples, []);
    assert.equal(started.busy, true);
    await f.samples.refresh(f.scope);
    assert.deepEqual(f.samples.getState().samples, []);
    assert.equal(f.samples.getState().busy, true);
    directory.resolve();
    await removing;
    assert.deepEqual(f.samples.getState().samples.map((item) => item.text), [f.independent.text]);
    assert.equal(f.samples.getState().busy, false);
  } finally {
    oldRead.resolve(); deletionReceipt.resolve(); directory.resolve();
    await Promise.all([pendingRead, removing]);
  }
});

test('偏好删除未决时来源事件、联系人切换和重连均保留样本隔离，结算只恢复当前合法目录', async (t) => {
  for (const change of ['来源事件', '联系人切换', '后端重连']) await t.test(change, async () => {
    const f = await sampleDeletionFixture();
    const oldRead = deferred(), receipt = deferred();
    f.sampleRecords.nextSampleRead = oldRead;
    const pendingRead = f.samples.refresh(f.scope);
    f.sampleRecords.deleteReceipt = receipt;
    const removing = f.preferences.remove(f.removal);
    let scope = f.scope;
    try {
      if (change === '来源事件') await f.samples.invalidateSource(f.scope.contactId);
      else if (change === '联系人切换') {
        const contactId = randomUUID();
        f.records.directory.push({ contactId, displayName: '合成新范围联系人', messageCount: 0, sourceCount: 0 });
        await f.contacts.refreshContacts();
        f.contacts.selectContact({ contactId, scopeRevision: f.contacts.getState().scopeRevision });
        scope = { contactId, scopeRevision: f.contacts.getState().scopeRevision };
        f.sampleRecords.samples = [sample('新范围中仍合法的独立合成样本。')];
      } else {
        f.records.generation = undefined;
        f.contacts.setConnection(undefined);
        for (const listener of f.backendListeners) listener();
        f.records.generation = 8;
        f.contacts.setConnection(8);
        await f.contacts.refreshContacts();
        f.contacts.selectContact({ contactId: f.scope.contactId, scopeRevision: f.contacts.getState().scopeRevision });
        for (const listener of f.backendListeners) listener();
        scope = { contactId: f.scope.contactId, scopeRevision: f.contacts.getState().scopeRevision };
      }
      await f.samples.refresh(scope);
      assert.deepEqual(f.samples.getState().samples, []);
      assert.equal(f.samples.getState().busy, true);
      await assert.rejects(f.samples.saveManual({ ...scope, text: '删除未决时不能保存的合成输入。' }), /样本正在保存/);
      receipt.resolve();
      await removing;
      const legalTexts = f.sampleRecords.samples.map((item) => item.text);
      assert.deepEqual(f.samples.getState().samples.map((item) => item.text), legalTexts);
      assert.equal(f.samples.getState().contactId, scope.contactId);
      assert.equal(f.samples.getState().busy, false);
      oldRead.resolve();
      await pendingRead;
      assert.deepEqual(f.samples.getState().samples.map((item) => item.text), legalTexts);
    } finally { oldRead.resolve(); receipt.resolve(); await Promise.all([pendingRead, removing]); }
  });
});

test('实际删除边界在DELETE或样本复读失败后允许权威重试，独立样本和合法编辑仍可使用', async () => {
  const f = await sampleDeletionFixture();
  await f.bridge.readSavedSession(f.scope);
  f.contacts.setDraft({ ...f.scope, text: '故障恢复中的独立合成草稿。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  await f.bridge.editCandidate({ ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId,
    text: '删除不依赖此依据的合法用户编辑。' });
  f.sampleRecords.deleteFailure = new ports.BackendRequestFailure('connection');
  const beforeErasure = f.samples.getState().erasureRevision;
  const firstRemoval = f.preferences.remove(f.removal);
  assert.deepEqual(f.samples.getState().samples, []);
  assert.equal(f.samples.getState().busy, true);
  assert(f.samples.getState().erasureRevision > beforeErasure);
  await assert.rejects(firstRemoval, /操作或核对未完成/);
  assert.equal(f.sampleRecords.deleted, false);
  assert.deepEqual(f.samples.getState().samples.map((item) => item.text), [f.dependent.text, f.independent.text]);
  assert.equal((await f.bridge.getState()).result?.candidates[0].editedText, '删除不依赖此依据的合法用户编辑。');
  f.sampleRecords.deleteFailure = undefined;
  f.sampleRecords.sampleFailure = new ports.BackendRequestFailure('connection');
  await f.preferences.remove(f.removal);
  assert.deepEqual(f.deletes[1], f.deletes[0]);
  assert.equal(f.samples.getState().phase, 'failed');
  assert.deepEqual(f.samples.getState().samples, []);
  assert.equal(f.samples.getState().busy, false);
  f.sampleRecords.sampleFailure = undefined;
  await f.samples.refresh(f.scope);
  await f.samples.revalidateExpressionPreferences();
  assert.deepEqual(f.samples.getState().samples.map((item) => item.text), [f.independent.text]);
  await f.samples.updateManualText({ ...f.scope, text: '' });
  await f.samples.saveManual({ ...f.scope, text: '故障恢复后主动保存的新独立合成表达。' });
  assert.deepEqual(f.samples.getState().samples.map((item) => item.text), [f.independent.text, '故障恢复后主动保存的新独立合成表达。']);
  assert.equal((await f.bridge.getState()).result?.candidates[0].editedText, '删除不依赖此依据的合法用户编辑。');
  assert.equal(f.contacts.getState().draft, '故障恢复中的独立合成草稿。');
});

test('偏好删除检查后合法候选和编辑经公开依据复核恢复，读取故障可重试', async () => {
  const f = await historicalReplyFixture();
  await f.bridge.readSavedSession(f.scope);
  await f.bridge.setMode({ ...f.scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...f.scope, purpose: '这次只问候，不作承诺。' });
  f.contacts.setDraft({ ...f.scope, text: '独立当前草稿。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  await f.bridge.editCandidate({ ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId,
    text: '不受删除影响的合法用户编辑。' });
  await f.bridge.updateCorrection({ ...f.scope, correction: '用户另行明确的当前纠正。' });
  f.replies.beginExpressionPreferenceDeletion();
  assert.equal((await f.bridge.getState()).sourceAvailability, 'checking');
  f.records.failure = (request) => request.path.endsWith('/evidence')
    ? new ports.BackendRequestFailure('connection') : undefined;
  await f.replies.revalidateExpressionPreferences();
  assert.equal((await f.bridge.getState()).sourceAvailability, 'failed');
  f.records.failure = undefined;
  await f.bridge.retrySourceValidation(f.scope);
  const restored = await f.bridge.getState();
  assert.equal(restored.result?.replyRequestId, f.requestId);
  assert.equal(restored.result?.candidates[0].editedText, '不受删除影响的合法用户编辑。');
  assert.equal(restored.sourceAvailability, undefined);
  assert.equal(f.contacts.getState().draft, '独立当前草稿。');
  assert.equal(restored.correction, '用户另行明确的当前纠正。');
  assert.equal(restored.purpose, '这次只问候，不作承诺。');
  assert(f.calls.some((request) => request.path.endsWith('/evidence')));
});

test('回复消息模式经偏好复核公开重试保留已选消息、表达方向和纠正', async () => {
  const f = await historicalReplyFixture();
  const targetId = randomUUID();
  const requestJson = f.backend.requestJson;
  f.backend.requestJson = async (request) => request.path.includes('/messages?')
    ? { generation: 7, data: { messages: [{ message_id: targetId, speaker: 'contact', message_type: 'text',
      text: '合成待回复消息。', media_placeholder: null, occurred_at: '2026-10-11T01:00:00+00:00', quoted: null }], next_cursor: null } }
    : requestJson(request);
  await f.bridge.readSavedSession(f.scope);
  await f.bridge.setMode({ ...f.scope, mode: 'reply_to_message' });
  await f.bridge.selectMessage({ ...f.scope, messageId: targetId });
  await f.bridge.updateDirection({ ...f.scope, direction: '用户明确的当前表达方向。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  await f.bridge.updateCorrection({ ...f.scope, correction: '用户明确的当前纠正。' });
  f.replies.beginExpressionPreferenceDeletion();
  f.records.failure = (request) => request.path.endsWith('/evidence')
    ? new ports.BackendRequestFailure('connection') : undefined;
  await f.replies.revalidateExpressionPreferences();
  assert.equal((await f.bridge.getState()).sourceAvailability, 'failed');
  f.records.failure = undefined;
  await f.bridge.retrySourceValidation(f.scope);
  const restored = await f.bridge.getState();
  assert.equal(restored.targetMessageId, targetId);
  assert.equal(restored.direction, '用户明确的当前表达方向。');
  assert.equal(restored.correction, '用户明确的当前纠正。');
  assert.equal(restored.result?.replyRequestId, f.requestId);
  assert.equal(restored.sourceAvailability, undefined);
});

test('偏好DELETE故障后复核保留合法候选和编辑，重试沿原幂等身份', async () => {
  const f = await historicalReplyFixture(), preferenceId = randomUUID();
  let failed = true, removed = false;
  const deletes = [], requestJson = f.backend.requestJson;
  f.backend.requestJson = async (request) => {
    if (!request.path.startsWith('/api/expression-preferences')) return requestJson(request);
    if (request.method === 'DELETE') {
      deletes.push(request.body);
      if (failed) throw new ports.BackendRequestFailure('connection');
      removed = true;
      return { generation: 7, data: { state: 'deleted' } };
    }
    return { generation: 7, data: { preferences: removed ? [] : [{ preference_id: preferenceId,
      text: '仅主动聊聊适用的合成偏好。', scope: { contact_id: f.scope.contactId, reply_mode: 'initiate_conversation' },
      revision: 1, confirmed_operation_key: randomUUID(), origin: { kind: 'manual' }, source_ids: [],
      confirmed_at: '2026-10-15T01:00:00Z', updated_at: '2026-10-15T01:00:00Z' }] } };
  };
  const preferences = new ports.ExpressionPreferenceController(f.backend, f.contacts, {
    started: () => f.replies.beginExpressionPreferenceDeletion(),
    settled: () => f.replies.revalidateExpressionPreferences(),
  });
  await preferences.refresh(f.scope);
  await f.bridge.readSavedSession(f.scope);
  f.contacts.setDraft({ ...f.scope, text: '故障恢复测试的用户独立草稿。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  assert.equal((await f.bridge.getState()).result?.replyRequestId, f.requestId);
  await f.bridge.editCandidate({ ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId, text: '故障后仍保留的合法用户编辑。' });
  const remove = { ...f.scope, preferenceId, expectedRevision: 1 };
  await assert.rejects(preferences.remove(remove), /操作或核对未完成/);
  assert.equal((await f.bridge.getState()).result?.candidates[0].editedText, '故障后仍保留的合法用户编辑。');
  assert.equal((await f.bridge.getState()).phase, 'ready');
  assert.match(preferences.getState().error, /操作或核对未完成/);
  failed = false;
  await preferences.remove(remove);
  assert.deepEqual(deletes[1], deletes[0]);
  assert.deepEqual(preferences.getState().preferences, []);
  assert.equal((await f.bridge.getState()).result?.candidates[0].editedText, '故障后仍保留的合法用户编辑。');
});

test('偏好删除未决期间的新讨论读取和面板恢复不能重显偏好正文，结算后才恢复合法快照', async () => {
  const f = await historicalReplyFixture();
  const id = randomUUID(), text = '删除未决期间必须隔离的合成长期偏好。';
  f.records.saved.turns[0].reply.context_receipt.expression_preference_ids = [id];
  f.records.saved.turns[0].reply.context_receipt.expression_preferences = [{ preference_id: id,
    text, revision: 1, scope: { contact_id: null, reply_mode: null } }];
  await f.bridge.readSavedSession(f.scope);
  assert.ok(JSON.stringify(await f.bridge.getState()).includes(text));
  f.replies.beginExpressionPreferenceDeletion();
  await f.bridge.readSavedSession(f.scope);
  assert.ok(!JSON.stringify(await f.bridge.getState()).includes(text));
  f.replies.notifyHelperLifecycle('hidden');
  f.replies.notifyHelperLifecycle('focused');
  await f.bridge.readSavedSession(f.scope);
  assert.ok(!JSON.stringify(await f.bridge.getState()).includes(text));
  await f.replies.revalidateExpressionPreferences();
  await f.bridge.readSavedSession(f.scope);
  assert.ok(JSON.stringify(await f.bridge.getState()).includes(text), '删除故障时结算只恢复仍合法的权威快照。');
});
