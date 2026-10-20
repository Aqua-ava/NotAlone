import type { TraceDocument, TraceRecordKind } from '../shared/trace-bridge';

export interface EvidenceMessage {
  id: string;
  text: string;
  sender: string;
  occurredAt: string | null;
  representation: string;
}
export interface MemoryEvidenceResult {
  messages: EvidenceMessage[];
  missingCount: number;
  linked: boolean;
}
function object(value: unknown): TraceDocument {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as TraceDocument : {};
}
function rows(value: unknown): TraceDocument[] { return Array.isArray(value) ? value.map(object) : []; }

// 只沿实际写入和权威候选关联取直接来源；窗口里的其他消息不是这条记忆的依据。
export function readMemoryEvidence(detail: TraceDocument, contactId: string, kind: TraceRecordKind, recordId: string): MemoryEvidenceResult {
  const empty = { messages: [], missingCount: 0, linked: false };
  if (detail.contact_id !== contactId || detail.status === 'deleted') return empty;
  const links = rows(detail.links);
  const receipts = rows(detail.write_receipts);
  const targetCandidates = new Set(receipts.filter((row) => row.record_kind === kind && row.record_id === recordId
    && row.commit_status === 'committed' && typeof row.source_candidate_id === 'string').map((row) => row.source_candidate_id as string));
  const events = rows(detail.events);
  const sourceIds = new Set<string>();
  let linked = false;
  for (const event of events) {
    if (event.stage !== 'write_result') continue;
    const payload = object(event.payload);
    if (!['committed', 'already_committed'].includes(String(payload.commit_status))) continue;
    const actual = object(payload.actual);
    if (actual.contact_id != null && actual.contact_id !== contactId) continue;
    const direct = (kind === 'candidate' ? actual.candidate_id : actual.memory_id) === recordId
      && links.some((link) => link.record_kind === kind && link.record_id === recordId && link.commit_status === 'committed');
    const throughCandidate = typeof actual.candidate_id === 'string' && targetCandidates.has(actual.candidate_id)
      && links.some((link) => link.record_kind === 'candidate' && link.record_id === actual.candidate_id && link.commit_status === 'committed');
    if (!direct && !throughCandidate) continue;
    linked = true;
    if (Array.isArray(actual.source_ids)) for (const id of actual.source_ids) if (typeof id === 'string') sourceIds.add(id);
  }
  const messages = new Map<string, EvidenceMessage>();
  const conflicts = new Set<string>();
  for (const event of events) {
    if (event.stage !== 'window') continue;
    for (const message of rows(object(event.payload).messages)) {
      const id = message.message_id;
      if (typeof id !== 'string' || !sourceIds.has(id) || typeof message.text !== 'string' || !message.text.trim()) continue;
      if (message.contact_id != null && message.contact_id !== contactId) continue;
      const next = { id, text: message.text, sender: typeof message.sender === 'string' ? message.sender : 'unknown',
        occurredAt: typeof message.occurred_at === 'string' && Number.isFinite(Date.parse(message.occurred_at)) ? message.occurred_at : null,
        representation: typeof message.text_representation === 'string' ? message.text_representation : 'unknown' };
      const previous = messages.get(id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(next)) conflicts.add(id);
      messages.set(id, next);
    }
  }
  for (const id of conflicts) messages.delete(id);
  return { messages: [...messages.values()], missingCount: sourceIds.size - messages.size, linked };
}
