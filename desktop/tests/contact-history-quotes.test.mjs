import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';

const bundle = await build({ stdin: { contents: `
  export { readContactHistoryMessages, mergeContactHistoryMessages } from './src/main/contact-history/messages';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { readContactHistoryMessages, mergeContactHistoryMessages } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const contactId = randomUUID();
const messageId = randomUUID();
const targetMessageId = randomUUID();
const wire = (quote) => ({ message_id: messageId, speaker: 'user', message_type: 'text',
  text: '这是本次回复正文', media_placeholder: null, occurred_at: '2026-11-01T01:02:03.000Z', quoted: quote });
const backend = (messages) => ({ requestJson: async () => ({ generation: 4, data: { messages, next_cursor: null } }) });

test('联系人历史读取保留引用快照元数据，回复正文独立且同 ID 新页面可补齐引用', async () => {
  const before = await readContactHistoryMessages(backend([wire({ text: '[引用内容不可用]', target_message_id: targetMessageId,
    sender: '合成联系人甲', sender_role: 'contact', message_type: 'text', state: 'unavailable' })]),
  contactId, null, new AbortController().signal);
  const oldMessage = before.messages[0];
  assert.equal(oldMessage.text, '这是本次回复正文');
  assert.deepEqual(oldMessage.quoted, { text: '[引用内容不可用]', targetMessageId, sender: '合成联系人甲',
    senderRole: 'contact', messageType: 'text', state: 'unavailable' });

  const after = await readContactHistoryMessages(backend([wire({ text: '被补齐的引用快照', target_message_id: targetMessageId,
    sender: '合成联系人甲', sender_role: 'contact', message_type: 'text', state: 'resolved' })]),
  contactId, null, new AbortController().signal);
  const merged = mergeContactHistoryMessages(before.messages, after.messages);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].messageId, messageId);
  assert.equal(merged[0].text, '这是本次回复正文');
  assert.equal(merged[0].quoted.text, '被补齐的引用快照');
  assert.equal(merged[0].quoted.state, 'resolved');
});

test('联系人历史保留引用作者和类型，不把引用快照当成当前消息正文', async () => {
  const page = await readContactHistoryMessages(backend([wire({ text: '回复上下文中的原话', target_message_id: targetMessageId,
    sender: null, sender_role: 'owner', message_type: 'image', state: 'resolved' })]),
  contactId, null, new AbortController().signal);
  assert.equal(page.messages[0].text, '这是本次回复正文');
  assert.deepEqual(page.messages[0].quoted, { text: '回复上下文中的原话', targetMessageId, sender: null,
    senderRole: 'owner', messageType: 'image', state: 'resolved' });
});

test('旧引用字段继续兼容，非法作者角色或引用状态会被拒绝', async () => {
  for (const reader of [readContactHistoryMessages]) {
    const legacy = await reader(backend([wire({ text: '旧版引用快照', target_message_id: targetMessageId })]),
      contactId, null, new AbortController().signal);
    assert.deepEqual(legacy.messages[0].quoted, { text: '旧版引用快照', targetMessageId });
    for (const invalid of [
      { sender_role: 'assistant' },
      { state: 'guessed' },
      { message_type: 9 },
    ]) {
      await assert.rejects(reader(backend([wire({ text: '格式错误', target_message_id: targetMessageId, ...invalid })]),
        contactId, null, new AbortController().signal));
    }
  }
});
