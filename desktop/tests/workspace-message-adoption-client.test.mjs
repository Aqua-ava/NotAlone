import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: `export { replyRequestBody, matchesReplyAdoption } from './src/main/reply/client'; export { interruptedReplyInput } from './src/main/reply/assistant-interrupted-retry';`,
  resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { replyRequestBody, matchesReplyAdoption, interruptedReplyInput } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const snapshot = () => ({ mode: 'rewrite_draft', inputKind: 'workspace', workspaceAction: 'express',
  contactId: randomUUID(), contactDisplayName: '合成联系人', draftText: '只说明本次立场。',
  userInstruction: '保留全部要求', includeRelationshipContext: true, contextText: '用户补充的合成聊天。' });

test('workspace采用新消息只传采用身份，原要求由同版本权威输入恢复', () => {
  for (const workspaceAction of ['express', 'suggest']) {
    const input = { ...snapshot(), workspaceAction };
    const identity = { adoptNewMessageId: randomUUID(), expectedInputVersionId: randomUUID() };
    const body = replyRequestBody(input, randomUUID(), identity);
    assert.equal(body.adopt_new_message_id, identity.adoptNewMessageId);
    assert.equal(body.expected_input_version_id, identity.expectedInputVersionId);
    assert.equal(body.content.user_instruction, null);
    assert.equal(body.content.workspace_action, workspaceAction);
    assert.equal(body.content.context_text, input.contextText);
    assert.equal('excluded_message_ids' in body.content, false);
    assert.throws(() => replyRequestBody({ ...input, inputKind: 'draft' }, randomUUID(), identity));
  }
});

test('已退役的排除字段不再进入生成请求正文', () => {
  const input = { ...snapshot(), excludedMessageIds: [randomUUID()] };
  const body = replyRequestBody(input, randomUUID());
  assert.equal('excluded_message_ids' in body.content, false);
});

test('采用回读逐值核对本次补充聊天，不依赖JSON对象身份且拒绝变更', () => {
  const content = { type: 'rewrite_draft', input_kind: 'workspace', workspace_action: 'suggest',
    draft_text: '', user_instruction: null, context_text: '对方提到合成安排' };
  const submission = { contact_id: randomUUID(), idempotency_key: randomUUID(), content };
  const saved = { continuation: { message_adoption: structuredClone(submission) } };
  assert.equal(matchesReplyAdoption(saved, submission), true);
  saved.continuation.message_adoption.content.context_text = '对方提到另一安排';
  assert.equal(matchesReplyAdoption(saved, submission), false);
  saved.continuation.message_adoption.content.context_text = content.context_text;
  saved.continuation.message_adoption.content.extra_field = true;
  assert.equal(matchesReplyAdoption(saved, submission), false);
});

for (const action of ['express', 'suggest']) test(`工作区${action}中断恢复保留超过单次长度的权威累计要求`, async () => {
  const full = ['自然一点', '甲'.repeat(4096), '简短一点'].join('；');
  const turn = { input: { skill_disabled: false, skill_version_id: null, content: {
    type: 'rewrite_draft', input_kind: 'workspace', workspace_action: action,
    draft_text: action === 'suggest' ? '' : '合成本次想法', user_instruction: full,
    include_relationship_context: true } } };
  const input = await interruptedReplyInput({}, turn, { contactId: randomUUID(), displayName: '合成联系人' },
    new AbortController().signal, () => true);
  assert.equal(input.userInstruction, full);
  assert.equal(input.workspaceAction, action);
  assert.equal(Array.from(input.userInstruction).length, 4106);
  assert.deepEqual(input.skillChoice, { mode: 'auto', versionId: null });
});

test('历史工作区载荷含已退役排除设置时明确拒绝恢复', async () => {
  const turn = { input: { skill_disabled: false, skill_version_id: null, content: {
    type: 'rewrite_draft', input_kind: 'workspace', workspace_action: 'express',
    draft_text: '合成本次想法', user_instruction: null, include_relationship_context: true,
    excluded_message_ids: [randomUUID()] } } };
  const backend = { getConnectionGeneration: () => 1, requestJson: () => { throw new Error('不应调用后台'); } };
  await assert.rejects(interruptedReplyInput(backend, turn, { contactId: randomUUID(), displayName: '合成联系人' },
    new AbortController().signal, () => true),
  error => error.message === '旧输入使用了已退役的消息排除设置，请重新发起请求');
});
