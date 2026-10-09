import { request } from 'node:http';
import type { BackendConnection } from './connection';
import { isUuid } from '../uuid';

export interface MessageCreated { contactId: string; messageId: string; }
export interface MessageStreamCallbacks {
  connected(): void;
  message(event: MessageCreated): void;
  interrupted(): void;
}

// 认证和事件正文只在主进程处理；公开回调仅提供已验证的范围标识。
export function openMessageStream(connection: BackendConnection, callbacks: MessageStreamCallbacks, signal: AbortSignal): void {
  if (signal.aborted) return;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let lines: string[] = [];
  let frameSize = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', abort);
    buffer = ''; lines = [];
    stream.destroy();
    if (!signal.aborted) callbacks.interrupted();
  };
  const abort = () => finish();
  const dispatch = () => {
    const frame = lines; lines = []; frameSize = 0;
    const eventType = frame.filter((line) => line.startsWith('event:')).at(-1)?.slice(6).trimStart();
    if (eventType !== 'message.created') return;
    const eventId = frame.filter((line) => line.startsWith('id:')).at(-1)?.slice(3).trimStart();
    const data = frame.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    try {
      const event = JSON.parse(data);
      if (!event || typeof event !== 'object' || Array.isArray(event) || !isUuid(event.id) || event.id !== eventId
        || event.type !== 'message.created' || !isUuid(event.owner_id) || !isUuid(event.contact_id)
        || typeof event.occurred_at !== 'string' || !Number.isFinite(Date.parse(event.occurred_at))
        || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)
        || !isUuid(event.payload.message_id)) return;
      callbacks.message({ contactId: event.contact_id.toLowerCase(), messageId: event.payload.message_id.toLowerCase() });
    } catch { /* 损坏帧不能成为新消息提示，也不显示原始错误。 */ }
  };
  const stream = request({ hostname: '127.0.0.1', port: connection.port, method: 'GET', path: '/api/events', agent: false,
    headers: { Authorization: `Bearer ${connection.token}`, Accept: 'text/event-stream', Connection: 'close' } }, (response) => {
    if (response.statusCode !== 200 || response.headers['content-type']?.split(';')[0].trim() !== 'text/event-stream') {
      response.destroy(); finish(); return;
    }
    if (signal.aborted || finished) { response.destroy(); return; }
    callbacks.connected();
    response.on('data', (chunk: Buffer) => {
      if (finished) return;
      try {
        buffer += decoder.decode(chunk, { stream: true });
        while (true) {
          const ending = /[\r\n]/.exec(buffer);
          if (!ending || (buffer[ending.index] === '\r' && ending.index === buffer.length - 1)) break;
          const line = buffer.slice(0, ending.index);
          const length = buffer[ending.index] === '\r' && buffer[ending.index + 1] === '\n' ? 2 : 1;
          buffer = buffer.slice(ending.index + length);
          frameSize += Buffer.byteLength(line) + length;
          if (frameSize > 16_384) { finish(); return; }
          if (!line) dispatch(); else lines.push(line);
        }
        if (frameSize + Buffer.byteLength(buffer) > 16_384) finish();
      } catch { finish(); }
    });
    response.once('end', finish); response.once('error', finish); response.once('close', finish);
  });
  signal.addEventListener('abort', abort, { once: true });
  stream.setTimeout(25_000, finish);
  stream.once('error', finish);
  stream.end();
}
