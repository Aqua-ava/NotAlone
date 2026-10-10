import type { ReplyCandidate, ReplyUsedSkill } from '../../shared/reply-bridge';
import { isUuid } from '../uuid';

export const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 65_536 && Boolean(value.trim());
function identifiers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 512 || !value.every(isUuid)) throw new Error('候选结果格式无效。');
  return value.map((item: string) => item.toLowerCase());
}

function readUsedSkill(value: unknown): ReplyUsedSkill | null {
  if (value === null) return null;
  if (!isRecord(value) || !isUuid(value.skill_id) || !isUuid(value.version_id) || !text(value.name)
    || (value.load_state !== 'loaded' && value.load_state !== 'resource_failed')) throw new Error('候选实际策略格式无效。');
  return { name: value.name, versionId: value.version_id.toLowerCase(), loadState: value.load_state };
}

export function readReplyResult(value: unknown) {
  if (!isRecord(value) || !isUuid(value.reply_request_id) || !Array.isArray(value.candidates)
    || value.candidates.length < 1 || value.candidates.length > 3 || !isRecord(value.context_receipt)) throw new Error('候选结果格式无效。');
  const known = new Set<string>();
  const candidates: ReplyCandidate[] = value.candidates.map((item: unknown) => {
    if (!isRecord(item) || !isUuid(item.candidate_id) || !text(item.text) || !text(item.basis)
      || !Array.isArray(item.risk_notes) || item.risk_notes.length > 32
      || !item.risk_notes.every((note) => typeof note === 'string' && note.length <= 4096)) throw new Error('候选结果格式无效。');
    const candidateId = item.candidate_id.toLowerCase();
    if (known.has(candidateId)) throw new Error('候选结果格式无效。');
    known.add(candidateId);
    return { candidateId, text: item.text, basis: item.basis, citationIds: identifiers(item.citation_ids), riskNotes: [...item.risk_notes] };
  });
  const contextEvidenceIds = identifiers(value.context_receipt.evidence_ids);
  const styleSampleIds = identifiers(value.context_receipt.style_sample_ids ?? []);
  if (styleSampleIds.length > 5 || new Set(styleSampleIds).size !== styleSampleIds.length
    || styleSampleIds.some((id) => contextEvidenceIds.includes(id))) throw new Error('表达参考格式无效。');
  return { replyRequestId: value.reply_request_id.toLowerCase(), candidates, contextEvidenceIds, styleSampleIds,
    ...(value.used_skill === undefined ? {} : { usedSkill: readUsedSkill(value.used_skill) }) };
}
