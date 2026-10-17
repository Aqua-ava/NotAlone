import type { ReplyEvidenceItem } from '../../shared/reply-evidence';
import type { BackendHost } from '../backend/host';
import { isUuid } from '../uuid';
import { readCurrentStatus } from '../memory/current-status';
import { readReplyBasisChanges } from './basis-changes-read';
import { readEvidenceNavigation, readReplyRetrieval } from './retrieval-receipt-read';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 65_536;
const date = (value: unknown): value is string | null => value === null || (typeof value === 'string' && value.length <= 80 && Number.isFinite(Date.parse(value)));

// 只读持久化生成快照，不借助后来消息或资料补齐正文和时间。
export async function readReplyEvidence(backend: BackendHost, contactId: string, requestId: string, signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'GET', path: `/api/contacts/${contactId}/replies/${requestId}/evidence`, signal, timeoutMs: 10_000 });
  const value = response.data;
  if (!record(value) || !isUuid(value.reply_request_id) || value.reply_request_id.toLowerCase() !== requestId
    || !Array.isArray(value.evidence) || value.evidence.length > 256) throw new Error('依据快照格式无效。');
  const known = new Set<string>();
  const items: ReplyEvidenceItem[] = value.evidence.map((entry: unknown) => {
    if (!record(entry) || !isUuid(entry.evidence_id) || !['message', 'confirmed_memory', 'owner_memory', 'user_draft', 'user_purpose', 'continued_candidate', 'pending_candidate'].includes(entry.kind as string)
      || !text(entry.text) || !text(entry.selection_reason) || !text(entry.snapshot_status) || typeof entry.cited !== 'boolean'
      || !date(entry.valid_at) || !date(entry.invalid_at) || !record(entry.timing)
      || !date(entry.timing.recorded_at) || !date(entry.timing.source_started_at) || !date(entry.timing.source_ended_at)
      || typeof entry.timing.source_time_complete !== 'boolean') throw new Error('依据快照格式无效。');
    const evidenceId = entry.evidence_id.toLowerCase();
    if (entry.kind === 'pending_candidate' && (entry.snapshot_status !== 'pending'
      || !entry.selection_reason.startsWith('未确认候选、仅供参考、不得当作事实。'))) throw new Error('未确认依据标注无效。');
    if (known.has(evidenceId)) throw new Error('依据快照格式无效。');
    known.add(evidenceId);
    return { evidenceId, kind: entry.kind as ReplyEvidenceItem['kind'], text: entry.text, selectionReason: entry.selection_reason,
      snapshotStatus: entry.snapshot_status, cited: entry.cited, validAt: entry.valid_at, invalidAt: entry.invalid_at,
      navigation: readEvidenceNavigation(entry.navigation, evidenceId, entry.kind as ReplyEvidenceItem['kind']),
      timing: { recordedAt: entry.timing.recorded_at, sourceStartedAt: entry.timing.source_started_at,
        sourceEndedAt: entry.timing.source_ended_at, sourceTimeComplete: entry.timing.source_time_complete,
        ...readCurrentStatus(entry.timing) } };
  });
  return { generation: response.generation, items, retrieval: readReplyRetrieval(value.retrieval, items),
    ...(value.basis_changes === undefined ? {} : { basisChanges: readReplyBasisChanges(value.basis_changes) }) };
}
