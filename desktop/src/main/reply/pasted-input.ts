// 历史与中断恢复必须保留输入来历，不能把对方原文恢复成本人草稿。
export function pastedInputFields(value: Record<string, unknown>): { inputKind?: 'current_chat'; pastedDirection?: string } {
  if (value.input_kind === undefined || value.input_kind === 'draft') {
    if (value.pasted_direction !== undefined && value.pasted_direction !== null) throw new Error('历史输入来历无效。');
    return {};
  }
  if (value.input_kind !== 'current_chat' || typeof value.pasted_direction !== 'string'
    || !value.pasted_direction.trim() || value.pasted_direction.length > 4096) throw new Error('历史输入来历无效。');
  return { inputKind: 'current_chat', pastedDirection: value.pasted_direction };
}
