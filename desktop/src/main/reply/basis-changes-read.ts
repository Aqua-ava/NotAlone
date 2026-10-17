import type { ReplyBasisChange } from '../../shared/reply-basis-change';
import { isUuid } from '../uuid';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === 'object' && !Array.isArray(value);

// 只接收无正文的变化投影；缺省字段兼容旧快照，未知结构不得作为合法回看依据。
export function readReplyBasisChanges(value: unknown): ReplyBasisChange[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 512) throw new Error('依据变化格式无效。');
  const known = new Set<string>();
  return value.map((entry: unknown) => {
    if (!isRecord(entry) || Object.keys(entry).length !== 3
      || !['evidence_id', 'kind', 'reason'].every((key) => Object.hasOwn(entry, key))
      || !isUuid(entry.evidence_id) || !['confirmed_memory', 'owner_memory', 'pending_candidate', 'reply_skill'].includes(entry.kind as string)
      || !['memory_revised', 'memory_expired', 'memory_not_yet_valid', 'memory_time_changed', 'skill_policy_changed'].includes(entry.reason as string)
      || (entry.kind === 'reply_skill') !== (entry.reason === 'skill_policy_changed')) {
      throw new Error('依据变化格式无效。');
    }
    const change: ReplyBasisChange = { evidenceId: entry.evidence_id.toLowerCase(),
      kind: entry.kind as ReplyBasisChange['kind'], reason: entry.reason as ReplyBasisChange['reason'] };
    const identity = `${change.kind}:${change.evidenceId}:${change.reason}`;
    if (known.has(identity)) throw new Error('依据变化格式无效。');
    known.add(identity);
    return change;
  });
}
