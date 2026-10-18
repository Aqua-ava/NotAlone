import { createHash, randomUUID } from 'node:crypto';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import type { ContactSession } from '../contacts/session';
import type { ReplySession } from '../reply/session';
import type { ContactSelection } from '../../shared/contact-session-bridge';
import type { ReplyCandidateSelection, ReplySessionState } from '../../shared/reply-bridge';
import type { CandidateTextCopy, CandidateStylePaste, CandidateVersionStyleSampleSave, ManualStyleText, ManualStyleUpdate, SavedSampleTextCopy, StyleSampleState } from '../../shared/style-sample-bridge';
import { listSamples, readSample } from './client';

type Scope = { contactId: string; scopeRevision: number; generation: number };
type CandidateOrigin = { id: string; contactId: string; kind: 'candidate'; replyRequestId: string; sessionId?: string; turnId?: string; generation: number; scopeRevision: number };
type CandidateSource = { origin: CandidateOrigin; texts: readonly string[] };
type KnownOrigin = CandidateOrigin | { contactId: string; kind: 'message'; id: string };
type CopyOrigin = (CandidateOrigin | { id: string; contactId: string; kind: 'sample' })
  & { digest: string; generation: number; scopeRevision: number; invalid?: boolean; unverified?: boolean };
const fingerprint = (text: string) => createHash('sha256').update(text.trim()).digest('hex');
export class StyleSampleController {
  private state: StyleSampleState = { revision: 0, contactId: null, scopeRevision: 0, erasureRevision: 0, phase: 'idle', samples: [], busy: false, error: null };
  private scope: Scope | undefined;
  private pending: AbortController | undefined;
  private operation = 0;
  private pendingExpressionPreferenceDeletions = 0;
  private retry: { signature: string; key: string } | undefined;
  private copied: CopyOrigin | undefined;
  private manualOrigin: CopyOrigin | undefined;
  private manualOriginConflict = false;
  private manualFingerprint: string | undefined;
  private pendingPaste: { id: string; origin: CopyOrigin; scope: Scope; replyRevision: number;
    rollback?: { origin: CopyOrigin | undefined; origins: Array<[string, CopyOrigin]> } } | undefined;
  private lastSessionDeletionRevision = 0;
  private readonly manualPasteOrigins = new Map<string, CopyOrigin>();
  private readonly invalidatedCandidateRequests = new Set<string>();
  // 只保留不可恢复的文字指纹与来源标识，不把被复制/删除的正文放进另一个缓存。
  private readonly knownOrigins = new Map<string, Map<string, KnownOrigin>>();
  private readonly blockedCopies = new Set<string>();
  private readonly deletedCopies = new Set<string>();
  private readonly rejectedCopyDigests = new Set<string>();
  private readonly listeners = new Set<(state: StyleSampleState) => void>();
  private readonly deletionListeners = new Set<(phase: 'started' | 'settled') => void>();
  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession,
    private readonly replies: ReplySession) {
    contacts.onStateChanged(() => this.synchronize());
    backend.onStateChanged(() => this.synchronize());
    replies.onStateChanged((state) => this.onReplyStateChanged(state),
      ['contactId', 'scopeRevision', 'result', 'savedSession', 'candidateVersions', 'messages', 'sourceAvailability', 'confirmedSessionDeletion']);
    this.synchronize();
    this.onReplyStateChanged();
  }
  getState() { return structuredClone(this.state); }
  onStateChanged(listener: (state: StyleSampleState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onDeletion(listener: (phase: 'started' | 'settled') => void) { this.deletionListeners.add(listener); return () => { this.deletionListeners.delete(listener); }; }
  private synchronize() {
    const contacts = this.contacts.getState(); const generation = this.backend.getConnectionGeneration();
    const next = generation !== undefined && contacts.selectedContactId !== null && ['ready', 'loading'].includes(contacts.directoryPhase)
      && contacts.contacts.some((item) => item.contactId === contacts.selectedContactId)
      ? { contactId: contacts.selectedContactId, scopeRevision: contacts.scopeRevision, generation } : undefined;
    if (next?.contactId === this.scope?.contactId && next?.scopeRevision === this.scope?.scopeRevision && next?.generation === this.scope?.generation) return;
    ++this.operation; this.pending?.abort(); this.pending = undefined; this.scope = next; this.retry = undefined;
    this.resetManualOrigin();
    this.publish({ contactId: next?.contactId ?? null, scopeRevision: contacts.scopeRevision, samples: [],
      busy: this.pendingExpressionPreferenceDeletions > 0, error: null, phase: 'idle' });
  }
  private assertScope(selection: ContactSelection): Scope {
    this.synchronize();
    if (!this.scope || this.scope.contactId !== selection.contactId || this.scope.scopeRevision !== selection.scopeRevision) throw new Error('样本联系人已变化，请重新确认。');
    return this.scope;
  }
  async refresh(selection: ContactSelection) {
    const scope = this.assertScope(selection); if (this.pendingExpressionPreferenceDeletions > 0 || this.state.busy) return;
    const operation = ++this.operation; this.pending?.abort(); const pending = this.pending = new AbortController();
    this.publish({ phase: 'loading', samples: [], error: null });
    try {
      const result = await listSamples(this.backend, scope.contactId, pending.signal);
      if (this.current(scope, operation) && result.generation === scope.generation) this.publish({ phase: 'ready', samples: result.samples });
    } catch { if (this.current(scope, operation)) this.publish({ phase: 'failed', samples: [], error: '样本读取失败，请刷新重试。' }); }
    finally { if (this.pending === pending) this.pending = undefined; }
  }
  async invalidateSource(contactId: string) {
    void contactId; this.synchronize();
    // 本人记忆可能引用其他联系人来源；任何来源失效先清空当前投影，再从后端重读。
    for (const key of this.knownOrigins.keys()) this.blockedCopies.add(key);
    ++this.operation; this.pending?.abort(); this.pending = undefined; this.retry = undefined;
    this.resetManualOrigin();
    this.publish({ samples: [], busy: this.pendingExpressionPreferenceDeletions > 0, phase: 'idle', error: null,
      erasureRevision: this.state.erasureRevision + 1 });
    if (this.scope) await this.refresh(this.scope);
  }
  beginExpressionPreferenceDeletion(): void {
    ++this.pendingExpressionPreferenceDeletions;
    // 删除尚未结算时只撤下投影，不能提前重读后端仍可能保留的旧样本。
    void this.invalidateSource('');
  }
  async revalidateExpressionPreferences(): Promise<void> {
    this.pendingExpressionPreferenceDeletions = Math.max(0, this.pendingExpressionPreferenceDeletions - 1);
    if (this.pendingExpressionPreferenceDeletions === 0) await this.invalidateSource('');
  }
  private onReplyStateChanged(reply = this.replies.getState()) {
    this.synchronize();
    this.acceptSessionDeletion(reply);
    this.acceptUnavailableCandidateTurns(reply);
    this.rememberReplyOrigins(reply);
  }
  private resetManualOrigin() {
    this.pendingPaste = undefined;
    this.manualOrigin = undefined; this.manualOriginConflict = false;
    this.manualFingerprint = undefined; this.manualPasteOrigins.clear();
    if (this.copied?.unverified) this.copied = { ...this.copied, unverified: false };
  }
  private candidateOriginsInManual(): CandidateOrigin[] {
    if (this.manualPasteOrigins.size) return [...this.manualPasteOrigins.values()]
      .filter((origin): origin is CopyOrigin & CandidateOrigin => origin.kind === 'candidate');
    const known = this.manualFingerprint ? [...(this.knownOrigins.get(this.manualFingerprint)?.values() ?? [])] : [];
    // 明确的列表样本或本人消息来历不因文字相同改为助手会话副本。
    return known.every((origin) => origin.kind === 'candidate')
      ? known.filter((origin): origin is CandidateOrigin => origin.kind === 'candidate') : [];
  }
  private invalidateCandidateRequests(contactId: string, requestIds: Set<string>) {
    for (const requestId of requestIds) this.invalidatedCandidateRequests.add(`${contactId}:${requestId}`);
    for (const [key, origins] of this.knownOrigins) if ([...origins.values()].some((origin) =>
      origin.kind === 'candidate' && origin.contactId === contactId && requestIds.has(origin.replyRequestId))) this.blockedCopies.add(key);
    if (this.copied?.kind === 'candidate' && this.copied.contactId === contactId && requestIds.has(this.copied.replyRequestId)) {
      this.copied = { ...this.copied, invalid: true };
      this.blockedCopies.add(this.copied.digest);
    }
    if (this.candidateOriginsInManual().some((origin) => origin.contactId === contactId && requestIds.has(origin.replyRequestId))) {
      if (this.manualFingerprint) this.blockedCopies.add(this.manualFingerprint);
      this.resetManualOrigin(); this.retry = undefined;
      this.publish({ erasureRevision: this.state.erasureRevision + 1 });
    }
  }
  private acceptUnavailableCandidateTurns(reply: ReplySessionState) {
    const scope = this.scope; const saved = reply.savedSession;
    if (!scope || reply.contactId !== scope.contactId || reply.scopeRevision !== scope.scopeRevision
      || this.backend.getConnectionGeneration() !== scope.generation || saved?.phase !== 'ready' || !saved.sessionId) return;
    const unavailable = new Set(saved.turns.filter((turn) => turn.state === 'redacted' || turn.state === 'unavailable')
      .map((turn) => turn.turnId));
    if (!unavailable.size) return;
    const origins: Array<KnownOrigin | CopyOrigin> = [...this.knownOrigins.values()].flatMap((entries) => [...entries.values()]);
    if (this.copied) origins.push(this.copied);
    origins.push(...this.manualPasteOrigins.values());
    // 仅消费A已确认的轮次终态与既有来源身份；不从网络失败或空投影推断删除。
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
    const origins: Array<KnownOrigin | CopyOrigin> = [...this.knownOrigins.values()].flatMap((entries) => [...entries.values()]);
    if (this.copied) origins.push(this.copied);
    origins.push(...this.manualPasteOrigins.values());
    const direct = new Set(origins.filter((origin): origin is CandidateOrigin => origin.kind === 'candidate'
      && origin.contactId === scope.contactId && origin.sessionId === event.sessionId).map((origin) => origin.replyRequestId));
    const other = new Set(this.candidateOriginsInManual().filter((origin) => origin.contactId === scope.contactId
      && !direct.has(origin.replyRequestId)).map((origin) => origin.replyRequestId));
    this.invalidateCandidateRequests(scope.contactId, direct);
    // 跨会话候选是否传递依赖由现有中央只读入口实查，不依据清投影或网络失败推断删除。
    for (const requestId of other) void this.revalidateManualCandidate(scope, requestId);
  }
  private async revalidateManualCandidate(scope: Scope, requestId: string) {
    try {
      await this.backend.requestJson({ method: 'GET', path: `/api/contacts/${scope.contactId}/replies/${requestId}/evidence`, timeoutMs: 5000 });
    } catch (error) {
      if (this.scope === scope && this.backend.getConnectionGeneration() === scope.generation
        && error instanceof BackendRequestFailure && error.kind === 'response' && [404, 410].includes(error.status ?? 0)) {
        this.invalidateCandidateRequests(scope.contactId, new Set([requestId]));
      }
    }
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
        // 沿A可信版本投影读取正文，实际完成轮次和请求必须与候选来历一致。
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
  private rememberReplyOrigins(reply = this.replies.getState()) {
    const scope = this.scope;
    if (!scope || reply.contactId !== scope.contactId || reply.scopeRevision !== scope.scopeRevision || reply.sourceAvailability) return;
    for (const { origin, texts } of this.replyCandidateSources(reply)) {
      for (const text of texts) {
        if (!text.trim()) continue;
        const key = fingerprint(text);
        this.rememberOrigin(key, origin);
        if (!this.invalidatedCandidateRequests.has(`${origin.contactId}:${origin.replyRequestId}`)) this.blockedCopies.delete(key);
      }
    }
    for (const message of reply.messages.items) if (message.speaker === 'user' && message.text?.trim()) {
      const key = fingerprint(message.text);
      this.rememberOrigin(key, { contactId: reply.contactId, kind: 'message', id: message.messageId });
      this.blockedCopies.delete(key);
    }
  }
  private rememberOrigin(key: string, origin: KnownOrigin) {
    const entries = this.knownOrigins.get(key) ?? new Map<string, KnownOrigin>();
    entries.set(`${origin.contactId}:${origin.kind}:${origin.id}`, origin);
    this.knownOrigins.set(key, entries);
  }
  async saveManual(selection: ContactSelection & { text: string }) {
    const scope = this.assertScope(selection);
    const pasted = this.manualOrigin;
    if (this.manualOriginConflict) throw new Error('不同来源的片段请分别保存，清空输入后再试。');
    if (pasted && (pasted.contactId !== scope.contactId || pasted.generation !== scope.generation)) throw new Error('复制来源不属于本次联系人，请重新核对。');
    if (pasted?.kind === 'sample') throw new Error('列表文字请使用已有样本，不能改为无来源手工保存。');
    if (pasted?.invalid) throw new Error('复制来源已失效，请清空后重新编辑。');
    const key = fingerprint(selection.text);
    if (this.blockedCopies.has(key) || this.deletedCopies.has(key) || this.rejectedCopyDigests.has(key)) throw new Error('这段文字的来源已失效，请重新编辑。');
    const origins = [...(this.knownOrigins.get(key)?.values() ?? [])];
    if (origins.length > 1) throw new Error('同一句文字有多个已知来源，请从明确候选或消息入口保存。');
    const known = origins[0];
    if (known && known.contactId !== selection.contactId) throw new Error('已知表达来源属于其他联系人。');
    if (pasted && known && (pasted.kind !== known.kind || pasted.id !== known.id)) throw new Error('文字有不同已知来历，请从明确来源入口保存。');
    await this.save(selection, selection.text, pasted ? { kind: 'candidate', id: pasted.id }
      : known ? { kind: known.kind, id: known.id } : { kind: 'manual' });
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
  noteSavedSampleCopy(selection: SavedSampleTextCopy) {
    const scope = this.assertScope(selection);
    const sample = this.state.samples.find((item) => item.sampleId === selection.sampleId);
    const invalid = !selection.text.trim() || !sample?.text.includes(selection.text);
    // 跨项或失效选区仍登记样本来历冲突，不能因校验失败把随后粘贴变成manual。
    this.copied = { digest: fingerprint(selection.text), id: selection.sampleId, kind: 'sample', contactId: scope.contactId, generation: scope.generation, scopeRevision: scope.scopeRevision, invalid };
    if (invalid) throw new Error('表达样本复制来历已失效。');
  }
  updateManualText(selection: ManualStyleUpdate) {
    const scope = this.assertScope(selection);
    if (selection.cancelPasteId !== undefined) {
      const pending = this.pendingPaste;
      if (selection.pasteId !== undefined || selection.pastedText !== undefined || selection.insertedText !== undefined
        || !pending || pending.id !== selection.cancelPasteId || pending.scope !== scope) throw new Error('取消粘贴凭证已失效。');
      if (pending.rollback) {
        this.manualOrigin = pending.rollback.origin;
        this.manualPasteOrigins.clear();
        for (const [key, origin] of pending.rollback.origins) this.manualPasteOrigins.set(key, origin);
      }
      this.pendingPaste = undefined;
    }
    if (selection.pasteId !== undefined) {
      const pending = this.pendingPaste;
      const insertedText = selection.insertedText ?? selection.pastedText;
      if (!pending || pending.rollback || pending.id !== selection.pasteId || pending.scope !== scope
        || pending.replyRevision !== this.replies.getState().revision || this.manualOriginConflict
        || typeof selection.pastedText !== 'string' || !selection.pastedText.trim()
        || fingerprint(selection.pastedText) !== pending.origin.digest
        || typeof insertedText !== 'string' || !insertedText.trim() || insertedText.length > 4096
        || !selection.pastedText.startsWith(insertedText)
        || !selection.text.includes(insertedText) || selection.text.length > 4096
        || !this.candidateCopyContains(pending.origin, selection.pastedText)
        || (pending.origin.kind === 'candidate'
          && this.invalidatedCandidateRequests.has(`${scope.contactId}:${pending.origin.replyRequestId}`))) {
        throw new Error('粘贴凭证已失效，请重新复制并粘贴。');
      }
      pending.rollback = { origin: this.manualOrigin, origins: [...this.manualPasteOrigins] };
      this.manualOrigin = pending.origin;
      this.manualPasteOrigins.set(`${pending.origin.contactId}:${pending.origin.kind}:${pending.origin.id}`, pending.origin);
    } else if (selection.pastedText !== undefined || selection.insertedText !== undefined) throw new Error('粘贴凭证不完整。');
    if (selection.pasteId === undefined) this.pendingPaste = undefined;
    if (!selection.text.trim()) this.resetManualOrigin();
    else this.manualFingerprint = fingerprint(selection.text);
    // 粘贴后的编辑继续沿用真实来历；清空输入或范围失效才解除。
  }
  private rememberedCandidatePaste(digest: string, text: string): CopyOrigin | undefined {
    const origins = [...(this.knownOrigins.get(digest)?.values() ?? [])];
    if (origins.length > 1) { this.manualOriginConflict = true; return; }
    const origin = origins[0];
    if (origin?.kind !== 'candidate') return;
    const available = this.replyCandidateSources(this.replies.getState()).some(({ origin: current, texts }) =>
      current.contactId === origin.contactId && current.id === origin.id && current.replyRequestId === origin.replyRequestId
      && current.sessionId === origin.sessionId && current.generation === origin.generation
      && texts.some((candidate) => candidate.includes(text)));
    return { ...origin, digest, invalid: !available
      || this.invalidatedCandidateRequests.has(`${origin.contactId}:${origin.replyRequestId}`) };
  }
  private candidateCopyContains(origin: CopyOrigin, text: string): boolean {
    return origin.kind === 'candidate' && this.replyCandidateSources(this.replies.getState()).some(({ origin: current, texts }) =>
      current.contactId === origin.contactId && current.id === origin.id && current.replyRequestId === origin.replyRequestId
      && texts.some((candidate) => candidate.includes(text)));
  }
  noteManualPaste(selection: ManualStyleText) {
    const scope = this.assertScope(selection);
    this.pendingPaste = undefined;
    const digest = fingerprint(selection.text);
    const reject = () => {
      this.manualOriginConflict = true;
      throw new Error('无法核验粘贴来源，请清空后直接输入，或从明确候选、本人消息入口保存。');
    };
    if (this.manualOriginConflict || this.blockedCopies.has(digest) || this.deletedCopies.has(digest)
      || this.rejectedCopyDigests.has(digest) || (this.knownOrigins.get(digest)?.size ?? 0) > 1) return reject();
    // 只复验确切登记过的粘贴来历；整体摘要不能证明删除后未知片段的来源。
    const copied = this.copied;
    const pasted = copied && (copied.digest === digest || (!copied.invalid && !copied.unverified
      && this.candidateCopyContains(copied, selection.text))) ? copied : this.rememberedCandidatePaste(digest, selection.text);
    if (!pasted || pasted.kind !== 'candidate' || pasted.invalid || pasted.unverified
      || pasted.contactId !== scope.contactId || pasted.generation !== scope.generation
      || pasted.scopeRevision !== scope.scopeRevision || !this.candidateCopyContains(pasted, selection.text)
      || this.invalidatedCandidateRequests.has(`${pasted.contactId}:${pasted.replyRequestId}`)) return reject();
    if (this.manualOrigin && (this.manualOrigin.id !== pasted.id || this.manualOrigin.kind !== pasted.kind
      || this.manualOrigin.contactId !== pasted.contactId || this.manualOrigin.generation !== pasted.generation)) return reject();
    const pasteId = randomUUID();
    this.pendingPaste = { id: pasteId, origin: { ...pasted, digest }, scope, replyRevision: this.replies.getState().revision };
    return { pasteId };
  }
  private assertCandidateTextOrigin(selection: ReplyCandidateSelection, text: string) {
    const scope = this.assertScope(selection);
    const digest = fingerprint(text);
    const copied = this.copied;
    if (this.blockedCopies.has(digest) || this.deletedCopies.has(digest) || this.rejectedCopyDigests.has(digest)) {
      throw new Error('这段文字的来源已失效，请重新编辑。');
    }
    // 仅复验显式复制的来历；独立输入不根据历史相似文字追加依赖。
    if (!copied || copied.digest !== digest) return;
    if (copied.kind !== 'candidate' || copied.invalid || copied.unverified
      || copied.contactId !== scope.contactId || copied.generation !== scope.generation
      || copied.scopeRevision !== scope.scopeRevision || copied.id !== selection.candidateId
      || copied.replyRequestId !== selection.replyRequestId
      || this.invalidatedCandidateRequests.has(`${scope.contactId}:${copied.replyRequestId}`)) {
      throw new Error('这段复制文字有其他来源，请在原来源入口保存。');
    }
  }
  private candidateText(selection: ReplyCandidateSelection | CandidateVersionStyleSampleSave): string {
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
        throw new Error('当前版本样本来源已失效，请重新读取。');
      }
      // 用户明确保存当前组编辑稿；版本身份沿A受信视图复验，不另存编辑正文。
      return selection.text;
    }
    const candidate = reply.result?.candidates.find((item) => item.original.candidateId === selection.candidateId);
    if (reply.contactId !== selection.contactId || reply.scopeRevision !== selection.scopeRevision
      || reply.result?.input.mode !== 'rewrite_draft' || reply.result.replyRequestId !== selection.replyRequestId || !candidate) {
      throw new Error('候选已失效，请重新选择。');
    }
    return candidate.editedText;
  }
  validateCandidatePaste(selection: CandidateStylePaste) {
    this.candidateText(selection);
    this.assertCandidateTextOrigin(selection, selection.text);
  }
  async saveCandidate(selection: ReplyCandidateSelection | CandidateVersionStyleSampleSave) {
    const text = this.candidateText(selection);
    this.assertCandidateTextOrigin(selection, text);
    await this.save(selection, text, { kind: 'candidate', id: selection.candidateId });
  }
  async saveMessage(selection: ContactSelection & { messageId: string }) {
    this.assertScope(selection); const reply = this.replies.getState();
    const message = reply.messages.items.find((item) => item.messageId === selection.messageId && item.speaker === 'user' && item.text?.trim());
    if (reply.contactId !== selection.contactId || reply.scopeRevision !== selection.scopeRevision || !message?.text) throw new Error('本人消息已失效，请重新选择。');
    await this.save(selection, message.text, { kind: 'message', id: message.messageId });
  }
  private async save(selection: ContactSelection, text: string, origin: { kind: string; id?: string }) {
    const scope = this.assertScope(selection); if (this.state.busy) throw new Error('样本正在保存。');
    if (!text.trim() || text.length > 4096) throw new Error('样本文字为空或超过4096字。');
    const signature = fingerprint(JSON.stringify({ contactId: scope.contactId, text, origin }));
    const key = this.retry?.signature === signature ? this.retry.key : randomUUID(); this.retry = { signature, key };
    const operation = ++this.operation; this.pending?.abort(); const pending = this.pending = new AbortController();
    this.publish({ busy: true, error: null });
    try {
      const response = await this.backend.requestJson({ method: 'POST', path: `/api/contacts/${scope.contactId}/style-samples`, signal: pending.signal,
        timeoutMs: 5000, body: { idempotency_key: key, text, origin } });
      readSample((response.data as Record<string, unknown>).sample);
      if (!this.current(scope, operation) || response.generation !== scope.generation) return;
      this.retry = undefined; this.publish({ busy: false }); await this.refresh(selection);
    } catch { if (this.current(scope, operation)) this.publish({ busy: false, samples: [], phase: 'failed', error: '保存结果尚未确认，请重试原文字或刷新样本目录。' }); }
    finally { if (this.pending === pending) this.pending = undefined; }
  }
  async deleteSample(selection: ContactSelection & { sampleId: string }) {
    const scope = this.assertScope(selection); if (this.state.busy) throw new Error('样本正在处理。');
    if (!this.state.samples.some((sample) => sample.sampleId === selection.sampleId)) throw new Error('样本目录已变化，请刷新。');
    const deletedText = this.state.samples.find((sample) => sample.sampleId === selection.sampleId)!.text;
    this.deletedCopies.add(fingerprint(deletedText));
    const operation = ++this.operation; this.pending?.abort(); const pending = this.pending = new AbortController();
    this.resetManualOrigin();
    this.retry = undefined; this.publish({ busy: true, samples: [], error: null, erasureRevision: this.state.erasureRevision + 1 });
    for (const listener of this.deletionListeners) listener('started');
    try {
      const response = await this.backend.requestJson({ method: 'DELETE', path: `/api/contacts/${scope.contactId}/style-samples/${selection.sampleId}`, signal: pending.signal, timeoutMs: 5000 });
      if (!this.current(scope, operation) || response.generation !== scope.generation) return;
      this.publish({ busy: false });
      await this.replies.revalidateDeletedSource(scope.contactId);
      if (this.current(scope, operation)) await this.refresh(selection);
    } catch { if (this.current(scope, operation)) this.publish({ busy: false, phase: 'failed', samples: [], error: '删除结果尚未确认，请刷新目录后重试。' }); }
    finally {
      if (this.pending === pending) this.pending = undefined;
      for (const listener of this.deletionListeners) listener('settled');
    }
  }
  private current(scope: Scope, operation: number) { return this.scope === scope && operation === this.operation && scope.generation === this.backend.getConnectionGeneration(); }
  private publish(update: Partial<StyleSampleState>) { this.state = { ...this.state, ...update, revision: this.state.revision + 1 }; for (const listener of this.listeners) listener(this.getState()); }
}
