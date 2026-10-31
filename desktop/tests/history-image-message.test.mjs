import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';

const bundle = await build({ stdin: { contents: "export { readContactHistoryMessages } from './src/main/contact-history/messages';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false });
const { readContactHistoryMessages } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const contactId = randomUUID(), messageId = randomUUID(), fileId = randomUUID();

function message(image_media) {
  return { message_id: messageId, speaker: 'contact', message_type: 'image', text: null,
    media_placeholder: '[图片]', occurred_at: '2026-10-31T12:00:00Z', quoted: null,
    ...(image_media ? { image_media } : {}) };
}

test('聊天历史读取使用专用投影并保留原图状态和引用', async () => {
  const calls = [];
  const response = { messages: [message({ state: 'original', file_id: fileId, mime_type: 'image/png' })], next_cursor: null };
  const page = await readContactHistoryMessages({ requestJson: async input => { calls.push(input); return { generation: 7, data: response }; } },
    contactId, null, new AbortController().signal);
  assert.equal(calls[0].path, `/api/contacts/${contactId}/history-messages?limit=20`);
  assert.deepEqual(page.messages[0].imageMedia, { state: 'original', fileId, mimeType: 'image/png' });
  assert.equal(page.messages[0].mediaPlaceholder, '[图片]');
});

test('仅缩略图状态不携带可预览文件', async () => {
  const response = { messages: [message({ state: 'thumbnail_only', file_id: null, mime_type: null, error_code: 'media_thumbnail_only' })], next_cursor: null };
  const page = await readContactHistoryMessages({ requestJson: async () => ({ generation: 7, data: response }) },
    contactId, null, new AbortController().signal);
  assert.deepEqual(page.messages[0].imageMedia, { state: 'thumbnail_only', fileId: null, mimeType: null, errorCode: 'media_thumbnail_only' });
});

test('聊天历史图片投影拒绝不完整的原图身份', async () => {
  const response = { messages: [message({ state: 'original', file_id: null, mime_type: null })], next_cursor: null };
  await assert.rejects(readContactHistoryMessages({ requestJson: async () => ({ generation: 7, data: response }) },
    contactId, null, new AbortController().signal));
});
