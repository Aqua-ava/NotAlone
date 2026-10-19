import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: `export { replyRequestBody, matchesReplyAdoption } from './src/main/reply/client'; export { interruptedReplyInput } from './src/main/reply/assistant-interrupted-retry';`,
  resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { replyRequestBody, matchesReplyAdoption, interruptedReplyInput } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const snapshot = () => ({ mode: 'rewrite_draft', inputKind: 'workspace', workspaceAction: 'express',
  contactId: randomUUID(), contactDisplayName: '合成联系人', draftText: '只说明本次立场。',
  userInstruction: '保留全部要求', includeRelationshipContext: true, contextText: '用户补充的合成聊天。',
  excludedMessageIds: [randomUUID()] });

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
    assert.deepEqual(body.content.excluded_message_ids, input.excludedMessageIds);
    assert.throws(() => replyRequestBody({ ...input, inputKind: 'draft' }, randomUUID(), identity));
  }
});

test('采用回读逐值核对排除消息数组，不依赖JSON对象身份且拒绝变更', () => {
  const content = { type: 'rewrite_draft', input_kind: 'workspace', workspace_action: 'suggest',
    draft_text: '', user_instruction: null, excluded_message_ids: [randomUUID(), randomUUID()] };
  const submission = { contact_id: randomUUID(), idempotency_key: randomUUID(), content };
  const saved = { continuation: { message_adoption: structuredClone(submission) } };
  assert.equal(matchesReplyAdoption(saved, submission), true);
  saved.continuation.message_adoption.content.excluded_message_ids[0] = randomUUID();
  assert.equal(matchesReplyAdoption(saved, submission), false);
  saved.continuation.message_adoption.content.excluded_message_ids = [...content.excluded_message_ids, randomUUID()];
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
