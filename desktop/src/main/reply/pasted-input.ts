import type { RewriteSnapshot } from '../../shared/reply-bridge';
import { isUuid } from '../uuid';
// 历史与中断恢复必须保留输入来历，不能把对方原文恢复成本人草稿。
export function pastedInputFields(value: Record<string, unknown>): Pick<RewriteSnapshot, 'inputKind' | 'pastedDirection' | 'workspaceAction' | 'contextText' | 'excludedMessageIds'> {
  if (value.input_kind === 'workspace') {
    if (!['express', 'suggest'].includes(value.workspace_action as string)
      || value.pasted_direction != null
      || value.context_text != null && (typeof value.context_text !== 'string' || value.context_text.length > 65_536)
      || value.excluded_message_ids != null && (!Array.isArray(value.excluded_message_ids)
        || value.excluded_message_ids.length > 500 || !value.excluded_message_ids.every(isUuid)
        || new Set(value.excluded_message_ids.map((id: string) => id.toLowerCase())).size !== value.excluded_message_ids.length)) {
      throw new Error('历史工作区输入无效。');
    }
    return { inputKind: 'workspace', workspaceAction: value.workspace_action as 'express' | 'suggest',
      ...(typeof value.context_text === 'string' ? { contextText: value.context_text } : {}),
      ...(Array.isArray(value.excluded_message_ids) ? { excludedMessageIds: value.excluded_message_ids.map((id: string) => id.toLowerCase()) } : {}) };
  }
  if (value.input_kind === undefined || value.input_kind === 'draft') {
    if (value.pasted_direction !== undefined && value.pasted_direction !== null) throw new Error('历史输入来历无效。');
    return {};
  }
  if (value.input_kind !== 'current_chat' || typeof value.pasted_direction !== 'string'
    || !value.pasted_direction.trim() || value.pasted_direction.length > 4096) throw new Error('历史输入来历无效。');
  return { inputKind: 'current_chat', pastedDirection: value.pasted_direction };
}
