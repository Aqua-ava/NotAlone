import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

test('补充聊天独立冻结，联系人往返恢复空输入建议', async () => {
  const f = await replyWorkspaceFixture();
  try {
    await f.bridge.updateOptions({ ...f.scope(), options: { tone: 'original', instruction: '',
      includeRelationshipContext: true, inputKind: 'workspace', workspaceAction: 'suggest',
      contextText: '对方：最近工作很累。' } });
    await f.bridge.generate({ ...f.scope(), newRequest: true, workspaceAction: 'suggest' });
    const original = f.records.calls.find(item => item.path.endsWith('/replies')).body;
    assert.equal(original.content.context_text, '对方：最近工作很累。');
    assert.equal('excluded_message_ids' in original.content, false);
    f.contacts.selectContact({ contactId: f.otherContactId, scopeRevision: f.scope().scopeRevision });
    await f.bridge.readSavedSession(f.scope());
    assert.equal(f.replies.getState().options.contextText, undefined);
    f.contacts.selectContact({ contactId: f.contactId, scopeRevision: f.scope().scopeRevision });
    await f.bridge.readSavedSession(f.scope());
    assert.equal(f.replies.getState().result?.input.workspaceAction, 'suggest');
    assert.equal(f.replies.getState().result?.input.contextText, '对方：最近工作很累。');
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

test('公开工作区入口拒绝伪造动作与已退役的排除字段', async () => {
  const f = await replyWorkspaceFixture();
  try {
    await assert.rejects(f.bridge.generate({ ...f.scope(), newRequest: true, workspaceAction: 'send' }));
    const options = { tone: 'original', instruction: '', includeRelationshipContext: true, inputKind: 'workspace' };
    // 已退役字段即使值合法也不能被接受；设置更新和生成请求都必须拒绝。
    await assert.rejects(f.bridge.updateOptions({ ...f.scope(), options: { ...options, excludedMessageIds: [randomUUID()] } }));
    await assert.rejects(f.bridge.updateOptions({ ...f.scope(), options: { ...options, excludedMessageIds: [] } }));
    await assert.rejects(f.bridge.generate({ ...f.scope(), newRequest: true, workspaceAction: 'suggest', excludedMessageIds: [] }));
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

test('历史完成候选含旧排除载荷时仍可回看，但不恢复为可比对输入', async () => {
  const f = await replyWorkspaceFixture();
  try {
    await f.bridge.generate({ ...f.scope(), newRequest: true, workspaceAction: 'suggest' });
    const original = f.records.entries[0];
    // 升级前的完成请求可能含用户主动排除的消息；回看不能因此失败，也不能当作新输入恢复。
    original.input.content.excluded_message_ids = [randomUUID()];
    f.contacts.selectContact({ contactId: f.otherContactId, scopeRevision: f.scope().scopeRevision });
    f.contacts.selectContact({ contactId: f.contactId, scopeRevision: f.scope().scopeRevision });
    await f.bridge.readSavedSession(f.scope());
    const state = f.replies.getState();
    assert.equal(state.savedSession.phase, 'ready');
    assert.equal(state.result, null, '旧排除载荷不得恢复为可比对新输入');
    const turn = state.savedSession.turns.find(item => item.inputVersionId === original.inputId);
    assert.equal(turn?.state, 'completed');
    assert.equal(turn?.reply?.candidates[0].text, '合成当前候选');
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('历史载荷含已退役排除设置时拒绝恢复且不创建请求', async () => {
  const f = await replyWorkspaceFixture();
  try {
    await f.bridge.updateOptions({ ...f.scope(), options: { tone: 'original', instruction: '',
      includeRelationshipContext: true, inputKind: 'workspace', workspaceAction: 'suggest',
      contextText: '对方：最近工作很累。' } });
    await f.bridge.generate({ ...f.scope(), newRequest: true, workspaceAction: 'suggest' });
    const original = f.records.entries[0];
    original.completed = false; original.interrupted = true;
    // 升级前的请求可能含用户主动排除的敏感消息；恢复不能按无排除项重发。
    original.input.content.excluded_message_ids = [randomUUID()];
    await f.bridge.readSavedSession(f.scope());
    assert.equal(f.replies.getState().savedSession.phase, 'ready');
    await assert.rejects(f.bridge.retryInterruptedGeneration({ ...f.scope(),
      sessionId: f.replies.getState().savedSession.sessionId,
      turnId: original.turnId, inputVersionId: original.inputId }),
    error => error.message === '旧输入使用了已退役的消息排除设置，请重新发起请求');
    assert.equal(f.records.calls.filter(item => item.path.includes('/retry-interrupted')).length, 0);
    assert.equal(f.records.entries.length, 1);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});
