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
  const messageCopy = 'versionId' in data || 'messageId' in data;
  const keys = ['contactId', 'scopeRevision', 'replyRequestId', 'candidateId', 'hideAfterCopy',
    ...(messageCopy ? ['versionId', 'messageId'] : [])];
  if (Object.keys(data).length !== keys.length || !Object.keys(data).every((key) => keys.includes(key))
    || !isUuid(data.contactId) || !isUuid(data.replyRequestId) || !isUuid(data.candidateId)
    || typeof data.scopeRevision !== 'number' || !Number.isSafeInteger(data.scopeRevision) || data.scopeRevision < 0
    || typeof data.hideAfterCopy !== 'boolean') throw new Error('复制操作不可用。');
  const selection = { contactId: data.contactId.toLowerCase(), scopeRevision: data.scopeRevision,
    replyRequestId: data.replyRequestId.toLowerCase(), candidateId: data.candidateId.toLowerCase(), hideAfterCopy: data.hideAfterCopy };
  if (!messageCopy) return selection;
  if (!isUuid(data.versionId) || !isUuid(data.messageId)) throw new Error('复制操作不可用。');
  return { ...selection, versionId: data.versionId.toLowerCase(), messageId: data.messageId.toLowerCase() };
}

// 渲染层只提交身份；策略消息正文来自主进程已核对的完成轮和明确选择版本。
export class CandidateCopyController {
  private copying = false;
  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession, private readonly replies: ReplySession,
    private readonly onCopied?: (selection: ReplyCandidateSelection, text: string) => void) {}

  private currentText(request: CandidateCopyRequest): string {
    const contact = this.contacts.getState();
    const reply = this.replies.getState();
    const currentSessionId = reply.savedSession?.sessionId ?? reply.result?.assistantSessionId;
    const deletionBlocksCopy = reply.sessionDeletion === 'deleting' || reply.sessionDeletion === 'failed'
      || (reply.sessionDeletion === 'deleted' || reply.sessionDeletion === 'missing')
      && (!reply.confirmedSessionDeletion || reply.confirmedSessionDeletion.sessionId === currentSessionId);
    if (this.backend.getConnectionGeneration() === undefined || contact.selectedContactId !== request.contactId
      || contact.scopeRevision !== request.scopeRevision || !['ready', 'loading'].includes(contact.directoryPhase)
      || reply.contactId !== request.contactId || reply.scopeRevision !== request.scopeRevision
      || reply.phase === 'waiting' || reply.sourceAvailability !== undefined
      || deletionBlocksCopy) throw new Error('本次候选已变化，请重新确认。');
    if (request.versionId === undefined && request.messageId === undefined) {
      if (reply.result?.input.mode !== 'rewrite_draft') throw new Error('请明确选择消息组版本后逐条复制。');
      const candidate = reply.result?.candidates.find((item) => item.original.candidateId === request.candidateId);
      if (reply.result?.replyRequestId !== request.replyRequestId || reply.selectedCandidateId !== request.candidateId
        || !candidate?.editedText.trim()) throw new Error('本次候选已变化，请重新确认。');
      return candidate.editedText;
    }
    const versions = reply.candidateVersions;
    const chosen = reply.explicitCandidateSelection;
    const view = versions?.items.find((item) => item.candidateId === request.candidateId);
    const history = view?.history;
    const saved = reply.savedSession;
    if (!isUuid(request.versionId) || !isUuid(request.messageId)
      || versions?.phase !== 'ready' || view?.phase !== 'ready'
      || chosen?.phase !== 'ready' || !chosen.selection
      || chosen.selection.candidateId !== request.candidateId || chosen.selection.versionId !== request.versionId
      || saved?.phase !== 'ready' || !history || history.candidateId !== request.candidateId
      || versions.sessionId !== saved.sessionId || history.sessionId !== saved.sessionId
      || chosen.selection.sessionId !== saved.sessionId || view.displayVersionId !== request.versionId) {
      throw new Error('本次候选版本已变化，请重新确认。');
    }
    const turn = saved.turns.find((item) => item.turnId === history.turnId);
    const version = history.versions.find((item) => item.versionId === request.versionId);
    const message = version?.messages.find((item) => item.messageId === request.messageId);
    if (turn?.state !== 'completed' || turn.reply?.replyRequestId !== request.replyRequestId
      || !turn.reply.candidates.some((item) => item.candidateId === request.candidateId) || !message?.text.trim()) {
      throw new Error('本次候选版本已变化，请重新确认。');
    }
    return message.text;
  }
  async copy(request: CandidateCopyRequest, surface: CandidateCopySurface): Promise<void> {
    if (this.copying) throw new Error('复制仍在处理中。');
    const text = this.currentText(request);
    const generation = this.backend.getConnectionGeneration();
    this.copying = true;
    try {
      await surface.writeText(text);
      if (generation !== this.backend.getConnectionGeneration() || this.currentText(request) !== text) {
        throw new Error('本次候选已变化，请重新确认。');
      }
      this.onCopied?.(request, text);
      if (request.hideAfterCopy) surface.hideWindow();
    } catch { throw new Error('复制未确认，请保留编辑文本并重试。'); }
    finally { this.copying = false; }
  }
}
