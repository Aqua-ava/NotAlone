import type { AssistantNoGenerationProof } from '../../shared/assistant-no-generation';
import type { SavedAssistantTurn } from '../../shared/assistant-session';
import type { ReplyGenerationJobState } from '../../shared/reply-bridge';
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
export type AssistantGenerationRecovery = (identity: AssistantGenerationIdentity) => Promise<AssistantGenerationReceipt | null>;
export type AssistantGenerationStopping = Readonly<{ interrupt: (receipt: PendingAssistantGenerationReceipt) => Promise<void>; recover: AssistantGenerationRecovery }>;
export type AssistantPreparationCommandIdentity = Readonly<{
  taskId: string; inputVersionId: string; action: 'confirm' | 'answer'; suggestionId: string | null; operationKey: string;
}>;
export type OwnedAssistantPreparation = Readonly<{ identity: AssistantGenerationOwner; signal: AbortSignal }>;
export type OwnedAssistantGeneration = Readonly<{ identity: AssistantGenerationIdentity; signal: AbortSignal }>;
export type PendingAssistantGenerationReceipt = AssistantGenerationIdentity & AssistantGenerationReceipt;
type ActiveJob = { controller: AbortController; viewRevision: number; stage: 'created' | 'preparing' | 'prepared' | 'queued' | 'requesting';
  receipt?: AssistantGenerationReceipt; preparationSettled: Promise<void>; settlePreparation: () => void;
  preparationCommand?: AssistantPreparationCommandIdentity; transportEnded?: boolean; failedResponseReceived?: true; failedLeaseSettled?: true; canRetry?: boolean; terminal?: boolean; settledWithoutGeneration?: true; closingTask?: Promise<void>; stopping?: AssistantGenerationStopping };

const sameOwner = (left: AssistantGenerationOwner, right: AssistantGenerationOwner) =>
  left.connectionGeneration === right.connectionGeneration && left.contactId === right.contactId && left.sessionId === right.sessionId;

const commandFields = ['taskId', 'inputVersionId', 'action', 'suggestionId', 'operationKey'] as const;
function capturePreparationCommand(command: AssistantPreparationCommandIdentity): AssistantPreparationCommandIdentity {
  if (!isRecord(command) || Object.keys(command).length !== commandFields.length
    || !commandFields.every((key) => Object.hasOwn(command, key))
    || !isUuid(command.taskId) || !isUuid(command.inputVersionId) || !isUuid(command.operationKey)
    || !['confirm', 'answer'].includes(command.action)
    || !(command.suggestionId === null || isUuid(command.suggestionId))
    || command.action === 'answer' && command.suggestionId !== null) throw new Error('本次准备命令关联无效。');
  return Object.freeze({ taskId: command.taskId.toLowerCase(), inputVersionId: command.inputVersionId.toLowerCase(),
    action: command.action, suggestionId: command.suggestionId?.toLowerCase() ?? null, operationKey: command.operationKey.toLowerCase() });
}
const sameCommand = (left: AssistantPreparationCommandIdentity, right: AssistantPreparationCommandIdentity) =>
  commandFields.every((key) => left[key] === right[key]);

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
  private closingRecovery: AssistantGenerationRecovery | undefined;
  private closingJobs: [OwnedAssistantPreparation, ActiveJob][] | undefined;
  private readonly jobs = new Map<OwnedAssistantPreparation, ActiveJob>();

  // 后端已有单次回复模型许可；桌面派发一个有效执行，当前连接最多8项、跨代际累计32项未结算身份。
  private readonly executing = new Set<OwnedAssistantGeneration>();
  private readonly waiting = new Map<OwnedAssistantGeneration, { resolve: () => void; reject: () => void }>();
  private readonly finished = new Map<string, ReplyGenerationJobState & { connectionGeneration: number }>();
  constructor(private readonly changed: () => void = () => {}) {}

  recoveryPending(generation: number | undefined): number {
    return [...this.jobs.keys()].filter((job) => job.identity.connectionGeneration !== generation).length;
  }
  states(generation: number | undefined): ReplyGenerationJobState[] {
    const states = new Map<string, ReplyGenerationJobState>();
    for (const item of this.finished.values()) if (item.connectionGeneration === generation) {
      const { connectionGeneration: _, ...state } = item; states.set(state.requestKey, state);
    }
    for (const [job, active] of this.jobs) if (job.identity.connectionGeneration === generation && active.receipt) {
      const { receipt } = active;
      states.set(receipt.requestKey, { contactId: job.identity.contactId, sessionId: receipt.sessionId,
        requestKey: receipt.requestKey, turnId: receipt.turnId, inputVersionId: receipt.inputVersionId, canRetry: active.canRetry,
        phase: receipt.state === 'completed' ? 'completed' : active.failedResponseReceived ? 'failed'
          : active.transportEnded || job.signal.aborted ? 'unconfirmed'
          : active.stage === 'requesting' ? 'generating' : 'queued' });
    }
    return [...states.values()];
  }
  reconcile(owner: AssistantGenerationOwner, turns: SavedAssistantTurn[]): void {
    const valid = new Map(turns.filter((turn) => turn.state !== 'redacted' && turn.state !== 'unavailable')
      .map((turn) => [turn.requestKey, turn]));
    for (const [key, item] of this.finished) if (sameOwner(item, owner)) {
      const turn = valid.get(key);
      if (!turn) this.finished.delete(key);
      else if (turn.state === 'completed') this.finished.set(key, { ...item, phase: 'completed', canRetry: false });
    }
    for (const [job, active] of this.jobs) {
      if (!sameOwner(job.identity, owner) || !active.receipt) continue;
      const turn = turns.find((item) => item.turnId === active.receipt!.turnId);
      if (active.transportEnded && turn?.requiresReprepare && turn.state === 'failed'
        && turn.generationActive === false && turn.requestKey === active.receipt.requestKey
        && turn.inputVersionId === active.receipt.inputVersionId) {
        active.receipt = { ...active.receipt, state: 'failed' };
        active.failedResponseReceived = true; active.failedLeaseSettled = true; active.canRetry = false;
        this.finish(job, true); continue;
      }
      // 普通读取缺失可能早于准备完成；只有明确失效状态才能取消在途作业。
      if (turn?.state === 'completed' && turn.requestKey === active.receipt.requestKey
        && turn.inputVersionId === active.receipt.inputVersionId) {
        active.receipt = { ...active.receipt, state: 'completed' };
        if (active.transportEnded) this.finish(job, true);
      }
      if (turn && ['redacted', 'unavailable'].includes(turn.state)) {
        active.terminal = true; active.controller.abort(); this.jobs.delete(job);
        this.executing.delete(job as OwnedAssistantGeneration);
      }
    }
    this.drain();
  }
  forget(owner: AssistantGenerationOwner): void {
    for (const [key, item] of this.finished) if (sameOwner(item, owner)) this.finished.delete(key);
    for (const [job, active] of this.jobs) if (sameOwner(job.identity, owner)) {
      active.terminal = true; active.controller.abort(); active.settlePreparation(); this.jobs.delete(job);
      this.executing.delete(job as OwnedAssistantGeneration);
    }
    this.drain();
  }
  async acquire(job: OwnedAssistantGeneration): Promise<void> {
    const active = this.jobs.get(job);
    if (!active?.receipt || !this.isActive(job)) throw new Error('本次任务已停止。');
    if (active.receipt.state === 'completed') return;
    active.stage = 'queued';
    await new Promise<void>((resolve, reject) => {
      const stop = () => { this.waiting.delete(job); reject(new Error('本次任务已停止。')); this.changed(); };
      this.waiting.set(job, { resolve: () => { job.signal.removeEventListener('abort', stop); resolve(); }, reject: stop });
      job.signal.addEventListener('abort', stop, { once: true });
      this.drain();
      this.changed();
    });
  }
  private drain(): void {
    if (this.closing || this.executing.size >= 1) return;
    for (const [job, next] of this.waiting) {
      this.waiting.delete(job);
      if (!this.isActive(job)) { next.reject(); continue; }
      this.executing.add(job); next.resolve(); break;
    }
  }
  completed(job: OwnedAssistantGeneration): void {
    const active = this.jobs.get(job);
    if (active?.receipt) active.receipt = { ...active.receipt, state: 'completed' };
  }

  begin(identity: AssistantGenerationIdentity, controller = new AbortController(),
    stopping?: AssistantGenerationStopping): OwnedAssistantGeneration {
    if (!isUuid(identity.requestKey)) throw new Error('本次生成归属无效。');
    return this.register(identity, controller, stopping) as OwnedAssistantGeneration;
  }
  // 准备阶段先登记已核验范围，实际请求键只由后端回执提供。
  beginPreparation(owner: AssistantGenerationOwner, controller = new AbortController(),
    stopping?: AssistantGenerationStopping, command?: AssistantPreparationCommandIdentity): OwnedAssistantPreparation {
    return this.register({ connectionGeneration: owner.connectionGeneration,
      contactId: owner.contactId, sessionId: owner.sessionId }, controller, stopping,
      command === undefined ? undefined : capturePreparationCommand(command));
  }
  private register(identity: AssistantGenerationOwner | AssistantGenerationIdentity,
    controller: AbortController, stopping?: AssistantGenerationStopping,
    preparationCommand?: AssistantPreparationCommandIdentity): OwnedAssistantPreparation {
    if (this.closing) throw new Error('应用正在退出，请重开后再生成。');
    if (([...this.jobs.keys()].filter((job) => job.identity.connectionGeneration === identity.connectionGeneration).length >= 8
      || this.jobs.size >= 32) && ![...this.jobs].some(([job, active]) => active.transportEnded
      && sameOwner(job.identity, identity) && 'requestKey' in identity && 'requestKey' in job.identity
      && job.identity.requestKey === identity.requestKey)) throw new Error('待处理任务已满，请等待现有任务完成或核对后重试。');
    if (!Number.isSafeInteger(identity.connectionGeneration) || identity.connectionGeneration < 0
      || !isUuid(identity.contactId) || !isUuid(identity.sessionId)) throw new Error('本次生成归属无效。');
    const job = Object.freeze({ identity: Object.freeze({ connectionGeneration: identity.connectionGeneration,
      contactId: identity.contactId.toLowerCase(), sessionId: identity.sessionId.toLowerCase(),
      ...('requestKey' in identity ? { requestKey: identity.requestKey.toLowerCase() } : {}) }), signal: controller.signal });
    let settlePreparation = () => {};
    const preparationSettled = new Promise<void>((resolve) => { settlePreparation = resolve; });
    this.jobs.set(job, { controller, viewRevision: this.viewRevision,
      stage: 'requestKey' in identity ? 'created' : 'preparing', preparationSettled, settlePreparation, stopping, preparationCommand });
    return job;
  }
  receivePrepared(preparation: OwnedAssistantPreparation, receipt: AssistantGenerationReceipt): OwnedAssistantGeneration {
    const active = this.jobs.get(preparation);
    if (!active || 'requestKey' in preparation.identity || receipt.sessionId !== preparation.identity.sessionId
      || !isUuid(receipt.requestKey) || !isUuid(receipt.turnId) || !isUuid(receipt.inputVersionId)
      || !['running', 'completed', 'failed'].includes(receipt.state)) throw new Error('本次生成回执归属无效。');
    const job = Object.freeze({ identity: Object.freeze({ ...preparation.identity,
      requestKey: receipt.requestKey.toLowerCase() }), signal: preparation.signal });
    this.jobs.delete(preparation); this.jobs.set(job, active); this.receiveReceipt(job, receipt);
    this.settleEndedUnknownPreparations(job, active);
    return job;
  }
  // 只有正式准备明确返回澄清等非候选结果时可用，传输结束不能证明未领取。
  completePreparationWithoutGeneration(preparation: OwnedAssistantPreparation): void {
    const active = this.jobs.get(preparation);
    if (!active || active.receipt) throw new Error('本次准备状态尚未确认。');
    active.settledWithoutGeneration = true; active.terminal = true; active.settlePreparation(); this.jobs.delete(preparation);
  }
  // 实际准备的同键未领取证明只结算无回执项，当前UI发布等finally再结束。
  receiveNoGenerationProof(job: OwnedAssistantGeneration, proof: AssistantNoGenerationProof,
    connectionGeneration: number | undefined): void {
    const active = this.jobs.get(job);
    if (!active || active.receipt || active.stage !== 'preparing'
      || connectionGeneration !== job.identity.connectionGeneration
      || Object.keys(proof).length !== 4 || !['contactId', 'sessionId', 'requestKey', 'state'].every((key) => Object.hasOwn(proof, key))
      || proof.state !== 'not_reserved' || proof.contactId !== job.identity.contactId
      || proof.sessionId !== job.identity.sessionId || proof.requestKey !== job.identity.requestKey) {
      throw new Error('本次未领取证明归属尚未确认。');
    }
    active.settledWithoutGeneration = true; active.settlePreparation();
    for (const [previousJob, previous] of this.jobs) {
      if (previousJob !== job && previous.transportEnded && !previous.receipt
        && sameOwner(previousJob.identity, job.identity) && 'requestKey' in previousJob.identity
        && previousJob.identity.requestKey === job.identity.requestKey) {
        previous.terminal = true; previous.settlePreparation(); this.jobs.delete(previousJob);
      }
    }
  }
  // 策略薄客户端先核验原命令证明；只有显式声明的同冻结命令可关联已结束未知身份。
  receivePreparationNoGenerationProof(preparation: OwnedAssistantPreparation, proof: AssistantNoGenerationProof,
    connectionGeneration: number | undefined): void {
    const active = this.jobs.get(preparation);
    if (!active || 'requestKey' in preparation.identity || active.receipt || active.stage !== 'preparing'
      || connectionGeneration !== preparation.identity.connectionGeneration
      || Object.keys(proof).length !== 4 || !['contactId', 'sessionId', 'requestKey', 'state'].every((key) => Object.hasOwn(proof, key))
      || proof.state !== 'not_reserved' || proof.contactId !== preparation.identity.contactId
      || proof.sessionId !== preparation.identity.sessionId || !isUuid(proof.requestKey)) {
      throw new Error('本次未领取证明归属尚未确认。');
    }
    active.settledWithoutGeneration = true; active.settlePreparation();
    this.settleEndedUnknownPreparations(preparation, active);
  }
  // 只按同冻结命令结算结束传输的未知身份；scope相同或没有回执均不能独自证明等价。
  private settleEndedUnknownPreparations(current: OwnedAssistantPreparation, active: ActiveJob): void {
    const command = active.preparationCommand;
    if (!command) return;
    for (const [previousJob, previous] of this.jobs) {
      if (previousJob !== current && previous.transportEnded && !previous.receipt && previous.stage === 'preparing'
        && !('requestKey' in previousJob.identity) && previous.preparationCommand
        && sameOwner(previousJob.identity, current.identity) && sameCommand(previous.preparationCommand, command)) {
        previous.terminal = true; previous.settlePreparation(); this.jobs.delete(previousJob);
      }
    }
  }
  prepareStarted(job: OwnedAssistantGeneration): void {
    const active = this.jobs.get(job);
    if (active?.stage === 'created') active.stage = 'preparing';
  }
  receiveReceipt(job: OwnedAssistantGeneration, receipt: AssistantGenerationReceipt): void {
    const active = this.jobs.get(job);
    if (!active || receipt.sessionId !== job.identity.sessionId || receipt.requestKey !== job.identity.requestKey
      || !isUuid(receipt.turnId) || !isUuid(receipt.inputVersionId)
      || !['running', 'completed', 'failed'].includes(receipt.state)) throw new Error('本次生成回执归属无效。');
    active.receipt = Object.freeze({ sessionId: receipt.sessionId, requestKey: receipt.requestKey,
      turnId: receipt.turnId, inputVersionId: receipt.inputVersionId, state: receipt.state });
    active.stage = 'prepared'; active.settlePreparation();
    // 同认证范围和同key的实际回执接管已结束传输的旧身份，不保留重复退出阻塞。
    for (const [previousJob, previous] of this.jobs) {
      if (previousJob !== job && sameOwner(previousJob.identity, job.identity)
        && ('requestKey' in previousJob.identity ? previousJob.identity.requestKey : previous.receipt?.requestKey) === job.identity.requestKey && previous.transportEnded
        && (!previous.receipt || previous.receipt.turnId === receipt.turnId
          && previous.receipt.inputVersionId === receipt.inputVersionId)) {
        previous.terminal = true; previous.settlePreparation(); this.jobs.delete(previousJob);
      }
    }
    if (this.closing) this.deliverClosingReceipt(job, active);
  }
  // 业务失败可结束本地等待，但历史 failed 不能证明 C 当前没有运行租约。
  failedResponseReceived(job: OwnedAssistantGeneration, canRetry = false, generationActive?: boolean): void {
    const active = this.jobs.get(job);
    if (active) {
      active.failedResponseReceived = true; active.canRetry = canRetry;
      if (generationActive === false) active.failedLeaseSettled = true;
    }
  }
  requestStarted(job: OwnedAssistantGeneration): void {
    const active = this.jobs.get(job);
    if (this.isActive(job) && active?.receipt) { active.stage = 'requesting'; this.changed(); }
  }
  leaveView(): void { this.viewRevision += 1; }
  isActive(job: OwnedAssistantPreparation): boolean {
    return !this.closing && this.jobs.has(job) && !this.jobs.get(job)?.terminal && !job.signal.aborted;
  }
  canPublish(job: OwnedAssistantGeneration, view: AssistantGenerationOwner): boolean {
    const active = this.jobs.get(job);
    return Boolean(this.isActive(job) && active && active.viewRevision === this.viewRevision && sameOwner(job.identity, view));
  }
  hasPending(owner: AssistantGenerationOwner): boolean {
    return [...this.jobs].some(([job, active]) => this.isActive(job) && !active.transportEnded && sameOwner(job.identity, owner) && active.receipt?.state !== 'completed');
  }
  // prepare是瞬时快照；failed重试发出长请求后才提供身份，completed重放仍保持原状态。
  requestReceipt(owner: AssistantGenerationOwner): PendingAssistantGenerationReceipt | undefined {
    for (const [job, active] of [...this.jobs].reverse()) {
      if (this.isActive(job) && sameOwner(job.identity, owner) && active.receipt && !active.failedResponseReceived
        && (active.receipt.state !== 'failed' || active.stage === 'requesting')) {
        return { ...job.identity, ...active.receipt };
      }
    }
    return undefined;
  }
  pendingReceipts(): PendingAssistantGenerationReceipt[] {
    return [...this.jobs].flatMap(([job, active]) => active.receipt ? [{ ...job.identity, ...active.receipt }] : []);
  }
  beginClosing(onReceipt: (receipt: PendingAssistantGenerationReceipt) => void | Promise<void>,
    recoverUnknown?: AssistantGenerationRecovery): Promise<void> {
    const retrying = this.closing;
    if (!this.closing) {
      this.closing = true; this.closingReceipt = onReceipt; this.closingRecovery = recoverUnknown; this.leaveView();
      this.closingJobs = [...this.jobs];
    }
    // 没有回执不等于没有准备请求；退出必须等到每个已接纳请求的准备阶段终结。
    return Promise.all((this.closingJobs ?? []).map(async ([job, active]) => {
      if (active.terminal) return;
      if (active.closingTask) {
        try { await active.closingTask; return; } catch { active.closingTask = undefined; }
      }
      await active.preparationSettled;
      if (active.terminal || active.settledWithoutGeneration) return;
      const recovery = active.stopping?.recover ?? this.closingRecovery;
      if (!active.receipt && retrying && recovery && 'requestKey' in job.identity) {
        const recovered = await recovery(job.identity as AssistantGenerationIdentity);
        if (recovered === null) { active.terminal = true; this.jobs.delete(job); return; }
        this.receiveReceipt(job as OwnedAssistantGeneration, recovered);
      }
      if (!active.receipt) throw new Error('本次生成身份尚未确认，退出尚未完成。');
      await this.deliverClosingReceipt(job, active);
    })).then(() => {});
  }
  private deliverClosingReceipt(job: OwnedAssistantPreparation, active: ActiveJob): Promise<void> | undefined {
    const receipt = active.receipt;
    if (!receipt) return undefined;
    if (!active.closingTask) {
      active.controller.abort();
      active.closingTask = Promise.resolve().then(() => (active.stopping?.interrupt ?? this.closingReceipt)?.({ ...job.identity, ...receipt })).then(() => {
        active.terminal = true; this.jobs.delete(job);
      });
      // 准备回调不会等待此 promise；排空调用负责向宿主报告失败。
      void active.closingTask.catch(() => {});
    }
    return active.closingTask;
  }
  cancelRequest(identity: AssistantGenerationIdentity): void {
    for (const [job, active] of this.jobs) if (sameOwner(job.identity, identity)
      && ('requestKey' in job.identity ? job.identity.requestKey : active.receipt?.requestKey) === identity.requestKey) active.controller.abort();
  }
  confirmReplacement(identity: AssistantGenerationIdentity): void {
    // 新替换的严格实际回执证明原租约已失效；仅取消transport不提供这项证明。
    for (const [job, active] of this.jobs) if (sameOwner(job.identity, identity)
      && ('requestKey' in job.identity ? job.identity.requestKey : active.receipt?.requestKey) === identity.requestKey) {
      active.terminal = true;
      this.executing.delete(job as OwnedAssistantGeneration);
      if (active.transportEnded) this.jobs.delete(job);
    }
    this.drain();
  }
  cancelSession(owner: AssistantGenerationOwner): void {
    for (const [job, active] of this.jobs) if (sameOwner(job.identity, owner)) active.controller.abort();
  }
  cancelContact(connectionGeneration: number, contactId: string): void {
    for (const [job, active] of this.jobs) if (job.identity.connectionGeneration === connectionGeneration
      && job.identity.contactId === contactId) active.controller.abort();
  }
  cancelAll(): void {
    for (const active of this.jobs.values()) active.controller.abort();
    this.executing.clear(); this.finished.clear();
  }
  finish(job: OwnedAssistantPreparation, terminal = false): void {
    const active = this.jobs.get(job);
    if (active?.receipt && (active.receipt.state === 'completed' || active.failedResponseReceived)) {
      const receipt = active.receipt;
      this.finished.set(receipt.requestKey, { connectionGeneration: job.identity.connectionGeneration,
        contactId: job.identity.contactId, sessionId: receipt.sessionId, requestKey: receipt.requestKey,
        turnId: receipt.turnId, inputVersionId: receipt.inputVersionId, canRetry: active.canRetry,
        phase: receipt.state === 'completed' ? 'completed' : 'failed' });
      while (this.finished.size > 32) this.finished.delete(this.finished.keys().next().value!);
    }
    this.executing.delete(job as OwnedAssistantGeneration);
    this.waiting.get(job as OwnedAssistantGeneration)?.reject();
    if (active) { active.transportEnded = true; active.settlePreparation(); }
    // 失败响应和历史 failed 不足以结算；只有当前实际租约复验终止，才释放失败身份。
    if (terminal || active?.failedLeaseSettled || active?.terminal || active?.settledWithoutGeneration || active?.stage === 'created' || active?.receipt?.state === 'completed') {
      if (active) active.terminal = true;
      this.jobs.delete(job);
    }
    this.drain(); this.changed();
  }
}
