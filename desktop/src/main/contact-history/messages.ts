import { isUuid } from '../uuid';
import { parseMessageQuoteSnapshot } from '../../shared/message-quote';
import type { ContactHistoryImageMedia, ContactHistoryMessage } from '../../shared/contact-history-bridge';
import type { BackendHost } from '../backend/host';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const optionalText = (value: unknown): value is string | null => value === null || typeof value === 'string' && value.length <= 65_536;
const imageMimes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp']);

function imageMedia(value: unknown): ContactHistoryImageMedia {
  if (!isRecord(value) || !['pending', 'available', 'thumbnail_only', 'unavailable', 'failed', 'cleared'].includes(value.state as string)
    || !Object.hasOwn(value, 'file_id') || !Object.hasOwn(value, 'mime_type')
    || !(value.file_id === null || isUuid(value.file_id))
    || !(value.mime_type === null || typeof value.mime_type === 'string' && imageMimes.has(value.mime_type))
    || ('error_code' in value && !(value.error_code === null || typeof value.error_code === 'string' && /^[-a-z0-9_]{1,80}$/.test(value.error_code)))) {
    throw new Error('聊天图片状态无效。');
  }
  const state = value.state as ContactHistoryImageMedia['state'];
  if (state === 'available' ? value.file_id === null || value.mime_type === null : value.file_id !== null || value.mime_type !== null) {
    throw new Error('聊天图片引用无效。');
  }
  return { state, fileId: value.file_id === null ? null : (value.file_id as string).toLowerCase(), mimeType: value.mime_type as string | null,
    ...('error_code' in value ? { errorCode: value.error_code as string | null } : {}) };
}

function remainingMicroseconds(value: string | null): number {
  const fraction = value?.match(/T\d{2}:\d{2}:\d{2}\.(\d+)/)?.[1] ?? '';
  return Number(fraction.slice(3, 6).padEnd(3, '0'));
}

/** 聊天历史专用读取，图片状态不进入回复或记忆输入投影。 */
export async function readContactHistoryMessages(backend: Pick<BackendHost, 'requestJson'>, contactId: string,
  before: string | null, signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'GET',
    path: `/api/contacts/${contactId}/history-messages?limit=20${before ? `&before=${before}` : ''}`,
    timeoutMs: 10_000, signal });
  const page = response.data;
  if (!isRecord(page) || !Array.isArray(page.messages) || page.messages.length > 20
    || !(page.next_cursor === null || isUuid(page.next_cursor))) throw new Error('聊天历史格式无效。');
  const known = new Set<string>();
  const messages: ContactHistoryMessage[] = page.messages.map((item: unknown) => {
    if (!isRecord(item) || !isUuid(item.message_id) || !['user', 'contact', 'system'].includes(item.speaker as string)
      || typeof item.message_type !== 'string' || item.message_type.length > 128
      || !optionalText(item.text) || !optionalText(item.media_placeholder)
      || !(item.occurred_at === null || typeof item.occurred_at === 'string' && Number.isFinite(Date.parse(item.occurred_at)))) throw new Error('聊天消息格式无效。');
    const quoted = parseMessageQuoteSnapshot(item.quoted, '聊天消息格式无效。');
    const sqliteOrder = 'ordering' in item || 'display_position' in item;
    if (sqliteOrder && (!['verified', 'unknown'].includes(item.ordering as string)
      || typeof item.display_position !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(item.display_position))) throw new Error('聊天消息顺序无效。');
    if ('image_media' in item && item.image_media !== null && item.message_type !== 'image') throw new Error('图片状态与消息类型不符。');
    const messageId = item.message_id.toLowerCase();
    if (known.has(messageId)) throw new Error('聊天消息重复。');
    known.add(messageId);
    return { messageId, speaker: item.speaker as ContactHistoryMessage['speaker'], messageType: item.message_type,
      text: item.text, mediaPlaceholder: item.media_placeholder, occurredAt: item.occurred_at as string | null,
      ...(sqliteOrder ? { ordering: item.ordering as 'verified' | 'unknown', displayPosition: item.display_position as string } : {}),
      quoted,
      ...('image_media' in item && item.image_media !== null ? { imageMedia: imageMedia(item.image_media) } : {}) };
  });
  return { generation: response.generation, messages, nextCursor: page.next_cursor === null ? null : page.next_cursor.toLowerCase() };
}

export function mergeContactHistoryMessages(previous: readonly ContactHistoryMessage[], incoming: readonly ContactHistoryMessage[]): ContactHistoryMessage[] {
  const messages = new Map(previous.map((message) => [message.messageId, message]));
  for (const message of incoming) messages.set(message.messageId, message);
  return [...messages.values()].sort((left, right) => {
    const leftTime = left.occurredAt === null ? -Infinity : Date.parse(left.occurredAt);
    const rightTime = right.occurredAt === null ? -Infinity : Date.parse(right.occurredAt);
    if (leftTime !== rightTime) return leftTime < rightTime ? 1 : -1;
    const microseconds = remainingMicroseconds(right.occurredAt) - remainingMicroseconds(left.occurredAt);
    if (microseconds) return microseconds;
    if (left.displayPosition !== undefined && right.displayPosition !== undefined) {
      const a = BigInt(left.displayPosition), b = BigInt(right.displayPosition);
      if (a !== b) return a > b ? -1 : 1;
      return left.messageId.localeCompare(right.messageId);
    }
    return left.messageId < right.messageId ? 1 : left.messageId === right.messageId ? 0 : -1;
  });
}
