// 本地当前不可读与同步故障分开说明；不把无记录表述成覆盖完整。
export function localHistoryNotice(state: 'deleted' | 'empty' | null | undefined): string | null {
  if (state === 'deleted') return '本机微信有此会话的删除记录，当前没有可读历史。历史覆盖尚未确认；收到新消息后会再次检查。';
  if (state === 'empty') return '本机微信此会话暂未保存聊天记录。历史覆盖尚未确认；收到新消息后会再次检查。';
  return null;
}

export function localHistoryFailureNotice(code: string | null | undefined): string | null {
  return localHistoryNotice(code === 'local_history_deleted' ? 'deleted' : code === 'local_history_empty' ? 'empty' : null);
}
