import type { CandidateCopyRequest } from '../../shared/candidate-copy-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import type { ReplySession } from '../reply/session';
import type { ReplyCandidateSelection } from '../../shared/reply-bridge';
import { isUuid } from '../uuid';

export interface CandidateCopySurface {
  writeText(text: string): Promise<void>;
  hideWindow(): void;
}

export function candidateCopyRequest(args: unknown[]): CandidateCopyRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('复制操作不可用。');
  const data = value as Record<string, unknown>;
  const keys = ['contactId', 'scopeRevision', 'replyRequestId', 'candidateId', 'hideAfterCopy'];
  if (Object.keys(data).length !== keys.length || !Object.keys(data).every((key) => keys.includes(key))
    || !isUuid(data.contactId) || !isUuid(data.replyRequestId) || !isUuid(data.candidateId)
    || typeof data.scopeRevision !== 'number' || !Number.isSafeInteger(data.scopeRevision) || data.scopeRevision < 0
    || typeof data.hideAfterCopy !== 'boolean') throw new Error('复制操作不可用。');
  return { contactId: data.contactId.toLowerCase(), scopeRevision: data.scopeRevision,
    replyRequestId: data.replyRequestId.toLowerCase(), candidateId: data.candidateId.toLowerCase(), hideAfterCopy: data.hideAfterCopy };
}

// 渲染层只提交候选身份；复制文本从本次主进程编辑状态取得，不长期保存。
export class CandidateCopyController {
  private copying = false;
  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession, private readonly replies: ReplySession,
    private readonly onCopied?: (selection: ReplyCandidateSelection, text: string) => void) {}

  private currentCandidate(request: CandidateCopyRequest) {
    const contact = this.contacts.getState();
    const reply = this.replies.getState();
    const candidate = reply.result?.candidates.find((item) => item.original.candidateId === request.candidateId);
    if (this.backend.getConnectionGeneration() === undefined || contact.selectedContactId !== request.contactId
      || contact.scopeRevision !== request.scopeRevision || !['ready', 'loading'].includes(contact.directoryPhase)
      || reply.contactId !== request.contactId || reply.scopeRevision !== request.scopeRevision
      || reply.result?.replyRequestId !== request.replyRequestId || reply.selectedCandidateId !== request.candidateId
      || reply.phase === 'waiting' || reply.sourceAvailability !== undefined || !candidate || !candidate.editedText.trim()) throw new Error('本次候选已变化，请重新确认。');
    return candidate;
  }
  async copy(request: CandidateCopyRequest, surface: CandidateCopySurface): Promise<void> {
    if (this.copying) throw new Error('复制仍在处理中。');
    const candidate = this.currentCandidate(request);
    const text = candidate.editedText;
    const generation = this.backend.getConnectionGeneration();
    this.copying = true;
    try {
      await surface.writeText(text);
      if (generation !== this.backend.getConnectionGeneration() || this.currentCandidate(request).editedText !== text) {
        throw new Error('本次候选已变化，请重新确认。');
      }
      this.onCopied?.(request, text);
      if (request.hideAfterCopy) surface.hideWindow();
    } catch { throw new Error('复制未确认，请保留编辑文本并重试。'); }
    finally { this.copying = false; }
  }
}
