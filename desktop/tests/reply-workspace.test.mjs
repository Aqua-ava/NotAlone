import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyWorkspaceFixture } from './fixtures/reply-workspace.mjs';

test('帮我想想允许空输入，从旧场景原子切到统一工作区并直接给候选和理由', async () => {
  const f = await replyWorkspaceFixture();
  try {
    await f.bridge.updatePurpose({ ...f.scope(), purpose: '' });
    await f.bridge.generate({ ...f.scope(), newRequest: true, workspaceAction: 'suggest' });
    assert.equal(f.replies.getState().phase, 'ready');
    const request = f.records.calls.find(item => item.path.endsWith('/replies'));
    assert.deepEqual(request.body.content, { type: 'rewrite_draft', draft_text: '', user_instruction: null,
      input_kind: 'workspace', workspace_action: 'suggest', include_relationship_context: true });
    assert.equal(f.replies.getState().result.input.workspaceAction, 'suggest');
    assert.equal(f.replies.getState().result.candidates[0].original.basis, '用户明确本次意图');
    assert.equal(f.records.calls.some(item => item.path.endsWith('/explorations')), false);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('补充聊天与排除项独立冻结，联系人往返恢复空输入建议并可继续修改', async () => {
  const f = await replyWorkspaceFixture();
  try {
    const excluded = '10000000-0000-4000-8000-000000000099';
    await f.bridge.updateOptions({ ...f.scope(), options: { tone: 'original', instruction: '',
      includeRelationshipContext: true, inputKind: 'workspace', workspaceAction: 'suggest',
      contextText: '对方：最近工作很累。', excludedMessageIds: [excluded] } });
    await f.bridge.generate({ ...f.scope(), newRequest: true, workspaceAction: 'suggest' });
    const original = f.records.calls.find(item => item.path.endsWith('/replies')).body;
    assert.equal(original.content.context_text, '对方：最近工作很累。');
    assert.deepEqual(original.content.excluded_message_ids, [excluded]);
    f.contacts.selectContact({ contactId: f.otherContactId, scopeRevision: f.scope().scopeRevision });
    await f.bridge.readSavedSession(f.scope());
    assert.equal(f.replies.getState().options.contextText, undefined);
    f.contacts.selectContact({ contactId: f.contactId, scopeRevision: f.scope().scopeRevision });
    await f.bridge.readSavedSession(f.scope());
    assert.equal(f.replies.getState().result?.input.workspaceAction, 'suggest');
    assert.equal(f.replies.getState().result?.input.contextText, '对方：最近工作很累。');
    await f.bridge.continueSession({ ...f.scope(), sessionId: f.replies.getState().savedSession.sessionId, instruction: '简短一点' });
    assert.equal(f.replies.getState().continuation.phase, 'completed');
    assert.equal(f.replies.getState().result.input.workspaceAction, 'suggest');
    assert.deepEqual(f.replies.getState().result.input.excludedMessageIds, [excluded]);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('帮我表达要求本人想法，显式关闭关系背景及两种动作的切换均被保留', async () => {
  const f = await replyWorkspaceFixture();
  try {
    await f.bridge.updatePurpose({ ...f.scope(), purpose: '' });
    await f.bridge.generate({ ...f.scope(), newRequest: true, workspaceAction: 'express' });
    assert.equal(f.records.entries.length, 0);
    await f.bridge.updateOptions({ ...f.scope(), options: { tone: 'original', instruction: '',
      includeRelationshipContext: false, inputKind: 'workspace', contextText: '对方：周末来吗？' } });
    f.contacts.setDraft({ ...f.scope(), text: '想婉拒，不增加承诺' });
    await f.bridge.generate({ ...f.scope(), newRequest: true, workspaceAction: 'express' });
    const original = f.records.calls.find(item => item.path.endsWith('/replies')).body;
    assert.equal(original.content.draft_text, '想婉拒，不增加承诺');
    assert.equal(original.content.workspace_action, 'express');
    assert.equal(original.content.include_relationship_context, false);
    await f.bridge.generate({ ...f.scope(), newRequest: true, workspaceAction: 'suggest' });
    const latest = f.records.calls.filter(item => item.path.endsWith('/replies')).at(-1).body;
    assert.equal(latest.content.workspace_action, 'suggest');
    assert.equal(latest.content.include_relationship_context, false);
    assert.notEqual(latest.idempotency_key, original.idempotency_key);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('空输入建议的失败重试沿用原请求，中断恢复读取权威动作与补充聊天', async () => {
  const f = await replyWorkspaceFixture();
  try {
    await f.bridge.updateOptions({ ...f.scope(), options: { tone: 'original', instruction: '',
      includeRelationshipContext: true, inputKind: 'workspace', contextText: '对方：最近工作很累。' } });
    f.records.failExecution = true;
    await f.bridge.generate({ ...f.scope(), newRequest: true, workspaceAction: 'suggest' });
    assert.equal(f.replies.getState().phase, 'failed');
    await f.bridge.generate({ ...f.scope(), newRequest: false });
    assert.equal(f.replies.getState().phase, 'ready');
    const calls = f.records.calls.filter(item => item.path.endsWith('/replies'));
    assert.deepEqual(calls[0].body, calls[1].body);
    const original = f.records.entries[0]; original.completed = false; original.interrupted = true;
    await f.bridge.readSavedSession(f.scope());
    await f.bridge.retryInterruptedGeneration({ ...f.scope(), sessionId: f.replies.getState().savedSession.sessionId,
      turnId: original.turnId, inputVersionId: original.inputId });
    assert.equal(f.replies.getState().phase, 'ready');
    assert.equal(f.replies.getState().result.input.workspaceAction, 'suggest');
    assert.equal(f.replies.getState().result.input.contextText, '对方：最近工作很累。');
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('公开工作区入口拒绝伪造动作与无效排除标识', async () => {
  const f = await replyWorkspaceFixture();
  try {
    await assert.rejects(f.bridge.generate({ ...f.scope(), newRequest: true, workspaceAction: 'send' }));
    const options = { tone: 'original', instruction: '', includeRelationshipContext: true, inputKind: 'workspace' };
    await assert.rejects(f.bridge.updateOptions({ ...f.scope(), options: { ...options, excludedMessageIds: ['other-contact'] } }));
    await assert.rejects(f.bridge.updateOptions({ ...f.scope(), options: { ...options, contextText: '字'.repeat(65_537) } }));
    assert.equal(f.records.entries.length, 0);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('进入工作区原子迁移旧粘贴来话与本人方向，保持历史输入原样', async () => {
  const f = await replyWorkspaceFixture();
  try {
    await f.bridge.setMode({ ...f.scope(), mode: 'rewrite_draft' });
    f.contacts.setDraft({ ...f.scope(), text: '周末要不要过来？' });
    await f.bridge.updateOptions({ ...f.scope(), options: { tone: 'original', instruction: '自然一点',
      includeRelationshipContext: false, inputKind: 'current_chat', pastedDirection: '想婉拒，不增加承诺' } });
    await f.bridge.generate({ ...f.scope(), newRequest: true });
    await f.bridge.readSavedSession(f.scope());
    await f.bridge.enterWorkspace(f.scope());
    assert.equal(f.contacts.getState().draft, '想婉拒，不增加承诺');
    assert.equal(f.replies.getState().options.contextText, '周末要不要过来？');
    assert.equal(f.replies.getState().options.inputKind, 'workspace');
    assert.equal(f.replies.getState().options.pastedDirection, undefined);
    assert.equal(f.replies.getState().result.input.inputKind, 'current_chat');
    assert.equal(f.replies.getState().result.input.draftText, '周末要不要过来？');
    await f.bridge.enterWorkspace(f.scope());
    assert.equal(f.contacts.getState().draft, '想婉拒，不增加承诺');
    await f.bridge.generate({ ...f.scope(), newRequest: true, workspaceAction: 'express' });
    const request = f.records.calls.filter(item => item.path.endsWith('/replies')).at(-1);
    assert.equal(request.body.content.draft_text, '想婉拒，不增加承诺');
    assert.equal(request.body.content.context_text, '周末要不要过来？');
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('旧主动目的与独立表达要求迁移为本人输入，等待联系人恢复时不提前迁移', async () => {
  const f = await replyWorkspaceFixture();
  try {
    await f.bridge.updateRequirements({ ...f.scope(), requirements: '简短一点' });
    await f.bridge.enterWorkspace(f.scope());
    assert.equal(f.contacts.getState().draft, '先核对安排，不增加承诺。');
    assert.equal(f.replies.getState().options.instruction, '简短一点');
    f.contacts.selectContact({ contactId: f.otherContactId, scopeRevision: f.scope().scopeRevision });
    await assert.rejects(f.bridge.enterWorkspace(f.scope()));
    assert.equal(f.contacts.getState().draft, '');
    assert.equal(f.replies.getState().options.inputKind, undefined);
    await f.bridge.readSavedSession(f.scope());
    await f.bridge.enterWorkspace(f.scope());
    f.contacts.selectContact({ contactId: f.contactId, scopeRevision: f.scope().scopeRevision });
    await assert.rejects(f.bridge.enterWorkspace(f.scope()));
    await f.bridge.readSavedSession(f.scope());
    assert.equal(f.contacts.getState().draft, '先核对安排，不增加承诺。');
    assert.equal(f.replies.getState().options.instruction, '简短一点');
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('旧模型方向和混合补充保留原讨论，不自动变成本人草稿及无来源要求', async () => {
  const f = await replyWorkspaceFixture();
  try {
    f.records.confirmedIntent = '合成方向建议';
    await f.bridge.explore(f.scope());
    await f.bridge.readSavedSession(f.scope());
    await f.bridge.updateSupplement({ ...f.scope(), supplement: '基于旧讨论的理解补充' });
    await f.bridge.enterWorkspace(f.scope());
    assert.equal(f.contacts.getState().draft, '');
    assert.equal(f.replies.getState().options.instruction, '');
    assert.match(f.replies.getState().workspaceMigrationNotice, /历史/);
    assert.equal(f.replies.getState().purpose, '合成方向建议');
    assert.equal(f.replies.getState().requirements, '基于旧讨论的理解补充');
    assert.equal(f.replies.getState().savedSession.inputs[0].content.confirmedIntent, '合成方向建议');
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});
