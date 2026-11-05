import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';

const bundle = await build({ stdin: { contents: "export { readContactHistoryMessages, mergeContactHistoryMessages } from './src/main/contact-history/messages';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false });
const { readContactHistoryMessages, mergeContactHistoryMessages } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const contactId = randomUUID(), messageId = randomUUID(), fileId = randomUUID();

function message(image_media) {
  return { message_id: messageId, speaker: 'contact', message_type: 'image', text: null,
    media_placeholder: '[图片]', occurred_at: '2026-10-31T12:00:00Z', quoted: null,
    ...(image_media ? { image_media } : {}) };
}

test('聊天合并按消息时间排序，后补旧记录不插入近期记录之间', () => {
  const recent = { messageId: randomUUID(), occurredAt: '2026-10-29T12:00:00Z', displayPosition: '1' };
  const old = { messageId: randomUUID(), occurredAt: '2021-10-14T12:00:00Z', displayPosition: '9007199254740993' };
  const latest = { messageId: randomUUID(), occurredAt: '2026-10-31T12:00:00Z', displayPosition: '9007199254740994' };
  assert.deepEqual(mergeContactHistoryMessages([recent, old], [latest]), [latest, recent, old]);
});

test('聊天时间相同时以精确保存位置稳定分页，未知时间排在已知时间之后', () => {
  const known = { messageId: randomUUID(), occurredAt: '2026-10-31T12:00:00.000002Z', displayPosition: '1' };
  const same = { ...known, messageId: randomUUID(), displayPosition: '9007199254740994' };
  const microsecond = { ...known, messageId: randomUUID(), occurredAt: '2026-10-31T12:00:00.000001Z', displayPosition: '9007199254740995' };
  const unknown = { ...known, messageId: randomUUID(), occurredAt: null, displayPosition: '9007199254740996' };
  assert.deepEqual(mergeContactHistoryMessages([unknown, microsecond, known], [same]), [same, known, microsecond, unknown]);
});

test('聊天历史读取使用专用投影并保留已保存图片的状态和引用', async () => {
  const calls = [];
  const response = { messages: [message({ state: 'available', file_id: fileId, mime_type: 'image/png' })], next_cursor: null };
  const page = await readContactHistoryMessages({ requestJson: async input => { calls.push(input); return { generation: 7, data: response }; } },
    contactId, null, new AbortController().signal);
  assert.equal(calls[0].path, `/api/contacts/${contactId}/history-messages?limit=20`);
  assert.deepEqual(page.messages[0].imageMedia, { state: 'available', fileId, mimeType: 'image/png' });
  assert.equal(page.messages[0].mediaPlaceholder, '[图片]');
});

test('聊天历史桥不再接受图片版本标签字段', async () => {
  for (const extra of [{ image_quality: 'thumbnail' }, { image_variant: 'main' }]) {
    const response = { messages: [message({ state: 'available', file_id: fileId, mime_type: 'image/png', ...extra })], next_cursor: null };
    const page = await readContactHistoryMessages({ requestJson: async () => ({ generation: 7, data: response }) },
      contactId, null, new AbortController().signal);
    assert.deepEqual(page.messages[0].imageMedia, { state: 'available', fileId, mimeType: 'image/png' });
  }
});

test('聊天历史桥拒绝已废弃的original图片状态', async () => {
  const response = { messages: [message({ state: 'original', file_id: fileId, mime_type: 'image/png' })], next_cursor: null };
  await assert.rejects(readContactHistoryMessages({ requestJson: async () => ({ generation: 7, data: response }) },
    contactId, null, new AbortController().signal));
});

test('仅缩略图状态不携带可预览文件', async () => {
  const response = { messages: [message({ state: 'thumbnail_only', file_id: null, mime_type: null, error_code: 'media_thumbnail_only' })], next_cursor: null };
  const page = await readContactHistoryMessages({ requestJson: async () => ({ generation: 7, data: response }) },
    contactId, null, new AbortController().signal);
  assert.deepEqual(page.messages[0].imageMedia, { state: 'thumbnail_only', fileId: null, mimeType: null, errorCode: 'media_thumbnail_only' });
});

test('聊天历史图片投影拒绝不完整的已保存图片身份', async () => {
  const response = { messages: [message({ state: 'available', file_id: null, mime_type: null })], next_cursor: null };
  await assert.rejects(readContactHistoryMessages({ requestJson: async () => ({ generation: 7, data: response }) },
    contactId, null, new AbortController().signal));
});
