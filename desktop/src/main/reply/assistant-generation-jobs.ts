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
export type OwnedAssistantPreparation = Readonly<{ identity: AssistantGenerationOwner; signal: AbortSignal }>;
export type PendingAssistantGenerationReceipt = AssistantGenerationIdentity & AssistantGenerationReceipt;
type ActiveJob = { controller: AbortController; viewRevision: number; stage: 'preparing' | 'prepared' | 'requesting';
  receipt?: AssistantGenerationReceipt; preparationSettled: Promise<void>; settlePreparation: () => void;
  closingTask?: Promise<void>; settledWithoutGeneration?: true };

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
  private closingReceipt: ((receipt: PendingAssistantGenerationReceipt) => void | Promise<void>) | undefined;
  private closingJobs: [OwnedAssistantPreparation, ActiveJob][] | undefined;
  private readonly jobs = new Map<OwnedAssistantPreparation, ActiveJob>();

  begin(identity: AssistantGenerationIdentity, controller = new AbortController()): OwnedAssistantGeneration {
    if (!isUuid(identity.requestKey)) throw new Error('本次生成归属无效。');
    return this.register(identity, controller) as OwnedAssistantGeneration;
  }
  // 确认方向的实际请求键由后端准备决定；准备发出前只登记已核验的 owner。
  beginPreparation(owner: AssistantGenerationOwner, controller = new AbortController()): OwnedAssistantPreparation {
    return this.register({ connectionGeneration: owner.connectionGeneration,
      contactId: owner.contactId, sessionId: owner.sessionId }, controller);
  }
  private register(identity: AssistantGenerationOwner | AssistantGenerationIdentity,
    controller: AbortController): OwnedAssistantPreparation {
    if (this.closing) throw new Error('应用正在退出，请重开后再生成。');
    if (!Number.isSafeInteger(identity.connectionGeneration) || identity.connectionGeneration < 0
      || !isUuid(identity.contactId) || !isUuid(identity.sessionId)) throw new Error('本次生成归属无效。');
    const job = Object.freeze({ identity: Object.freeze({ connectionGeneration: identity.connectionGeneration,
      contactId: identity.contactId.toLowerCase(), sessionId: identity.sessionId.toLowerCase(),
      ...('requestKey' in identity ? { requestKey: identity.requestKey.toLowerCase() } : {}) }),
      signal: controller.signal });
    let settlePreparation = () => {};
    const preparationSettled = new Promise<void>((resolve) => { settlePreparation = resolve; });
    this.jobs.set(job, { controller, viewRevision: this.viewRevision, stage: 'preparing', preparationSettled, settlePreparation });
    return job;
  }
  receivePrepared(preparation: OwnedAssistantPreparation, receipt: AssistantGenerationReceipt): OwnedAssistantGeneration {
    const active = this.jobs.get(preparation);
    if (!active || 'requestKey' in preparation.identity || receipt.sessionId !== preparation.identity.sessionId
      || !isUuid(receipt.requestKey) || !isUuid(receipt.turnId) || !isUuid(receipt.inputVersionId)
      || !['running', 'completed', 'failed'].includes(receipt.state)) throw new Error('本次生成回执归属无效。');
    const job = Object.freeze({ identity: Object.freeze({ ...preparation.identity,
      requestKey: receipt.requestKey.toLowerCase() }), signal: preparation.signal });
    this.jobs.delete(preparation); this.jobs.set(job, active);
    this.receiveReceipt(job, receipt);
    return job;
  }
  // 只有正式准备明确返回澄清等非候选结果时可用；传输失败不能推断服务端没有领取。
  completePreparationWithoutGeneration(preparation: OwnedAssistantPreparation): void {
    const active = this.jobs.get(preparation);
    if (!active || active.receipt) throw new Error('本次准备状态尚未确认。');
    active.settledWithoutGeneration = true; active.settlePreparation(); this.jobs.delete(preparation);
  }
  receiveReceipt(job: OwnedAssistantGeneration, receipt: AssistantGenerationReceipt): void {
    const active = this.jobs.get(job);
    if (!active || receipt.sessionId !== job.identity.sessionId || receipt.requestKey !== job.identity.requestKey
      || !isUuid(receipt.turnId) || !isUuid(receipt.inputVersionId)
      || !['running', 'completed', 'failed'].includes(receipt.state)) throw new Error('本次生成回执归属无效。');
    active.receipt = Object.freeze({ sessionId: receipt.sessionId, requestKey: receipt.requestKey,
      turnId: receipt.turnId, inputVersionId: receipt.inputVersionId, state: receipt.state });
    active.stage = 'prepared'; active.settlePreparation();
    if (this.closing) this.deliverClosingReceipt(job, active);
  }
  requestStarted(job: OwnedAssistantGeneration): void {
    const active = this.jobs.get(job);
    if (this.isActive(job) && active?.receipt) active.stage = 'requesting';
  }
  leaveView(): void { this.viewRevision += 1; }
  isActive(job: OwnedAssistantPreparation): boolean { return !this.closing && this.jobs.has(job) && !job.signal.aborted; }
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
  beginClosing(onReceipt: (receipt: PendingAssistantGenerationReceipt) => void | Promise<void>): Promise<void> {
    if (!this.closing) {
      this.closing = true; this.closingReceipt = onReceipt; this.leaveView();
      this.closingJobs = [...this.jobs];
    }
    // 没有回执不等于没有准备请求；退出必须等到每个已接纳请求的准备阶段终结。
    return Promise.all((this.closingJobs ?? []).map(async ([job, active]) => {
      if (active.closingTask) {
        try { await active.closingTask; return; } catch { active.closingTask = undefined; }
      }
      await active.preparationSettled;
      if (active.settledWithoutGeneration) return;
      if (!active.receipt) throw new Error('本次生成身份尚未确认，退出尚未完成。');
      await this.deliverClosingReceipt(job, active);
    })).then(() => {});
  }
  private deliverClosingReceipt(job: OwnedAssistantPreparation, active: ActiveJob): Promise<void> | undefined {
    const receipt = active.receipt;
    if (!receipt) return undefined;
    if (!active.closingTask) {
      active.controller.abort();
      active.closingTask = Promise.resolve().then(() => this.closingReceipt?.({ ...job.identity, ...receipt }));
      // 准备回调不会等待此 promise；排空调用负责向宿主报告失败。
      void active.closingTask.catch(() => {});
    }
    return active.closingTask;
  }
  cancelRequest(identity: AssistantGenerationIdentity): void {
    for (const [job, active] of this.jobs) if (sameOwner(job.identity, identity)
      && ('requestKey' in job.identity ? job.identity.requestKey : active.receipt?.requestKey) === identity.requestKey) active.controller.abort();
  }
  cancelSession(owner: AssistantGenerationOwner): void {
    for (const [job, active] of this.jobs) if (sameOwner(job.identity, owner)) active.controller.abort();
  }
  cancelContact(connectionGeneration: number, contactId: string): void {
    for (const [job, active] of this.jobs) if (job.identity.connectionGeneration === connectionGeneration
      && job.identity.contactId === contactId) active.controller.abort();
  }
  cancelAll(): void { for (const active of this.jobs.values()) active.controller.abort(); }
  finish(job: OwnedAssistantPreparation): void {
    const active = this.jobs.get(job);
    active?.settlePreparation();
    // 请求结束但缺少回执仍可能已在后端领取；保留纯身份，退出必须明确拒绝。
    if (active && !active.receipt && !active.settledWithoutGeneration) return;
    this.jobs.delete(job);
  }
}
