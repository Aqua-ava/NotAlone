import type { ExpressionPreference, ExpressionPreferenceReceipt, ExpressionReplyMode } from '../../shared/expression-preference-bridge';
import { isUuid } from '../uuid';

export function readExpressionPreferenceReceipt(value: unknown): ExpressionPreferenceReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('长期偏好格式无效。');
  const row = value as Record<string, unknown>;
  const scope = row.scope as Record<string, unknown> | undefined;
  if (!isUuid(row.preference_id) || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 512
    || !scope || typeof scope !== 'object' || Array.isArray(scope)
    || scope.contact_id !== null && !isUuid(scope.contact_id)
    || scope.reply_mode !== null && !['reply_to_message', 'rewrite_draft', 'initiate_conversation'].includes(scope.reply_mode as string)
    || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1) throw new Error('长期偏好格式无效。');
  return { preferenceId: row.preference_id.toLowerCase(), text: row.text,
    scope: { contactId: scope.contact_id === null ? null : (scope.contact_id as string).toLowerCase(),
      replyMode: scope.reply_mode as ExpressionReplyMode | null }, revision: row.revision as number };
}

export function readExpressionPreference(value: unknown): ExpressionPreference {
  const receipt = readExpressionPreferenceReceipt(value);
  const row = value as Record<string, unknown>;
  const origin = row.origin as Record<string, unknown> | undefined;
  if (!isUuid(row.confirmed_operation_key)
    || !origin || !['manual', 'message'].includes(origin.kind as string)
    || origin.kind === 'message' && !isUuid(origin.id)
    || !Array.isArray(row.source_ids) || !row.source_ids.every(isUuid)
    || typeof row.confirmed_at !== 'string' || !Number.isFinite(Date.parse(row.confirmed_at))
    || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) throw new Error('长期偏好格式无效。');
  return { ...receipt,
    confirmedOperationKey: row.confirmed_operation_key.toLowerCase(),
    origin: origin.kind === 'manual' ? { kind: 'manual' } : { kind: 'message', id: (origin.id as string).toLowerCase() },
    sourceIds: row.source_ids as string[], confirmedAt: row.confirmed_at, updatedAt: row.updated_at };
}
