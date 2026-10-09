import type { ReplyCandidate, ReplyInputSnapshot } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 65_536 && Boolean(value.trim());
function identifiers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 512 || !value.every((item) => typeof item === 'string' && uuid.test(item))) {
    throw new Error('候选结果格式无效。');
  }
  return value.map((item: string) => item.toLowerCase());
}

// 仅调用已存在的同步生成端点；不推断异步进度或澄清对象。
export async function generateReply(backend: BackendHost, input: ReplyInputSnapshot, requestKey: string, signal: AbortSignal) {
  const response = await backend.requestJson({
    method: 'POST', path: '/api/reply/generate', timeoutMs: 25_000, signal,
    body: { contact_id: input.contactId, idempotency_key: requestKey, content: input.mode === 'rewrite_draft' ? {
      type: 'rewrite_draft', draft_text: input.draftText,
      user_instruction: input.userInstruction, include_relationship_context: input.includeRelationshipContext,
    } : {
      type: 'reply_to_message', target_message_id: input.target.messageId,
      direction: input.direction, direction_source: 'direct_input',
    } },
  });
  const value = response.data;
  if (!record(value) || typeof value.reply_request_id !== 'string' || !uuid.test(value.reply_request_id)
    || !Array.isArray(value.candidates) || value.candidates.length < 1 || value.candidates.length > 3
    || !record(value.context_receipt)) throw new Error('候选结果格式无效。');
  const known = new Set<string>();
  const candidates: ReplyCandidate[] = value.candidates.map((item: unknown) => {
    if (!record(item) || typeof item.candidate_id !== 'string' || !uuid.test(item.candidate_id)
      || !text(item.text) || !text(item.basis) || !Array.isArray(item.risk_notes) || item.risk_notes.length > 32
      || !item.risk_notes.every((note) => typeof note === 'string' && note.length <= 4096)) throw new Error('候选结果格式无效。');
    const candidateId = item.candidate_id.toLowerCase();
    if (known.has(candidateId)) throw new Error('候选结果格式无效。');
    known.add(candidateId);
    return { candidateId, text: item.text, basis: item.basis, citationIds: identifiers(item.citation_ids), riskNotes: [...item.risk_notes] };
  });
  return { generation: response.generation, replyRequestId: value.reply_request_id.toLowerCase(),
    candidates, contextEvidenceIds: identifiers(value.context_receipt.evidence_ids) };
}
