import type { HistoryRecord } from './contracts.ts';

/** 展示分类沿锁定 wechat-cli 的 wxkind 映射；不改变保存类型、正文或来源资格。 */
export const messageTypeLabels = {
  text: '文字消息', image: '图片', voice: '语音', video: '视频', file: '文件', sticker: '表情包',
  quote: '引用回复', link: '链接', miniprogram: '小程序', forward_chat: '合并转发聊天记录',
  music: '音乐', channel_video: '视频号', solitaire: '接龙', pat: '拍一拍', announcement: '群公告',
  transfer: '转账', red_packet: '红包', card: '名片', location: '位置', voip: '通话记录', system: '系统消息',
  other: '其他消息（未识别）',
} as const;
export type HistoryMessageType = keyof typeof messageTypeLabels;
export interface NonTextTypeCount { messageType: Exclude<HistoryMessageType, 'text'>; label: string; count: number; }

const appTypes: Readonly<Record<string, HistoryMessageType>> = {
  '3': 'music', '5': 'link', '6': 'file', '8': 'file', '19': 'forward_chat', '24': 'file',
  '33': 'miniprogram', '36': 'miniprogram', '49': 'link', '51': 'channel_video', '53': 'solitaire',
  '57': 'quote', '62': 'pat', '76': 'music', '87': 'announcement', '2000': 'transfer', '2001': 'red_packet',
};
const otherBaseTypes: Readonly<Record<string, HistoryMessageType>> = {
  '42': 'card', '48': 'location', '50': 'voip', '10000': 'system',
};

export function displayMessageType(message: Pick<HistoryRecord, 'kind' | 'originalType'>): HistoryMessageType {
  if (message.kind !== 'other') return message.kind;
  // 用精确整数拆分，避免64位类型经过Number后把未知编码误识别成已知类型。
  if (!/^(0|[1-9]\d{0,18})$/.test(message.originalType)) return 'other';
  const value = BigInt(message.originalType);
  if (value > 9223372036854775807n) return 'other';
  const base = value & 0xffffffffn, subtype = value >> 32n;
  if (base === 49n) return appTypes[String(subtype)] ?? 'other';
  // 非应用消息按锁定wxkind的主类型展示，不把展示标签当作正文状态认证。
  return otherBaseTypes[String(base)] ?? 'other';
}

export function messagePlaceholder(type: HistoryMessageType): string | null {
  return type === 'text' ? null : type === 'sticker' ? '[表情]' : `[${messageTypeLabels[type]}]`;
}
