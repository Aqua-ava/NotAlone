const notices: Readonly<Record<string, string>> = {
  cli_chat_not_private: '会话类型与私聊授权不一致，已停止读取；请在联系人中核对关联。',
  cli_scope_unverified: '暂时无法确认会话属于已授权私聊，已停止读取；核验通过后再继续。',
};

export function syncScopeNotice(failureCode: string | null | undefined): string | undefined {
  return failureCode ? notices[failureCode] : undefined;
}
