import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { withHistoricalReplyHttpFixture } from './fixtures/historical-reply-basis-http.mjs';
import { ports, renderSession } from './fixtures/historical-reply-basis.mjs';

function renderCandidates(state) {
  const previous = globalThis.window;
  globalThis.window = { notalone: { candidateProvenance: {} } };
  try { return ports.renderToStaticMarkup(ports.createElement(ports.ReplyCandidates, { replies: { state, error: '' } })); }
  finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
}

async function generateWithMemory(f, kind) {
  const prepared = await f.fixture.command('historical_basis_prepare', { kind });
  const scope = await f.connect();
  f.contacts.setDraft({ ...scope, text: prepared.text });
  await f.bridge.updateOptions({ ...scope, options: { tone: 'original', instruction: '', includeRelationshipContext: true } });
  await f.fixture.plan({ count: 1, prefix: '合成历史候选', citation_ids: [prepared.memoryId] });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const state = await f.bridge.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.savedSession.phase, 'ready');
  assert.equal(state.candidateVersions.phase, 'ready');
  const sessionId = state.savedSession.sessionId;
  const candidateId = state.result.candidates[0].original.candidateId;
  return { scope, sessionId, candidateId, prepared, state };
}

for (const operation of ['generate', 'replay', 'continue']) test(`${operation}完成提交后依据修正，首次权威回读即刷新当前提醒`, { timeout: 60_000 }, async () => {
  await withHistoricalReplyHttpFixture(async (f) => {
    const original = operation === 'generate' ? undefined : await generateWithMemory(f, 'contact');
    const prepared = original?.prepared ?? await f.fixture.command('historical_basis_prepare', { kind: 'contact' });
    const scope = original?.scope ?? await f.connect();
    const sessionId = original?.sessionId ?? (await f.bridge.getState()).savedSession.sessionId;
    if (!original) {
      f.contacts.setDraft({ ...scope, text: prepared.text });
      await f.bridge.updateOptions({ ...scope, options: { tone: 'original', instruction: '', includeRelationshipContext: true } });
    }
    if (operation !== 'replay') await f.fixture.plan({ count: 1, prefix: '合成完成窗口候选', citation_ids: [prepared.memoryId] });
    if (operation === 'replay') await f.bridge.editCandidate({ ...scope,
      replyRequestId: original.state.result.replyRequestId, candidateId: original.candidateId,
      text: '同键重放前用户保留的合成编辑。' });
    const callsBefore = (await f.fixture.command('observations')).payloads.length;
    let release, reached, submitted;
    const held = new Promise((resolve) => { reached = resolve; });
    const endpoint = operation === 'continue' ? '/continue' : '/replies';
    f.delivery.after = (request) => request.method === 'POST' && request.path.endsWith(endpoint)
      ? new Promise((resolve) => { submitted = request; release = resolve; reached(); }) : undefined;
    const generating = operation === 'continue'
      ? f.bridge.continueSession({ ...scope, sessionId, instruction: '第一条简短一点', intentionUpdate: prepared.text })
      : f.bridge.generate({ ...scope, newRequest: operation === 'generate' });
    await held;
    try {
      const path = `/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`;
      const before = await f.request(path);
      const written = before.turns.find((turn) => turn.request_key === submitted.body.idempotency_key);
      assert.equal(written.state, 'completed', '先确认writer已完成，再制造HTTP交付窗口。');
      assert.deepEqual(written.basis_changes, []);
      await f.request(`/api/contacts/${scope.contactId}/memories/${prepared.memoryId}/correct`,
        { text: '合成完成后修正：喜欢轻松散步，不必作出承诺。' });
      const after = await f.request(path);
      assert.equal(after.turns.find((turn) => turn.turn_id === written.turn_id).basis_changes[0].reason, 'memory_generation_forbidden');
    } finally { release(); await generating; }
    const state = await f.bridge.getState();
    assert.equal(state.phase, 'ready');
    assert.deepEqual(state.result.basisChanges, [{ evidenceId: prepared.memoryId, kind: 'confirmed_memory', reason: 'memory_generation_forbidden' }]);
    assert.match(renderCandidates(state), /依据已纠错或失效原因不明，仅可回看，请重新生成/);
    assert.equal((await f.fixture.command('observations')).payloads.length, callsBefore + (operation === 'replay' ? 0 : 1));
    if (operation === 'replay') {
      assert.equal(state.result.replyRequestId, original.state.result.replyRequestId);
      assert.equal(state.result.candidates[0].editedText, '同键重放前用户保留的合成编辑。');
      assert.equal(state.selectedCandidateId, original.state.selectedCandidateId);
    } else if (operation === 'continue') assert.equal(state.continuation.phase, 'completed');
    await f.bridge.readSavedSession(scope);
    const modelCalls = (await f.fixture.command('observations')).payloads.length;
    await f.bridge.continueSession({ ...scope, sessionId, instruction: '第一条简短一点', intentionUpdate: prepared.text });
    assert.equal((await f.bridge.getState()).continuation.phase, 'failed', '错误依据不能经旧候选继续带入生成');
    assert.equal((await f.fixture.command('observations')).payloads.length, modelCalls);
  });
});

for (const kind of ['contact', 'owner']) test(`生产目录及公开控制器回看${kind}状态变化旧候选，明确继续采用新依据与当前意图`, { timeout: 60_000 }, async () => {
  await withHistoricalReplyHttpFixture(async (f) => {
    const generated = await generateWithMemory(f, kind);
    let scope = generated.scope;
    const { sessionId, candidateId, prepared, state: original } = generated;
    const view = original.candidateVersions.items.find((item) => item.candidateId === candidateId);
    const editedMessages = view.history.versions[0].messages.map((message) => ({ ...message, text: '用户合成编辑：愿意聊聊，先不作承诺。' }));
    await f.bridge.saveCandidateVersion({ ...scope, sessionId, candidateId, editKey: randomUUID(),
      parentVersionId: view.displayVersionId, messages: editedMessages, requirements: null });
    const editedVersionId = (await f.bridge.getState()).candidateVersions.items[0].displayVersionId;
    await f.bridge.editCandidate({ ...scope, replyRequestId: original.result.replyRequestId,
      candidateId, text: '甲当前尚未保存的合成候选编辑。' });
    const other = await f.connect(f.fixture.data.contact_ids[1]);
    f.contacts.setDraft({ ...other, text: '乙独立的草稿不受甲修正影响。' });
    const path = kind === 'contact' ? `/api/contacts/${scope.contactId}/memories/${prepared.memoryId}/correct`
      : `/api/memories/owner/${prepared.memoryId}/correct`;
    const corrected = await f.request(path, { text: '我喜欢慢慢散步，希望表达轻松自然。', change_kind: 'state_changed' });
    const freshMemoryId = corrected.memory.memory_id;
    assert.equal(f.contacts.getState().draft, '乙独立的草稿不受甲修正影响。');
    const callsBefore = (await f.fixture.command('observations')).payloads.length;
    scope = await f.connect(scope.contactId);
    await f.bridge.readSavedSession(scope);
    const changed = await f.bridge.getState();
    assert.equal(changed.savedSession.turns[0].state, 'completed');
    assert.equal(changed.savedSession.turns[0].reply.candidates[0].text, '合成历史候选（说法1）。');
    assert.match(renderSession(changed), /依据已变化/);
    assert.equal(changed.candidateVersions.items[0].history.versions.at(-1).messages[0].text, editedMessages[0].text);
    assert.equal(changed.result.candidates[0].editedText, '甲当前尚未保存的合成候选编辑。');
    assert.equal(changed.result.basisChanges[0].reason, 'memory_revised');
    assert.equal((await f.fixture.command('observations')).payloads.length, callsBefore);
    const intention = '愿意聊聊散步，希望轻松自然，先不作承诺';
    await f.fixture.plan({ count: 1, prefix: '合成重新核验候选', citation_ids: [freshMemoryId] });
    await f.bridge.continueSession({ ...scope, sessionId, instruction: '第一条简短一点', intentionUpdate: intention });
    const continued = await f.bridge.getState();
    assert.equal(continued.continuation?.phase, 'completed');
    assert.notEqual(continued.result.replyRequestId, original.result.replyRequestId);
    assert.equal(continued.result.input.draftText, intention);
    assert(continued.result.contextEvidenceIds.includes(freshMemoryId));
    assert(!continued.result.contextEvidenceIds.includes(prepared.memoryId));
    const actual = (await f.fixture.command('observations')).payloads.at(-1);
    assert.equal(actual.continuation_reference.version_id, editedVersionId);
    assert.deepEqual(actual.continuation_reference.messages.map((message) => message.text), [editedMessages[0].text]);
    assert.equal(actual.continuation_reference.basis_changes[0].reason, 'memory_revised');
    await f.bridge.loadEvidence({ ...scope, replyRequestId: continued.result.replyRequestId,
      candidateId: continued.result.candidates[0].original.candidateId });
    assert((await f.bridge.getEvidenceState()).items.some((item) => item.evidenceId === freshMemoryId));
  });
});

test('真实来源依赖过期的已选版本可回看和携入，来源删除后恢复与迟到读取不复活', { timeout: 60_000 }, async () => {
  await withHistoricalReplyHttpFixture(async (f) => {
    const { scope, sessionId, candidateId, prepared } = await generateWithMemory(f, 'source_contact');
    await f.bridge.selectCandidateVersion({ ...scope, sessionId, candidateId, versionId: candidateId, selectionKey: randomUUID() });
    await f.fixture.command('historical_basis_expire');
    await f.bridge.readSavedSession(scope);
    const changed = await f.bridge.getState();
    assert.match(renderSession(changed), /记忆有效期已结束/);
    const selected = changed.explicitCandidateSelection.selection;
    const calls = (await f.fixture.command('observations')).payloads.length;
    await f.bridge.newSavedSessionWithCandidate({ ...scope, sessionId, candidateId, versionId: candidateId,
      expectedSelectionId: selected.selectionId });
    const carried = await f.bridge.getState();
    const carriedSessionId = carried.savedSession.sessionId;
    assert.equal(carried.savedSession.inputs[0].type, 'candidate_carry');
    assert.match(renderSession(carried), /记忆有效期已结束/);
    assert.equal((await f.fixture.command('observations')).payloads.length, calls);
    let release, reached, hold = true;
    const held = new Promise((resolve) => { reached = resolve; });
    f.delivery.after = (request) => request.path.endsWith(`/assistant-sessions/${carriedSessionId}`) && hold
      ? (hold = false, new Promise((resolve) => { release = resolve; reached(); })) : undefined;
    const older = f.bridge.readSavedSession(scope);
    await held;
    try {
      await f.request(`/api/contacts/${scope.contactId}/sources/${prepared.sourceId}`, undefined, 'DELETE');
      for (let attempt = 0; attempt < 100; attempt++) {
        const source = (await f.request(`/api/contacts/${scope.contactId}/sources`)).sources.find((item) => item.source_id === prepared.sourceId);
        if (source.status === 'deleted') break;
        assert.notEqual(source.task_status, 'failed');
        assert(attempt < 99, '合成来源删除在限定轮数内完成。');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await f.bridge.readSavedSession(scope);
    } finally { release(); await older; }
    const erased = await f.bridge.getState();
    assert.equal(erased.savedSession.inputs[0].state, 'redacted');
    assert.equal(erased.savedSession.inputs[0].content, null);
    assert(!renderSession(erased).includes('合成历史候选（说法1）。'));
    await f.bridge.selectSavedSession({ ...scope, sessionId });
    assert.equal((await f.bridge.getState()).savedSession.turns[0].state, 'redacted');
    await f.bridge.readSavedSession(scope);
    assert(!JSON.stringify(await f.bridge.getState()).includes('合成历史候选（说法1）。'));
  });
});
