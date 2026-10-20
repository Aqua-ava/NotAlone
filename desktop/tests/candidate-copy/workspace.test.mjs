import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { replyWorkspaceFixture } from '../fixtures/reply-workspace.mjs';

const output = await build({ entryPoints: ['src/main/candidate-copy/controller.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
const { CandidateCopyController, candidateCopyRequest } = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

// 复用公开回复桥接和真实联系人/回复会话；仅后端协议、系统剪贴板是合成边界。
async function workspaceCopyFixture(action = 'express') {
  const f = await replyWorkspaceFixture();
  if (action === 'suggest') await f.bridge.updatePurpose({ ...f.scope(), purpose: '' });
  await f.bridge.generate({ ...f.scope(), newRequest: true, workspaceAction: action });
  await f.bridge.readSavedSession(f.scope());
  assert.equal(f.replies.getState().result.input.inputKind, 'workspace');
  const state = f.replies.getState();
  const view = state.candidateVersions.items[0];
  const version = view.history.versions.find(item => item.versionId === view.displayVersionId);
  const request = { ...f.scope(), replyRequestId: state.result.replyRequestId,
    candidateId: view.candidateId, versionId: version.versionId,
    messageId: version.messages[0].messageId, hideAfterCopy: false };
  const writes = [], copied = [];
  let hidden = 0;
  const controller = new CandidateCopyController({ getConnectionGeneration: () => f.records.generation },
    f.contacts, f.replies, (identity, text) => copied.push({ identity, text }));
  const surface = { writeText: async text => { writes.push(text); }, hideWindow: () => { hidden++; } };
  const invoke = (...args) => Promise.resolve().then(() => controller.copy(candidateCopyRequest(args), surface));
  return { ...f, request, writes, copied, hidden: () => hidden, invoke };
}

for (const action of ['express', 'suggest']) test(`${action}工作区不接受缺少保存版本与消息身份的旧整组复制命令`, async () => {
  const f = await workspaceCopyFixture(action);
  try {
    const { versionId, messageId, ...legacyRequest } = f.request;
    await assert.rejects(f.invoke(legacyRequest));
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.copied, []);
    assert.equal(f.hidden(), 0);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

for (const omitted of ['versionId', 'messageId']) test(`工作区复制缺少${omitted}时在公开命令解析阶段拒绝`, async () => {
  const f = await workspaceCopyFixture();
  try {
    const incomplete = { ...f.request };
    delete incomplete[omitted];
    await assert.rejects(f.invoke(incomplete), /复制操作不可用/);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.copied, []);
    assert.equal(f.hidden(), 0);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('工作区凭完整当前版本与消息身份复制，未保存编辑不能沿旧身份复制', async () => {
  const f = await workspaceCopyFixture();
  try {
    const backendCalls = f.records.calls.length;
    await f.invoke(f.request);
    assert.deepEqual(f.writes, ['合成当前候选']);
    assert.deepEqual(f.copied, [{ identity: f.request, text: '合成当前候选' }]);
    assert.equal(f.hidden(), 0);
    assert.equal(f.records.calls.length, backendCalls);
    const state = f.replies.getState();
    const history = state.candidateVersions.items[0].history;
    const version = history.versions.find(item => item.versionId === f.request.versionId);
    await f.bridge.updateCandidateVersionDraft({ ...f.scope(), sessionId: state.savedSession.sessionId,
      candidateId: f.request.candidateId, versionId: f.request.versionId, requirements: version.requirements ?? '',
      messages: version.messages.map(message => ({ ...message, text: '合成修改尚未保存' })) });
    await assert.rejects(f.invoke(f.request), /候选版本已变化/);
    const { versionId, messageId, ...legacyRequest } = f.request;
    await assert.rejects(f.invoke(legacyRequest), /逐条复制/);
    assert.deepEqual(f.writes, ['合成当前候选']);
    assert.equal(f.copied.length, 1);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('完整字段仍须属于当前工作区联系人、版本和消息', async () => {
  const f = await workspaceCopyFixture();
  try {
    for (const invalid of [
      { ...f.request, contactId: f.otherContactId },
      { ...f.request, versionId: f.otherContactId },
      { ...f.request, messageId: f.otherContactId },
    ]) await assert.rejects(f.invoke(invalid));
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.copied, []);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('旧非工作区改写继续兼容五字段复制命令', async () => {
  const f = await workspaceCopyFixture();
  try {
    await f.bridge.updateOptions({ ...f.scope(), options: { tone: 'original', instruction: '', includeRelationshipContext: false } });
    await f.bridge.generate({ ...f.scope(), newRequest: true });
    const result = f.replies.getState().result;
    assert.equal(result.input.mode, 'rewrite_draft');
    assert.equal(result.input.inputKind, undefined);
    const request = { ...f.scope(), replyRequestId: result.replyRequestId,
      candidateId: result.candidates[0].original.candidateId, hideAfterCopy: false };
    await f.invoke(request);
    assert.deepEqual(f.writes, ['合成当前候选']);
    assert.deepEqual(f.copied, [{ identity: request, text: '合成当前候选' }]);
    assert.equal(f.hidden(), 0);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});
