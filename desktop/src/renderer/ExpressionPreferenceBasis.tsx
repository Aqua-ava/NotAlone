import type { ExpressionPreferenceReceipt, ExpressionReplyMode } from '../shared/expression-preference-bridge';

export const expressionReplyModeNames: Record<ExpressionReplyMode, string> = {
  reply_to_message: '回应消息', rewrite_draft: '改写草稿', initiate_conversation: '主动联系',
};

export function ExpressionPreferenceBasis({ preferences }: { preferences: readonly ExpressionPreferenceReceipt[] }) {
  if (!preferences.length) return null;
  return <div aria-label="生成时使用的长期表达偏好"><p>这组候选生成时使用的长期偏好，仅调整说法，不作为事实依据。</p>
    <ul>{preferences.map((item) => <li key={item.preferenceId}><p>{item.text}</p>
      <small>{item.scope.contactId ? '当前联系人' : '本人全局'} · {item.scope.replyMode ? expressionReplyModeNames[item.scope.replyMode] : '全部输入模式'} · 生成时版本{item.revision}</small>
    </li>)}</ul></div>;
}
