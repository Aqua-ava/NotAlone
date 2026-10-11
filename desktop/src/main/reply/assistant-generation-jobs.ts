import { isUuid } from '../uuid';
import { isRecord } from './result-read';

export type AssistantGenerationOwner = Readonly<{
  connectionGeneration: number;
  contactId: string;
  sessionId: string;
}>;
export type AssistantGenerationIdentity = AssistantGenerationOwner & Readonly<{ requestKey: string }>;
export type AssistantGenerationReceipt = Readonly<{
  sessionId: string;
  turnId: string;
  inputVersionId: string;
  requestKey: string;
  state: 'running' | 'completed' | 'failed';
}>;
export type OwnedAssistantGeneration = Readonly<{ identity: AssistantGenerationIdentity; signal: AbortSignal }>;
export type PendingAssistantGenerationReceipt = AssistantGenerationIdentity & AssistantGenerationReceipt;
type ActiveJob = { controller: AbortController; viewRevision: number; stage: 'preparing' | 'prepared' | 'requesting';
  receipt?: AssistantGenerationReceipt; closingDelivered?: boolean };

const sameOwner = (left: AssistantGenerationOwner, right: AssistantGenerationOwner) =>
  left.connectionGeneration === right.connectionGeneration && left.contactId === right.contactId && left.sessionId === right.sessionId;

export function readAssistantGenerationReceipt(value: unknown, sessionId: string, requestKey: string): AssistantGenerationReceipt {
  const fields = ['session_id', 'turn_id', 'request_key', 'input_version_id', 'state'];
  if (!isRecord(value) || Object.keys(value).length !== fields.length || !Object.keys(value).every((key) => fields.includes(key))
    || value.session_id !== sessionId || value.request_key !== requestKey || !isUuid(value.turn_id) || !isUuid(value.input_version_id)
    || !['running', 'completed', 'failed'].includes(value.state as string)) throw new Error('本次生成回执归属无效。');
  return Object.freeze({ sessionId, requestKey, turnId: value.turn_id.toLowerCase(),
    inputVersionId: value.input_version_id.toLowerCase(), state: value.state as AssistantGenerationReceipt['state'] });
}

// 一个实例只属于持有它的认证后端；连接变化立即取消。这里不保存正文、候选或恢复副本。
export class AssistantGenerationJobs {
  private viewRevision = 0;
  private closing = false;
  private closingReceipt: ((receipt: PendingAssistantGenerationReceipt) => void) | undefined;
  private readonly jobs = new Map<OwnedAssistantGeneration, ActiveJob>();

  begin(identity: AssistantGenerationIdentity, controller = new AbortController()): OwnedAssistantGeneration {
    if (this.closing) throw new Error('应用正在退出，请重开后再生成。');
    if (!Number.isSafeInteger(identity.connectionGeneration) || identity.connectionGeneration < 0
      || !isUuid(identity.contactId) || !isUuid(identity.sessionId) || !isUuid(identity.requestKey)) throw new Error('本次生成归属无效。');
    const job = Object.freeze({ identity: Object.freeze({ connectionGeneration: identity.connectionGeneration,
      contactId: identity.contactId.toLowerCase(), sessionId: identity.sessionId.toLowerCase(), requestKey: identity.requestKey.toLowerCase() }),
      signal: controller.signal });
    this.jobs.set(job, { controller, viewRevision: this.viewRevision, stage: 'preparing' });
    return job;
  }
  receiveReceipt(job: OwnedAssistantGeneration, receipt: AssistantGenerationReceipt): void {
    const active = this.jobs.get(job);
    if (!active || receipt.sessionId !== job.identity.sessionId || receipt.requestKey !== job.identity.requestKey
      || !isUuid(receipt.turnId) || !isUuid(receipt.inputVersionId)
      || !['running', 'completed', 'failed'].includes(receipt.state)) throw new Error('本次生成回执归属无效。');
    active.receipt = Object.freeze({ sessionId: receipt.sessionId, requestKey: receipt.requestKey,
      turnId: receipt.turnId, inputVersionId: receipt.inputVersionId, state: receipt.state });
    active.stage = 'prepared';
    if (this.closing) this.deliverClosingReceipt(job, active);
  }
  requestStarted(job: OwnedAssistantGeneration): void {
    const active = this.jobs.get(job);
    if (this.isActive(job) && active?.receipt) active.stage = 'requesting';
  }
  leaveView(): void { this.viewRevision += 1; }
  isActive(job: OwnedAssistantGeneration): boolean { return !this.closing && this.jobs.has(job) && !job.signal.aborted; }
  canPublish(job: OwnedAssistantGeneration, view: AssistantGenerationOwner): boolean {
    const active = this.jobs.get(job);
    return Boolean(this.isActive(job) && active && active.viewRevision === this.viewRevision && sameOwner(job.identity, view));
  }
  hasPending(owner: AssistantGenerationOwner): boolean {
    return [...this.jobs].some(([job, active]) => this.isActive(job) && sameOwner(job.identity, owner) && active.receipt?.state !== 'completed');
  }
  // prepare是瞬时快照；failed重试发出长请求后才提供身份，completed重放仍保持原状态。
  requestReceipt(owner: AssistantGenerationOwner): PendingAssistantGenerationReceipt | undefined {
    for (const [job, active] of [...this.jobs].reverse()) {
      if (this.isActive(job) && sameOwner(job.identity, owner) && active.receipt
        && (active.receipt.state !== 'failed' || active.stage === 'requesting')) {
        return { ...job.identity, ...active.receipt };
      }
    }
    return undefined;
  }
  pendingReceipts(): PendingAssistantGenerationReceipt[] {
    return [...this.jobs].flatMap(([job, active]) => active.receipt ? [{ ...job.identity, ...active.receipt }] : []);
  }
  beginClosing(onReceipt: (receipt: PendingAssistantGenerationReceipt) => void): void {
    if (this.closing) return;
    this.closing = true; this.closingReceipt = onReceipt; this.leaveView();
    for (const [job, active] of this.jobs) if (active.receipt) this.deliverClosingReceipt(job, active);
  }
  private deliverClosingReceipt(job: OwnedAssistantGeneration, active: ActiveJob): void {
    if (!active.receipt || active.closingDelivered) return;
    active.closingDelivered = true; active.controller.abort();
    this.closingReceipt?.({ ...job.identity, ...active.receipt });
  }
  cancelRequest(identity: AssistantGenerationIdentity): void {
    for (const [job, active] of this.jobs) if (sameOwner(job.identity, identity)
      && job.identity.requestKey === identity.requestKey) active.controller.abort();
  }
  cancelSession(owner: AssistantGenerationOwner): void {
    for (const [job, active] of this.jobs) if (sameOwner(job.identity, owner)) active.controller.abort();
  }
  cancelContact(connectionGeneration: number, contactId: string): void {
    for (const [job, active] of this.jobs) if (job.identity.connectionGeneration === connectionGeneration
      && job.identity.contactId === contactId) active.controller.abort();
  }
  cancelAll(): void { for (const active of this.jobs.values()) active.controller.abort(); }
  finish(job: OwnedAssistantGeneration): void { this.jobs.delete(job); }
}
