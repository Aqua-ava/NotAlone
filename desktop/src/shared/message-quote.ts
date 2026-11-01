export interface MessageQuoteSnapshot {
  text: string;
  targetMessageId: string | null;
  sender?: string | null;
  senderRole?: 'owner' | 'contact' | 'unknown';
  messageType?: string | null;
  state?: 'resolved' | 'unresolved' | 'unavailable';
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 两种消息读取器共用的历史引用投影校验与字段映射。 */
export function parseMessageQuoteSnapshot(value: unknown, invalidMessage: string): MessageQuoteSnapshot | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.text !== 'string' || value.text.length > 65_536
    || !(value.target_message_id === null || typeof value.target_message_id === 'string' && uuid.test(value.target_message_id))
    || ('sender' in value && !(value.sender === null || typeof value.sender === 'string' && value.sender.length <= 65_536))
    || ('sender_role' in value && !['owner', 'contact', 'unknown'].includes(value.sender_role as string))
    || ('message_type' in value && !(value.message_type === null || typeof value.message_type === 'string' && value.message_type.length <= 128))
    || ('state' in value && !['resolved', 'unresolved', 'unavailable'].includes(value.state as string))) {
    throw new Error(invalidMessage);
  }
  return { text: value.text, targetMessageId: value.target_message_id === null ? null : (value.target_message_id as string).toLowerCase(),
    ...('sender' in value ? { sender: value.sender as string | null } : {}),
    ...('sender_role' in value ? { senderRole: value.sender_role as MessageQuoteSnapshot['senderRole'] } : {}),
    ...('message_type' in value ? { messageType: value.message_type as string | null } : {}),
    ...('state' in value ? { state: value.state as MessageQuoteSnapshot['state'] } : {}) };
}
