import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['src/main/backend/message-stream.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false });
const { openMessageStream } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const owner = '00000000-0000-4000-8000-000000000001';
const contact = '00000000-0000-4000-8000-000000000002';
const message = '00000000-0000-4000-8000-000000000003';
const streamId = '00000000-0000-4000-8000-000000000004';
const updatedStreamId = '00000000-0000-4000-8000-000000000005';
const invalidStreamId = '00000000-0000-4000-8000-000000000006';

function frame(type, payload = { message_id: message }, id = streamId) {
  const data = { id, type, owner_id: owner, contact_id: contact,
    occurred_at: '2026-10-31T00:00:00.000Z', payload };
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

test('消息流只向主进程交付认证过的created/updated ID事件，拒绝带额外字段的帧', async (t) => {
  let requestHeaders;
  const server = createServer((request, response) => {
    requestHeaders = request.headers;
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.write(': connected\n\n');
    response.write(frame('message.created'));
    response.write(frame('message.updated', { message_id: message }, updatedStreamId));
    response.write(frame('message.updated', { message_id: message, extra: true }, invalidStreamId));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const controller = new AbortController(), received = [];
  let connectedResolve;
  const connected = new Promise((resolve) => { connectedResolve = resolve; });
  let messagesResolve;
  const messages = new Promise((resolve) => { messagesResolve = resolve; });
  openMessageStream({ port: server.address().port, token: 'synthetic-token' }, {
    connected: connectedResolve,
    interrupted: () => {},
    message: (event) => { received.push(event); if (received.length === 2) messagesResolve(); },
  }, controller.signal);
  await connected;
  let timer;
  try { await Promise.race([messages, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SSE事件超时')), 1000); })]); }
  finally { clearTimeout(timer); }
  assert.deepEqual(received, [
    { contactId: contact, messageId: message, change: 'created' },
    { contactId: contact, messageId: message, change: 'updated' },
  ]);
  assert.equal(requestHeaders.authorization, 'Bearer synthetic-token');
  assert.equal(requestHeaders.accept, 'text/event-stream');
  controller.abort();
});
