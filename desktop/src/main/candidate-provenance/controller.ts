import { createHash } from 'node:crypto';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import type { ReplySession } from '../reply/session';
import type { ContactSelection } from '../../shared/contact-session-bridge';
import type { ReplyCandidateSelection, ReplySessionState } from '../../shared/reply-bridge';
import type { CandidateTextCopy, CandidateTextPaste } from '../../shared/candidate-provenance-bridge';

type Scope = { contactId: string; scopeRevision: number; generation: number };
type CandidateOrigin = { id: string; contactId: string; kind: 'candidate'; replyRequestId: string; sessionId?: string; turnId?: string; generation: number; scopeRevision: number };
type CandidateSource = { origin: CandidateOrigin; texts: readonly string[] };
type CopyOrigin = CandidateOrigin & { digest: string; invalid?: boolean; unverified?: boolean };
const fingerprint = (text: string) => createHash('sha256').update(text.trim()).digest('hex');

// 只核验候选复制和粘贴的来历，不保存表达正文或创建长期资料。
export class CandidateProvenanceController {
  private scope: Scope | undefined;
  private copied: CopyOrigin | undefined;
  private lastSessionDeletionRevision = 0;
  private readonly invalidatedCandidateRequests = new Set<string>();
  private readonly knownOrigins = new Map<string, Map<string, CandidateOrigin>>();
  private readonly blockedCopies = new Set<string>();
  private readonly rejectedCopyDigests = new Set<string>();
  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession,
    private readonly replies: ReplySession) {
    contacts.onStateChanged(() => this.synchronize());
    backend.onStateChanged(() => this.synchronize());
    replies.onStateChanged(() => this.onReplyStateChanged());
    this.onReplyStateChanged();
  }
  private synchronize() {
    const contacts = this.contacts.getState(); const generation = this.backend.getConnectionGeneration();
    const next = generation !== undefined && contacts.selectedContactId !== null && ['ready', 'loading'].includes(contacts.directoryPhase)
      && contacts.contacts.some((item) => item.contactId === contacts.selectedContactId)
      ? { contactId: contacts.selectedContactId, scopeRevision: contacts.scopeRevision, generation } : undefined;
    if (next?.contactId === this.scope?.contactId && next?.scopeRevision === this.scope?.scopeRevision && next?.generation === this.scope?.generation) return;
    this.scope = next;
  }
  private assertScope(selection: ContactSelection): Scope {
    this.synchronize();
    if (!this.scope || this.scope.contactId !== selection.contactId || this.scope.scopeRevision !== selection.scopeRevision) throw new Error('候选联系人已变化，请重新确认。');
    return this.scope;
  }
  invalidateSource() {
    for (const key of this.knownOrigins.keys()) this.blockedCopies.add(key);
    if (this.copied) this.blockedCopies.add(this.copied.digest);
  }
  private onReplyStateChanged() {
    this.synchronize();
    const reply = this.replies.getState();
    this.acceptSessionDeletion(reply);
    this.acceptUnavailableCandidateTurns(reply);
    this.rememberReplyOrigins();
  }
  private invalidateCandidateRequests(contactId: string, requestIds: Set<string>) {
    for (const requestId of requestIds) this.invalidatedCandidateRequests.add(`${contactId}:${requestId}`);
    for (const [key, origins] of this.knownOrigins) if ([...origins.values()].some((origin) =>
      origin.kind === 'candidate' && origin.contactId === contactId && requestIds.has(origin.replyRequestId))) this.blockedCopies.add(key);
    if (this.copied?.kind === 'candidate' && this.copied.contactId === contactId && requestIds.has(this.copied.replyRequestId)) {
      this.copied = { ...this.copied, invalid: true };
      this.blockedCopies.add(this.copied.digest);
    }
  }
  private acceptUnavailableCandidateTurns(reply: ReplySessionState) {
    const scope = this.scope; const saved = reply.savedSession;
    if (!scope || reply.contactId !== scope.contactId || reply.scopeRevision !== scope.scopeRevision
      || this.backend.getConnectionGeneration() !== scope.generation || saved?.phase !== 'ready' || !saved.sessionId) return;
    const unavailable = new Set(saved.turns.filter((turn) => turn.state === 'redacted' || turn.state === 'unavailable')
      .map((turn) => turn.turnId));
    if (!unavailable.size) return;
    const origins: Array<CandidateOrigin | CopyOrigin> = [...this.knownOrigins.values()].flatMap((entries) => [...entries.values()]);
    if (this.copied) origins.push(this.copied);
    // 仅消费已确认的轮次终态与既有来源身份；不从网络失败或空投影推断删除。
    const requestIds = new Set(origins.filter((origin): origin is CandidateOrigin => origin.kind === 'candidate'
      && origin.contactId === scope.contactId && origin.generation === scope.generation
      && origin.scopeRevision === scope.scopeRevision && origin.sessionId === saved.sessionId
      && origin.turnId !== undefined && unavailable.has(origin.turnId)).map((origin) => origin.replyRequestId));
    this.invalidateCandidateRequests(scope.contactId, requestIds);
  }
  private acceptSessionDeletion(reply: ReplySessionState) {
    const event = reply.confirmedSessionDeletion; const scope = this.scope;
    if (!event || !scope || event.contactId !== scope.contactId || event.scopeRevision !== scope.scopeRevision
      || event.connectionGeneration !== scope.generation || reply.contactId !== scope.contactId
      || reply.scopeRevision !== scope.scopeRevision || !Number.isSafeInteger(event.revision)
      || event.revision <= this.lastSessionDeletionRevision || event.revision > reply.revision) return;
    this.lastSessionDeletionRevision = event.revision;
    const origins: Array<CandidateOrigin | CopyOrigin> = [...this.knownOrigins.values()].flatMap((entries) => [...entries.values()]);
    if (this.copied) origins.push(this.copied);
    const direct = new Set(origins.filter((origin): origin is CandidateOrigin => origin.kind === 'candidate'
      && origin.contactId === scope.contactId && origin.sessionId === event.sessionId).map((origin) => origin.replyRequestId));
    this.invalidateCandidateRequests(scope.contactId, direct);
  }
  private replyCandidateSources(reply: ReplySessionState): CandidateSource[] {
    const scope = this.scope;
    if (!scope || this.backend.getConnectionGeneration() !== scope.generation
      || reply.contactId !== scope.contactId || reply.scopeRevision !== scope.scopeRevision || reply.sourceAvailability) return [];
    const result = reply.result;
    const sources: CandidateSource[] = (result?.candidates ?? []).map(({ original, editedText }) => ({
      origin: { contactId: scope.contactId, kind: 'candidate', id: original.candidateId,
        replyRequestId: result!.replyRequestId, sessionId: result!.assistantSessionId, generation: scope.generation, scopeRevision: scope.scopeRevision }, texts: [original.text, editedText],
    }));
    const saved = reply.savedSession;
    // 正文只读取既有当前投影；恢复来源必须是已核实会话中的实际完成候选。
    if (saved?.phase === 'ready' && saved.sessionId) for (const turn of saved.turns) {
      if (turn.state !== 'completed' || !turn.reply) continue;
      for (const candidate of turn.reply.candidates) {
        const versions = reply.candidateVersions;
        const view = versions?.phase === 'ready' && versions.sessionId === saved.sessionId
          ? versions.items.find((item) => item.candidateId === candidate.candidateId && item.phase === 'ready') : undefined;
        const history = view?.history;
        // 沿可信版本投影读取正文，实际完成轮次和请求必须与候选来历一致。
        const texts = history?.sessionId === saved.sessionId && history.turnId === turn.turnId
          && history.candidateId === candidate.candidateId && history.candidateGroupId === turn.reply.replyRequestId
          ? [candidate.text, ...history.versions.map((version) => version.text)] : [candidate.text];
        const current = sources.find(({ origin }) => origin.id === candidate.candidateId
          && origin.replyRequestId === turn.reply!.replyRequestId && origin.sessionId === saved.sessionId);
        if (current) {
          current.origin = { ...current.origin, turnId: turn.turnId };
          current.texts = [...current.texts, ...texts];
        }
        else sources.push({ origin: { contactId: scope.contactId, kind: 'candidate', id: candidate.candidateId,
          replyRequestId: turn.reply.replyRequestId, sessionId: saved.sessionId, turnId: turn.turnId,
          generation: scope.generation, scopeRevision: scope.scopeRevision }, texts });
      }
    }
    return sources;
  }
  private rememberReplyOrigins() {
    const reply = this.replies.getState(); const scope = this.scope;
    if (!scope || reply.contactId !== scope.contactId || reply.scopeRevision !== scope.scopeRevision || reply.sourceAvailability) return;
    for (const { origin, texts } of this.replyCandidateSources(reply)) {
      for (const text of texts) {
        if (!text.trim()) continue;
        const key = fingerprint(text);
        this.rememberOrigin(key, origin);
        if (!this.invalidatedCandidateRequests.has(`${origin.contactId}:${origin.replyRequestId}`)) this.blockedCopies.delete(key);
      }
    }
  }
  private rememberOrigin(key: string, origin: CandidateOrigin) {
    const entries = this.knownOrigins.get(key) ?? new Map<string, CandidateOrigin>();
    entries.set(`${origin.contactId}:${origin.kind}:${origin.id}`, origin);
    this.knownOrigins.set(key, entries);
  }
  recordCopied(selection: ReplyCandidateSelection, text: string, invalidSelection = false) {
    const scope = this.assertScope(selection);
    const reply = this.replies.getState();
    const source = this.replyCandidateSources(reply).find(({ origin }) =>
      origin.replyRequestId === selection.replyRequestId && origin.id === selection.candidateId);
    const unverified = invalidSelection || !text.trim() || text.length > 65_536 || !source || !source.texts.some((candidate) => candidate.includes(text));
    const invalid = invalidSelection || unverified || this.invalidatedCandidateRequests.has(`${scope.contactId}:${selection.replyRequestId}`);
    // 只记录最后一次显式复制的摘要与来源编号；不监听剪贴板、不保留候选正文。
    this.copied = { ...(source?.origin ?? { id: selection.candidateId, kind: 'candidate', contactId: scope.contactId,
      replyRequestId: selection.replyRequestId }), digest: fingerprint(text), generation: scope.generation, scopeRevision: scope.scopeRevision, invalid, unverified };
    if (invalid && text.trim() && (invalidSelection || !this.retainedVersionCopyCanRetry(selection, this.copied.digest, reply))) {
      this.rejectedCopyDigests.add(this.copied.digest);
    }
    else if (source && !invalid) this.rememberOrigin(this.copied.digest, source.origin);
    if (invalid) throw new Error('复制来历已失效。');
  }
  private retainedVersionCopyCanRetry(selection: ReplyCandidateSelection, digest: string, reply: ReplySessionState): boolean {
    const scope = this.scope; const saved = reply.savedSession; const versions = reply.candidateVersions;
    const known = [...(this.knownOrigins.get(digest)?.values() ?? [])];
    const origin = known.length === 1 ? known[0] : undefined;
    if (!scope || origin?.kind !== 'candidate' || origin.contactId !== scope.contactId
      || origin.id !== selection.candidateId || origin.replyRequestId !== selection.replyRequestId
      || origin.generation !== scope.generation || origin.scopeRevision !== scope.scopeRevision
      || !origin.turnId || reply.sourceAvailability || saved?.phase !== 'ready'
      || saved.sessionId !== origin.sessionId || !versions || versions.phase === 'idle' || versions.sessionId !== origin.sessionId
      || this.invalidatedCandidateRequests.has(`${origin.contactId}:${origin.replyRequestId}`)) return false;
    const turn = saved.turns.find((item) => item.turnId === origin.turnId && item.state === 'completed');
    const history = versions.items.find((item) => item.candidateId === origin.id)?.history;
    // 另一候选读取或失败会改变全局阶段；暂时拒绝复制不作废仍有实际完成身份的可信历史摘要。
    return Boolean(turn?.reply?.replyRequestId === origin.replyRequestId
      && turn.reply.candidates.some((candidate) => candidate.candidateId === origin.id)
      && history?.sessionId === origin.sessionId && history.turnId === origin.turnId
      && history.candidateId === origin.id && history.candidateGroupId === origin.replyRequestId);
  }
  noteCandidateCopy(selection: CandidateTextCopy) {
    this.recordCopied(selection, selection.text, selection.invalidSelection === true);
  }
  private assertCandidateTextOrigin(selection: ReplyCandidateSelection, text: string) {
    const scope = this.assertScope(selection);
    const digest = fingerprint(text);
    const copied = this.copied;
    if (this.blockedCopies.has(digest) || this.rejectedCopyDigests.has(digest)) {
      throw new Error('这段文字的来源已失效，请重新编辑。');
    }
    // 仅复验显式复制的来历；独立输入不根据历史相似文字追加依赖。
    if (!copied || copied.digest !== digest) return;
    if (copied.kind !== 'candidate' || copied.invalid || copied.unverified
      || copied.contactId !== scope.contactId || copied.generation !== scope.generation
      || copied.scopeRevision !== scope.scopeRevision || copied.id !== selection.candidateId
      || copied.replyRequestId !== selection.replyRequestId
      || this.invalidatedCandidateRequests.has(`${scope.contactId}:${copied.replyRequestId}`)) {
      throw new Error('这段复制文字有其他来源，请在原候选中编辑。');
    }
  }
  private candidateText(selection: CandidateTextPaste): string {
    this.assertScope(selection); const reply = this.replies.getState();
    if (reply.contactId !== selection.contactId || reply.scopeRevision !== selection.scopeRevision
      || reply.phase === 'waiting' || reply.sourceAvailability !== undefined
      || reply.sessionDeletion === 'deleting' || reply.sessionDeletion === 'failed') {
      throw new Error('候选已失效，请重新选择。');
    }
    if ('versionId' in selection) {
      const saved = reply.savedSession;
      const turn = saved?.phase === 'ready' && saved.sessionId === selection.sessionId
        ? saved.turns.find((item) => item.state === 'completed' && item.reply?.replyRequestId === selection.replyRequestId
          && item.reply.candidates.some((candidate) => candidate.candidateId === selection.candidateId)) : undefined;
      const versions = reply.candidateVersions;
      const view = versions?.phase === 'ready' && versions.sessionId === selection.sessionId
        ? versions.items.find((item) => item.phase === 'ready' && item.candidateId === selection.candidateId) : undefined;
      const history = view?.history;
      if (!turn || !history || history.sessionId !== selection.sessionId || history.turnId !== turn.turnId
        || history.candidateId !== selection.candidateId || history.candidateGroupId !== selection.replyRequestId
        || view?.displayVersionId !== selection.versionId
        || !history.versions.some((version) => version.versionId === selection.versionId)
        || this.invalidatedCandidateRequests.has(`${selection.contactId}:${selection.replyRequestId}`)) {
        throw new Error('当前版本来源已失效，请重新读取。');
      }
      // 用户编辑当前组候选；版本身份沿受信视图复验，不另存编辑正文。
      return selection.text;
    }
    const candidate = reply.result?.candidates.find((item) => item.original.candidateId === selection.candidateId);
    if (reply.contactId !== selection.contactId || reply.scopeRevision !== selection.scopeRevision
      || reply.result?.input.mode !== 'rewrite_draft' || reply.result.replyRequestId !== selection.replyRequestId || !candidate) {
      throw new Error('候选已失效，请重新选择。');
    }
    return candidate.editedText;
  }
  validateCandidatePaste(selection: CandidateTextPaste) {
    this.candidateText(selection);
    this.assertCandidateTextOrigin(selection, selection.text);
  }
}
