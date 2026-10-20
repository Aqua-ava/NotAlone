import type { MemoryConditionsProposal } from '../../shared/memory-bridge';
import { isUuid } from '../uuid';

export function conditionProposal(value: unknown): MemoryConditionsProposal | null | undefined {
  if (value === undefined || value === null) return value;
  const invalid = () => new Error('适用条件修正不可用。');
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).length !== 2 || entry.version !== 1 || !Array.isArray(entry.items)
    || entry.items.length === 0 || entry.items.length > 8) throw invalid();
  return { version: 1, items: entry.items.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const item = value as Record<string, unknown>;
    if (Object.keys(item).length !== 2 || typeof item.text !== 'string' || !item.text.trim()
      || item.text.length > 1000 || !Array.isArray(item.evidence) || item.evidence.length > 8) throw invalid();
    return { text: item.text, evidence: item.evidence.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
      const ref = value as Record<string, unknown>;
      if (Object.keys(ref).length !== 3 || !isUuid(ref.messageId) || typeof ref.charStart !== 'number'
        || typeof ref.charEnd !== 'number' || !Number.isSafeInteger(ref.charStart) || ref.charStart < 0
        || !Number.isSafeInteger(ref.charEnd) || ref.charEnd <= ref.charStart) throw invalid();
      return { messageId: ref.messageId.toLowerCase(), charStart: ref.charStart, charEnd: ref.charEnd };
    }) };
  }) };
}
export function conditionCorrectionFields(value: MemoryConditionsProposal | null | undefined) {
  return value === undefined ? {} : { conditions: value === null ? null : { version: value.version,
    items: value.items.map(item => ({ text: item.text, evidence: item.evidence.map(ref => ({
      message_id: ref.messageId, char_start: ref.charStart, char_end: ref.charEnd })) })) } };
}
