import type { ReplyMessageNotice } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';
import { readReplyMessages } from './messages';

export type MessageNoticeScope = Readonly<{
  connectionGeneration: number | undefined;
  contactId: string | null;
  scopeRevision: number;
  sessionId: string | null;
}>;
type NoticeRecord = Readonly<{ contactId: string; sessionId: string | null; messageId: string; revision: number }>;
export type MessageNoticeRefresh = Readonly<{ epoch: number; revision: number; gap: number }>;
export type MessageNoticeAdoption = Readonly<NoticeRecord & { epoch: number }>;
type Verification = { controller: AbortController; epoch: number; done: Promise<void> };
type NoticeBackend = Pick<BackendHost, 'getConnectionGeneration' | 'subscribeMessages' | 'requestJson'>;
type NoticeEffect = 'verified' | 'uncertain';

// 事件只提供线索；提醒资格来自当前认证联系人的有界消息投影。
export class AssistantMessageNotices {
  private scope: MessageNoticeScope = { connectionGeneration: undefined, contactId: null, scopeRevision: 0, sessionId: null };
  private epoch = 0;
  private revision = 0;
  private gap = 0;
  private needsRefresh = false;
  private phase: ReplyMessageNotice['phase'] = 'idle';
  private stream: AbortController | undefined;
  private verification: Verification | undefined;
  private candidate: { record: NoticeRecord; explore: boolean } | undefined;
  private verified: MessageNoticeAdoption | undefined;
  private readonly retained = new Map<string, NoticeRecord>();

  constructor(private readonly backend: NoticeBackend,
    private readonly knownSessions: (contactId: string, generation: number) => readonly string[],
    private readonly changed: (state: ReplyMessageNotice, effect?: NoticeEffect,
      page?: Awaited<ReturnType<typeof readReplyMessages>>) => void) {}

  // 同联系人切换助手会话只废弃本次核验与票据，继续复用已有订阅。
  setScope(scope: MessageNoticeScope): ReplyMessageNotice {
    const previous = this.scope;
    const transportChanged = scope.connectionGeneration !== previous.connectionGeneration
      || scope.contactId !== previous.contactId || scope.scopeRevision !== previous.scopeRevision;
    if (transportChanged || scope.sessionId !== previous.sessionId) {
      ++this.epoch;
      this.cancelVerification(); this.candidate = undefined; this.verified = undefined;
      if (scope.connectionGeneration !== previous.connectionGeneration) this.retained.clear();
      this.scope = { ...scope };
      if (transportChanged) {
        this.stream?.abort(); this.stream = undefined;
        this.phase = 'idle'; this.needsRefresh = false;
        if (scope.contactId && scope.connectionGeneration !== undefined) this.startStream();
      }
    }
    return this.getState();
  }

  getState(): ReplyMessageNotice {
    return { phase: this.phase, changed: this.verified !== undefined, needsRefresh: this.needsRefresh };
  }

  reconnect(): void {
    if (this.phase !== 'interrupted') return;
    this.stream?.abort(); this.cancelVerification();
    this.markGap(); this.startStream(); this.emit();
  }

  captureRefresh(): MessageNoticeRefresh {
    return Object.freeze({ epoch: this.epoch, revision: this.candidate?.record.revision ?? 0, gap: this.gap });
  }

  // 刷新只确认用户已查看的提醒，不把原候选改成基于新消息的结果。
  confirmRefresh(ticket: MessageNoticeRefresh): void {
    if (!this.isCurrent(ticket.epoch)) return;
    if (ticket.revision === (this.candidate?.record.revision ?? 0)) {
      this.clearCurrent();
    }
    if (ticket.gap === this.gap) this.needsRefresh = false;
    this.emit();
  }

  captureAdoption(): MessageNoticeAdoption | undefined {
    return this.verified?.sessionId && this.isAdoptionCurrent(this.verified) ? this.verified : undefined;
  }

  isAdoptionCurrent(ticket: MessageNoticeAdoption): boolean {
    return this.isCurrent(ticket.epoch) && this.verified === ticket && this.candidate?.record.revision === ticket.revision;
  }

  // 生成链路已完成权威核验；这里只确认票据覆盖的提醒，后到线索与缺口独立保留。
  confirmAdoption(ticket: MessageNoticeAdoption): void {
    if (!this.isCurrent(ticket.epoch)) return;
    if (this.verified === ticket) this.verified = undefined;
    if (this.candidate?.record.revision === ticket.revision) this.candidate = undefined;
    const key = this.key(ticket.contactId, ticket.sessionId);
    if (this.retained.get(key)?.revision === ticket.revision) this.retained.delete(key);
    this.emit();
  }

  async restore(): Promise<void> {
    const { contactId, sessionId } = this.scope;
    if (!contactId || !sessionId || !this.isCurrent(this.epoch)) return;
    const record = this.retained.get(this.key(contactId, sessionId));
    if (!record || this.candidate?.record === record && this.verified?.revision === record.revision) return;
    if (this.candidate?.record !== record) this.candidate = { record, explore: false };
    await this.verify();
  }

  forget(contactId?: string, sessionId?: string): void {
    for (const [key, record] of this.retained) {
      if ((!contactId || record.contactId === contactId) && (!sessionId || record.sessionId === sessionId)) this.retained.delete(key);
    }
    if ((!contactId || this.scope.contactId === contactId) && (!sessionId || this.scope.sessionId === sessionId)) {
      ++this.epoch; this.cancelVerification(); this.candidate = undefined; this.verified = undefined;
      this.needsRefresh = false; this.emit();
    }
  }

  retainContacts(contactIds: readonly string[]): void {
    for (const record of this.retained.values()) if (!contactIds.includes(record.contactId)) this.forget(record.contactId);
  }

  private startStream(): void {
    const { contactId, scopeRevision, connectionGeneration } = this.scope;
    if (!contactId || connectionGeneration === undefined) return;
    const controller = new AbortController(); this.stream = controller; this.phase = 'connecting';
    const current = () => this.stream === controller && !controller.signal.aborted
      && this.scope.contactId === contactId && this.scope.scopeRevision === scopeRevision
      && this.backend.getConnectionGeneration() === connectionGeneration;
    this.backend.subscribeMessages({
      connected: () => {
        if (!current()) return;
        this.phase = 'connected'; this.emit();
        // 重连只核对最新一页；不扫描历史，也不因缺口自动创建生成任务。
        if (this.needsRefresh) void this.verify();
      },
      interrupted: () => {
        if (!current()) return;
        this.cancelVerification(); this.phase = 'interrupted'; this.markGap(); this.emit('uncertain');
      },
      message: (event) => {
        if (!current()) return;
        if (event.contactId !== contactId) {
          for (const sessionId of this.knownSessions(event.contactId, connectionGeneration)) {
            this.retain({ ...event, sessionId, revision: ++this.revision });
          }
          return;
        }
        const record = Object.freeze({ ...event, sessionId: this.scope.sessionId, revision: ++this.revision });
        this.retain(record); this.candidate = { record, explore: true }; this.verified = undefined;
        this.emit();
        void this.verify();
      },
    }, controller.signal);
  }

  private verify(): Promise<void> {
    if (this.verification) return this.verification.done;
    const verification: Verification = { controller: new AbortController(), epoch: this.epoch, done: Promise.resolve() };
    this.verification = verification;
    verification.done = this.verifyPending(verification).finally(() => {
      if (this.verification === verification) this.verification = undefined;
    });
    return verification.done;
  }

  private async verifyPending(verification: Verification): Promise<void> {
    // 连续事件只替换待核验标识；一次读取结算后才为未覆盖的事件继续读取。
    while ((this.candidate || this.needsRefresh) && this.isCurrent(verification.epoch) && !verification.controller.signal.aborted) {
      const candidate = this.candidate, record = candidate?.record, gap = this.gap;
      try {
        const page = await readReplyMessages(this.backend, this.scope.contactId!, null, verification.controller.signal);
        if (!this.isCurrent(verification.epoch) || verification.controller.signal.aborted) return;
        if (this.candidate !== candidate) continue;
        if (page.generation !== this.scope.connectionGeneration) return;
        if (!record) {
          if (gap === this.gap) this.needsRefresh = false;
          this.emit(undefined, page);
        } else if (page.messages.some((message) => message.messageId === record.messageId)) {
          if (gap === this.gap) this.needsRefresh = false;
          this.verified = Object.freeze({ ...record, epoch: this.epoch });
          this.emit(candidate.explore ? 'verified' : undefined, page);
        } else { this.verified = undefined; this.markGap(); this.emit('uncertain'); }
      } catch {
        if (!this.isCurrent(verification.epoch) || verification.controller.signal.aborted) return;
        if (this.candidate !== candidate) continue;
        this.markGap(); this.emit('uncertain');
      }
      return;
    }
  }

  private retain(record: NoticeRecord): void {
    if (!record.sessionId) return;
    const key = this.key(record.contactId, record.sessionId);
    this.retained.delete(key); this.retained.set(key, record);
    while (this.retained.size > 32) this.retained.delete(this.retained.keys().next().value!);
  }

  private clearCurrent(): void {
    const { contactId, sessionId } = this.scope;
    if (contactId) this.retained.delete(this.key(contactId, sessionId));
    this.cancelVerification(); this.candidate = undefined; this.verified = undefined;
  }
  private key(contactId: string, sessionId: string | null): string { return `${contactId}:${sessionId}`; }
  private markGap(): void { ++this.gap; this.needsRefresh = true; }
  private isCurrent(epoch: number): boolean {
    return epoch === this.epoch && this.scope.contactId !== null && this.scope.connectionGeneration !== undefined
      && this.scope.connectionGeneration === this.backend.getConnectionGeneration();
  }
  private cancelVerification(): void { this.verification?.controller.abort(); this.verification = undefined; }
  private emit(effect?: NoticeEffect, page?: Awaited<ReturnType<typeof readReplyMessages>>): void {
    this.changed(this.getState(), effect, page);
  }
}
