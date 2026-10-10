import { createHash, randomUUID } from 'node:crypto';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import type { ReplySession } from '../reply/session';
import type { ContactSelection } from '../../shared/contact-session-bridge';
import type { ReplyCandidateSelection } from '../../shared/reply-bridge';
import type { StyleSampleState } from '../../shared/style-sample-bridge';
import { listSamples, readSample } from './client';

type Scope = { contactId: string; scopeRevision: number; generation: number };
type KnownOrigin = { contactId: string; kind: 'candidate' | 'message'; id: string };
const fingerprint = (text: string) => createHash('sha256').update(text.trim()).digest('hex');
export class StyleSampleController {
  private state: StyleSampleState = { revision: 0, contactId: null, scopeRevision: 0, erasureRevision: 0, phase: 'idle', samples: [], busy: false, error: null };
  private scope: Scope | undefined;
  private pending: AbortController | undefined;
  private operation = 0;
  private retry: { signature: string; key: string } | undefined;
  // 只保留不可恢复的文字指纹与来源标识，不把被复制/删除的正文放进另一个缓存。
  private readonly knownOrigins = new Map<string, Map<string, KnownOrigin>>();
  private readonly blockedCopies = new Set<string>();
  private readonly deletedCopies = new Set<string>();
  private readonly listeners = new Set<(state: StyleSampleState) => void>();
  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession,
    private readonly replies: ReplySession) {
    contacts.onStateChanged(() => this.synchronize());
    backend.onStateChanged(() => this.synchronize());
    replies.onStateChanged(() => this.rememberReplyOrigins());
    this.synchronize();
    this.rememberReplyOrigins();
  }
  getState() { return structuredClone(this.state); }
  onStateChanged(listener: (state: StyleSampleState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private synchronize() {
    const contacts = this.contacts.getState(); const generation = this.backend.getConnectionGeneration();
    const next = generation !== undefined && contacts.selectedContactId !== null && ['ready', 'loading'].includes(contacts.directoryPhase)
      && contacts.contacts.some((item) => item.contactId === contacts.selectedContactId)
      ? { contactId: contacts.selectedContactId, scopeRevision: contacts.scopeRevision, generation } : undefined;
    if (next?.contactId === this.scope?.contactId && next?.scopeRevision === this.scope?.scopeRevision && next?.generation === this.scope?.generation) return;
    ++this.operation; this.pending?.abort(); this.pending = undefined; this.scope = next; this.retry = undefined;
    this.publish({ contactId: next?.contactId ?? null, scopeRevision: contacts.scopeRevision, samples: [], busy: false, error: null, phase: 'idle' });
  }
  private assertScope(selection: ContactSelection): Scope {
    this.synchronize();
    if (!this.scope || this.scope.contactId !== selection.contactId || this.scope.scopeRevision !== selection.scopeRevision) throw new Error('样本联系人已变化，请重新确认。');
    return this.scope;
  }
  async refresh(selection: ContactSelection) {
    const scope = this.assertScope(selection); if (this.state.busy) return;
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
    this.publish({ samples: [], busy: false, phase: 'idle', error: null, erasureRevision: this.state.erasureRevision + 1 });
    if (this.scope) await this.refresh(this.scope);
  }
  private rememberReplyOrigins() {
    const reply = this.replies.getState(); if (!reply.contactId || reply.sourceAvailability) return;
    for (const { original, editedText } of reply.result?.candidates ?? []) {
      for (const text of [original.text, editedText]) {
        const key = fingerprint(text);
        this.rememberOrigin(key, { contactId: reply.contactId, kind: 'candidate', id: original.candidateId });
        this.blockedCopies.delete(key);
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
    const key = fingerprint(selection.text);
    if (this.blockedCopies.has(key) || this.deletedCopies.has(key)) throw new Error('这段文字的来源已失效，请重新编辑。');
    const origins = [...(this.knownOrigins.get(key)?.values() ?? [])];
    if (origins.length > 1) throw new Error('同一句文字有多个已知来源，请从明确候选或消息入口保存。');
    const known = origins[0];
    if (known && known.contactId !== selection.contactId) throw new Error('已知表达来源属于其他联系人。');
    await this.save(selection, selection.text, known ? { kind: known.kind, id: known.id } : { kind: 'manual' });
  }
  async saveCandidate(selection: ReplyCandidateSelection) {
    this.assertScope(selection); const reply = this.replies.getState();
    const candidate = reply.result?.candidates.find((item) => item.original.candidateId === selection.candidateId);
    if (reply.contactId !== selection.contactId || reply.scopeRevision !== selection.scopeRevision || reply.result?.replyRequestId !== selection.replyRequestId || !candidate) throw new Error('候选已失效，请重新选择。');
    await this.save(selection, candidate.editedText, { kind: 'candidate', id: selection.candidateId });
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
    const signature = JSON.stringify({ contactId: scope.contactId, text, origin });
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
    this.retry = undefined; this.publish({ busy: true, samples: [], error: null, erasureRevision: this.state.erasureRevision + 1 });
    try {
      const response = await this.backend.requestJson({ method: 'DELETE', path: `/api/contacts/${scope.contactId}/style-samples/${selection.sampleId}`, signal: pending.signal, timeoutMs: 5000 });
      if (!this.current(scope, operation) || response.generation !== scope.generation) return;
      this.publish({ busy: false });
      await this.replies.revalidateDeletedSource(scope.contactId);
      if (this.current(scope, operation)) await this.refresh(selection);
    } catch { if (this.current(scope, operation)) this.publish({ busy: false, phase: 'failed', samples: [], error: '删除结果尚未确认，请刷新目录后重试。' }); }
    finally { if (this.pending === pending) this.pending = undefined; }
  }
  private current(scope: Scope, operation: number) { return this.scope === scope && operation === this.operation && scope.generation === this.backend.getConnectionGeneration(); }
  private publish(update: Partial<StyleSampleState>) { this.state = { ...this.state, ...update, revision: this.state.revision + 1 }; for (const listener of this.listeners) listener(this.getState()); }
}
