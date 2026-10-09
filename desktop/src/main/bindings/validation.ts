export { isUuid as isBindingIdentifier } from '../uuid';

// 会话定位保留自己的值规则，各调用边界仍有独立校验和固定安全错误。
export function isConversationLocator(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 4096 && !/[\u0000-\u001f]/.test(value);
}
