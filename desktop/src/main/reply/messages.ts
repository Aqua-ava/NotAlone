import { isUuid } from '../uuid';
import type { ReplyMessage } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const optionalText = (value: unknown): value is string | null => value === null || (typeof value === 'string' && value.length <= 65_536);

// 最新页覆盖同 ID 的旧投影，同时保留用户已加载的历史，顺序与后端分页一致。
export function mergeReplyMessages(previous: readonly ReplyMessage[], incoming: readonly ReplyMessage[]): ReplyMessage[] {
  const messages = new Map(previous.map((message) => [message.messageId, message]));
  for (const message of incoming) messages.set(message.messageId, message);
  return [...messages.values()].sort((left, right) => {
    const leftTime = left.occurredAt === null ? -Infinity : Date.parse(left.occurredAt);
    const rightTime = right.occurredAt === null ? -Infinity : Date.parse(right.occurredAt);
    if (leftTime !== rightTime) return leftTime < rightTime ? 1 : -1;
    return left.messageId < right.messageId ? 1 : left.messageId === right.messageId ? 0 : -1;
  });
}

// 页码只来自后端游标，联系人只来自主进程已确认范围。
export async function readReplyMessages(backend: Pick<BackendHost, 'requestJson'>, contactId: string, before: string | null, signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'GET',
    path: `/api/contacts/${contactId}/messages?limit=20${before ? `&before=${before}` : ''}`,
    timeoutMs: 10_000, signal });
  const page = response.data;
  if (!record(page) || !Array.isArray(page.messages) || page.messages.length > 20
    || !(page.next_cursor === null || isUuid(page.next_cursor))) throw new Error('消息列表格式无效。');
  const known = new Set<string>();
  const messages: ReplyMessage[] = page.messages.map((item: unknown) => {
    if (!record(item) || !isUuid(item.message_id) || !['user', 'contact', 'system'].includes(item.speaker as string)
      || typeof item.message_type !== 'string' || item.message_type.length > 128
      || !optionalText(item.text) || !optionalText(item.media_placeholder)
      || !(item.occurred_at === null || (typeof item.occurred_at === 'string' && Number.isFinite(Date.parse(item.occurred_at))))
      || !(item.quoted === null || (record(item.quoted) && typeof item.quoted.text === 'string' && item.quoted.text.length <= 65_536
        && (item.quoted.target_message_id === null || isUuid(item.quoted.target_message_id))))) throw new Error('消息列表格式无效。');
    const messageId = item.message_id.toLowerCase();
    if (known.has(messageId)) throw new Error('消息列表格式无效。');
    known.add(messageId);
    return { messageId, speaker: item.speaker as ReplyMessage['speaker'], messageType: item.message_type,
      text: item.text, mediaPlaceholder: item.media_placeholder, occurredAt: item.occurred_at as string | null,
      quoted: item.quoted === null ? null : { text: item.quoted.text as string,
        targetMessageId: item.quoted.target_message_id === null ? null : (item.quoted.target_message_id as string).toLowerCase() } };
  });
  return { generation: response.generation, messages, nextCursor: page.next_cursor === null ? null : page.next_cursor.toLowerCase() };
}
