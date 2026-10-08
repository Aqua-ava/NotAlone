const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// 仅共享绑定边界的值规则；各调用边界保留自己的校验和固定安全错误。
export function isBindingIdentifier(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

export function isConversationLocator(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 4096 && !/[\u0000-\u001f]/.test(value);
}
