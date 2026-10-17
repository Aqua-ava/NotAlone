import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const bundled = await build({ entryPoints: ['src/main/reply/assistant-session-projection.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false });
const { AssistantSessionProjection } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const scope = { connectionGeneration: 7, contactId: 'contact-a', scopeRevision: 3, sessionId: 'session-a' };
const identity = { requestKey: 'request-a', inputVersionId: 'input-a', replyRequestId: 'reply-a' };
function completed() {
  return { generation: 7, sessionId: 'session-a', currentInputVersionId: 'input-a',
    turns: [{ turnId: 'turn-a', inputVersionId: 'input-a', requestKey: 'request-a', state: 'completed',
      input: { content: { type: 'rewrite_draft', draft_text: '合成草稿' } },
      reply: { replyRequestId: 'reply-a', candidates: [], contextEvidenceIds: [] },
      interruptionReason: null, placeholder: null }],
    inputs: [{ inputVersionId: 'input-a', turnId: 'turn-a', state: 'active', type: 'generation',
      conversationBindingId: 'synthetic-binding', content: null, placeholder: null }] };
}
function display(snapshot) { return { phase: 'ready', sessionId: snapshot.sessionId,
  currentInputVersionId: snapshot.currentInputVersionId, turns: snapshot.turns, inputs: snapshot.inputs }; }
test('较新的同CURRENT完整读取成为完成结果依据并保留新的basisChanges', () => {
  const projection = new AssistantSessionProjection();
  projection.registerDisplay(scope, display(completed()), 'authoritative');
  const verification = projection.beginVerification(scope);
  const newer = completed();
  newer.turns[0].basisChanges = [{ evidenceId: 'new-basis', kind: 'confirmed_memory', reason: 'memory_revised' }];
  projection.registerDisplay(scope, display(newer), 'authoritative');
  const decision = projection.acceptCompletion(verification, completed(), identity);
  assert.equal(decision.kind, 'accepted');
  assert.deepEqual(decision.turn.basisChanges, [{ evidenceId: 'new-basis', kind: 'confirmed_memory', reason: 'memory_revised' }]);
  assert.equal(decision.snapshot.turns, newer.turns);
});

test('较晚loading读取挡住旧完成，较早loading允许完成接管', () => {
  const projection = new AssistantSessionProjection();
  projection.registerDisplay(scope, { ...display(completed()), phase: 'loading', turns: [], inputs: [] });
  const earlierLoading = projection.beginVerification(scope);
  assert.equal(projection.acceptCompletion(earlierLoading, completed(), identity).kind, 'accepted');
  const beforeLoading = projection.beginVerification(scope);
  projection.registerDisplay(scope, { ...display(completed()), phase: 'loading', turns: [], inputs: [] });
  assert.equal(projection.acceptCompletion(beforeLoading, completed(), identity).kind, 'superseded');
});

test('较新的完整读取接纳后旧读取及其失败不能覆盖它', () => {
  const projection = new AssistantSessionProjection();
  projection.registerDisplay(scope, display(completed()), 'authoritative');
  const oldRead = projection.beginRead(scope);
  const newRead = projection.beginRead(scope);
  assert.equal(projection.acceptRead(newRead, completed()).kind, 'accepted');
  assert.equal(projection.acceptRead(oldRead, completed()).kind, 'superseded');
  assert.equal(projection.failRead(oldRead, 'unknown').kind, 'superseded');
});

const budgetIdentity = { turnId: 'turn-a', requestKey: 'request-a', inputVersionId: 'input-a' };
function budgetFailed() { const saved = completed(); saved.turns[0] = { ...saved.turns[0], state: 'failed', reply: null }; return saved; }
test('预算失败必须匹配回执轮次及有效输入的turn关联，更新同CURRENT完整视图仍可接受', () => {
  const projection = new AssistantSessionProjection();
  projection.registerDisplay(scope, display(budgetFailed()), 'authoritative');
  const verification = projection.beginVerification(scope);
  const newer = budgetFailed();
  newer.turns.push({ ...newer.turns[0], turnId: 'history-turn', inputVersionId: 'history-input', requestKey: 'history-request' });
  newer.inputs.push({ ...newer.inputs[0], inputVersionId: 'history-input', turnId: 'history-turn' });
  projection.registerDisplay(scope, display(newer), 'authoritative');
  const evidence = { kind: 'received', identity: budgetIdentity, read: { kind: 'snapshot', snapshot: budgetFailed() } };
  const decision = projection.acceptBudgetFailure(verification, evidence);
  assert.equal(decision.kind, 'accepted');
  assert.equal(decision.snapshot.inputs.length, 2);
  const wrong = budgetFailed(); wrong.inputs[0].turnId = 'other-turn';
  assert.equal(projection.acceptBudgetFailure(projection.beginVerification(scope),
    { ...evidence, read: { kind: 'snapshot', snapshot: wrong } }).kind, 'unavailable');
});

test('来源确认不可读与暂时无法核验分开，来源失效后旧读取和旧完成均失效', () => {
  const projection = new AssistantSessionProjection();
  projection.registerDisplay(scope, display(budgetFailed()), 'authoritative');
  const verification = projection.beginVerification(scope);
  assert.deepEqual(projection.acceptBudgetFailure(verification,
    { kind: 'received', identity: budgetIdentity, read: { kind: 'unknown' } }), { kind: 'unknown' });
  assert.deepEqual(projection.acceptBudgetFailure(verification,
    { kind: 'unconfirmed', read: { kind: 'unavailable' } }), { kind: 'unavailable', reason: 'source' });
  const read = projection.beginRead(scope);
  projection.invalidateSource();
  assert.equal(projection.acceptRead(read, completed()).kind, 'superseded');
  assert.equal(projection.acceptCompletion(verification, completed(), identity).kind, 'superseded');
});

test('首次default读取绑定实际SID后仍能继续恢复，切到其他SID则失效', () => {
  const projection = new AssistantSessionProjection();
  projection.registerDisplay({ ...scope, sessionId: null }, { phase: 'loading', sessionId: null,
    turns: [], inputs: [], currentInputVersionId: null });
  let read = projection.beginRead({ ...scope, sessionId: null });
  read = projection.resolveReadSession(read, 'session-a');
  const decision = projection.acceptRead(read, completed());
  assert.equal(decision.kind, 'accepted');
  projection.registerDisplay(scope, decision.snapshot, 'authoritative');
  read = decision.read;
  assert.equal(projection.isReadCurrent(read), true);
  projection.registerDisplay({ ...scope, sessionId: 'session-b' }, { ...display(completed()), sessionId: 'session-b' }, 'authoritative');
  assert.equal(projection.isReadCurrent(read), false);
});

for (const changed of [{ connectionGeneration: 8 }, { contactId: 'contact-b' }, { scopeRevision: 4 }, { sessionId: 'session-b' }]) {
  test('范围改变后旧完成不能发布：' + Object.keys(changed)[0], () => {
    const projection = new AssistantSessionProjection();
    projection.registerDisplay(scope, display(completed()), 'authoritative');
    const verification = projection.beginVerification(scope);
    projection.registerDisplay({ ...scope, ...changed }, display(completed()), 'authoritative');
    assert.equal(projection.acceptCompletion(verification, completed(), identity).kind, 'superseded');
  });
}

test('较晚loading优先于旧复验缺少完成轮次，不能误判为需要替代读取', () => {
  const projection = new AssistantSessionProjection();
  projection.registerDisplay(scope, display(completed()), 'authoritative');
  const verification = projection.beginVerification(scope);
  projection.registerDisplay(scope, { ...display(completed()), phase: 'loading', turns: [], inputs: [] });
  const stale = { ...completed(), turns: [], inputs: [], currentInputVersionId: null };
  assert.equal(projection.acceptCompletion(verification, stale, identity).kind, 'superseded');
});

test('普通状态通知不推进展示代次，完整快照更新会终止旧读取的后续恢复', () => {
  const projection = new AssistantSessionProjection();
  projection.registerDisplay(scope, display(completed()), 'authoritative');
  const read = projection.beginRead(scope);
  projection.registerDisplay(scope);
  assert.equal(projection.isReadCurrent(read), true);
  const accepted = projection.acceptRead(read, completed());
  assert.equal(accepted.kind, 'accepted');
  assert.equal(projection.isReadCurrent(accepted.read), true);
  const newer = completed(); newer.currentInputVersionId = 'input-b';
  projection.registerDisplay(scope, display(newer), 'authoritative');
  assert.equal(projection.isReadCurrent(accepted.read), false);
  assert.equal(projection.failRead(accepted.read, 'unknown').kind, 'superseded');
});

test('同CURRENT的预算轮次缺少实际回执不能发布预算结论，较晚loading保持优先', () => {
  const projection = new AssistantSessionProjection();
  projection.registerDisplay(scope, display(budgetFailed()), 'authoritative');
  const verification = projection.beginVerification(scope);
  assert.equal(projection.acceptBudgetFailure(verification,
    { kind: 'unconfirmed', read: { kind: 'snapshot', snapshot: budgetFailed() } }).kind, 'unavailable');
  projection.registerDisplay(scope, { ...display(budgetFailed()), phase: 'loading', turns: [], inputs: [] });
  assert.equal(projection.acceptBudgetFailure(verification,
    { kind: 'received', identity: budgetIdentity, read: { kind: 'snapshot', snapshot: budgetFailed() } }).kind, 'superseded');
});

test('来源投影只续接本次完整读取，其余旧票据及较晚读取不能被接管', () => {
  const projection = new AssistantSessionProjection();
  projection.registerDisplay(scope, display(completed()), 'authoritative');
  const read = projection.beginRead(scope);
  const owner = projection.invalidateSource(read);
  projection.registerDisplay(scope, { ...display(completed()), turns: [], inputs: [] });
  const checked = display(completed());
  projection.registerDisplay(scope, checked, 'authoritative');
  const resumed = projection.acceptSourceProjection(owner, checked);
  assert.equal(projection.isReadCurrent(resumed), true);
  assert.equal(projection.isReadCurrent(read), false);
  projection.beginRead(scope);
  assert.equal(projection.acceptSourceProjection(owner, checked), undefined);
});
