// 本地当前不可读的说明；不把无记录表述成覆盖完整。
export function localHistoryNotice(state: 'deleted' | 'empty' | null | undefined): string | null {
  if (state === 'deleted') return '本机微信有此会话的删除记录，当前没有可读历史。历史覆盖尚未确认；收到新消息后会再次检查。';
  if (state === 'empty') return '本机微信此会话暂未保存聊天记录。历史覆盖尚未确认；收到新消息后会再次检查。';
  return null;
}
