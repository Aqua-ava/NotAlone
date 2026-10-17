import type { SavedAssistantSession, SavedAssistantTurn } from '../../shared/assistant-session';
import type { readAssistantSession } from './assistant-sessions';

export interface AssistantProjectionScope {
  connectionGeneration: number | undefined;
  contactId: string | null;
  scopeRevision: number;
  sessionId: string | null;
}
type Snapshot = Awaited<ReturnType<typeof readAssistantSession>>;
export interface AssistantProjectionVerification {
  readonly scope: AssistantProjectionScope;
  readonly revision: number;
  readonly boundary: number;
}
export interface AssistantProjectionRead extends AssistantProjectionVerification {
  readonly epoch: number;
}
export interface AssistantCompletionIdentity {
  requestKey: string;
  inputVersionId: string;
  replyRequestId: string;
}
export interface AssistantBudgetFailureIdentity { turnId: string; requestKey: string; inputVersionId: string }
type BudgetRead = { kind: 'snapshot'; snapshot: Snapshot } | { kind: 'unknown' | 'unavailable' | 'missing' };
type BudgetEvidence = { kind: 'received'; identity: AssistantBudgetFailureIdentity; read: BudgetRead }
  | { kind: 'unconfirmed'; read: BudgetRead };
type Rejected = { kind: 'superseded' | 'unknown' } | { kind: 'unavailable'; reason: 'identity' | 'source' };
export type AssistantCompletionDecision = Rejected | { kind: 'accepted'; snapshot: SavedAssistantSession;
  turn: SavedAssistantTurn; verifiedTurn: SavedAssistantTurn; retainedDisplay: boolean };
export type AssistantBudgetFailureDecision = Rejected | { kind: 'accepted'; snapshot: SavedAssistantSession;
  turn: SavedAssistantTurn };

// 只持有当前展示的引用；业务响应、网络取消和生成任务的终态仍由各自调用方负责。
export class AssistantSessionProjection {
  private scope: AssistantProjectionScope = { connectionGeneration: undefined, contactId: null, scopeRevision: 0, sessionId: null };
  private revision = 0;
  private boundary = 0;
  private readEpoch = 0;
  private displayed: SavedAssistantSession | undefined;
  private authoritative = false;

  registerDisplay(scope: AssistantProjectionScope, snapshot?: SavedAssistantSession,
    origin: 'authoritative' | 'local' = 'local'): void {
    const changed = scope.connectionGeneration !== this.scope.connectionGeneration
      || scope.contactId !== this.scope.contactId || scope.scopeRevision !== this.scope.scopeRevision
      || scope.sessionId !== this.scope.sessionId;
    if (changed) {
      // 首次取得SID不撤销同一范围的读取；切离、清空及再次进入均使旧票据失效。
      if (scope.connectionGeneration !== this.scope.connectionGeneration || scope.contactId !== this.scope.contactId
        || scope.scopeRevision !== this.scope.scopeRevision || this.scope.sessionId !== null) this.boundary += 1;
      this.scope = { ...scope };
      this.displayed = undefined;
    }
    const displayChanged = snapshot !== undefined && (snapshot !== this.displayed || this.authoritative !== (origin === 'authoritative'));
    if (snapshot !== undefined) { this.displayed = snapshot; this.authoritative = origin === 'authoritative'; }
    if (changed || displayChanged) this.revision += 1;
  }

  beginVerification(scope: AssistantProjectionScope): AssistantProjectionVerification {
    return { scope: { ...scope }, revision: this.revision, boundary: this.boundary };
  }

  beginRead(scope: AssistantProjectionScope): AssistantProjectionRead {
    return { ...this.beginVerification(scope), epoch: ++this.readEpoch };
  }

  resolveReadSession(read: AssistantProjectionRead, sessionId: string): AssistantProjectionRead {
    // default 的异步选择只绑定本轮解析出的SID，绝不把空SID当作跨会话通配符。
    return { ...read, scope: { ...read.scope, sessionId } };
  }

  isReadCurrent(read: AssistantProjectionRead): boolean {
    return read.epoch === this.readEpoch && read.revision === this.revision && this.current(read);
  }

  acceptRead(read: AssistantProjectionRead, saved: Snapshot): Rejected | {
    kind: 'accepted'; snapshot: SavedAssistantSession; read: AssistantProjectionRead } {
    if (!this.isReadCurrent(read) || saved.generation !== read.scope.connectionGeneration
      || read.scope.sessionId !== null && saved.sessionId !== read.scope.sessionId
      || this.scope.sessionId !== null && saved.sessionId !== this.scope.sessionId) return { kind: 'superseded' };
    const snapshot = this.ready(saved);
    this.registerDisplay({ ...read.scope, sessionId: saved.sessionId }, snapshot, 'authoritative');
    return { kind: 'accepted', snapshot, read: { ...read, revision: this.revision,
      scope: { ...read.scope, sessionId: saved.sessionId } } };
  }

  failRead(read: AssistantProjectionRead, failure: 'unavailable' | 'unknown'): Rejected | {
    kind: 'failed'; failure: 'unavailable' | 'unknown'; snapshot: SavedAssistantSession } {
    if (!this.isReadCurrent(read)) return { kind: 'superseded' };
    return { kind: 'failed', failure, snapshot: { phase: 'failed', sessionId: read.scope.sessionId,
      turns: [], inputs: [], currentInputVersionId: null } };
  }

  invalidateSource(owner?: AssistantProjectionRead): AssistantProjectionRead | undefined {
    const owned = owner && this.isReadCurrent(owner);
    this.boundary += 1; this.readEpoch += 1;
    return owned ? { ...owner, boundary: this.boundary, epoch: this.readEpoch } : undefined;
  }

  acceptSourceProjection(read: AssistantProjectionRead, snapshot: SavedAssistantSession): AssistantProjectionRead | undefined {
    // 来源核验会先撤下局部正文再发布完整投影；只续接它自己的读取，不夺取较晚读取。
    if (read.epoch !== this.readEpoch || !this.current(read) || !this.authoritative || snapshot !== this.displayed) return;
    return { ...read, revision: this.revision };
  }

  acceptCompletion(verification: AssistantProjectionVerification, saved: Snapshot,
    identity: AssistantCompletionIdentity): AssistantCompletionDecision {
    if (!this.current(verification) || saved.generation !== verification.scope.connectionGeneration
      || saved.sessionId !== verification.scope.sessionId) return { kind: 'superseded' };
    const retainedDisplay = verification.revision !== this.revision;
    const snapshot = retainedDisplay ? this.displayed : this.ready(saved);
    if (!snapshot || snapshot.phase !== 'ready' || snapshot.sessionId !== saved.sessionId
      || retainedDisplay && !this.authoritative) return { kind: 'superseded' };
    const turn = this.completed(snapshot, identity);
    if (!turn) return retainedDisplay ? { kind: 'superseded' } : { kind: 'unavailable', reason: 'identity' };
    const verifiedTurn = this.completed(saved, identity);
    if (!verifiedTurn) return { kind: 'unavailable', reason: 'identity' };
    return { kind: 'accepted', snapshot, turn, verifiedTurn, retainedDisplay };
  }

  acceptBudgetFailure(verification: AssistantProjectionVerification, evidence: BudgetEvidence): AssistantBudgetFailureDecision {
    if (!this.current(verification)) return { kind: 'superseded' };
    if (evidence.read.kind === 'unavailable') return { kind: 'unavailable', reason: 'source' };
    const retainedDisplay = verification.revision !== this.revision;
    if (retainedDisplay && (evidence.kind !== 'received' || !this.authoritative
      || this.displayed?.phase !== 'ready' || this.displayed.sessionId !== verification.scope.sessionId
      || !this.failed(this.displayed, evidence.identity))) return { kind: 'superseded' };
    if (evidence.read.kind === 'unknown') return { kind: 'unknown' };
    if (evidence.kind !== 'received' || evidence.read.kind !== 'snapshot') return { kind: 'unavailable', reason: 'identity' };
    const saved = evidence.read.snapshot;
    if (saved.generation !== verification.scope.connectionGeneration || saved.sessionId !== verification.scope.sessionId) {
      return { kind: 'superseded' };
    }
    if (!this.failed(saved, evidence.identity)) return { kind: 'unavailable', reason: 'identity' };
    const snapshot = retainedDisplay ? this.displayed! : this.ready(saved);
    return { kind: 'accepted', snapshot, turn: this.failed(snapshot, evidence.identity)! };
  }

  private failed(saved: Pick<SavedAssistantSession, 'turns' | 'inputs' | 'currentInputVersionId'>,
    identity: AssistantBudgetFailureIdentity): SavedAssistantTurn | undefined {
    if (saved.currentInputVersionId !== identity.inputVersionId || !saved.inputs.some((input) =>
      input.inputVersionId === identity.inputVersionId && input.turnId === identity.turnId && input.state === 'active')) return;
    return saved.turns.find((turn) => turn.turnId === identity.turnId && turn.requestKey === identity.requestKey
      && turn.inputVersionId === identity.inputVersionId && turn.state === 'failed');
  }

  private ready(saved: Snapshot): SavedAssistantSession {
    return { phase: 'ready', sessionId: saved.sessionId, turns: saved.turns, inputs: saved.inputs,
      currentInputVersionId: saved.currentInputVersionId };
  }

  private completed(saved: Pick<SavedAssistantSession, 'turns' | 'inputs' | 'currentInputVersionId'>,
    identity: AssistantCompletionIdentity): SavedAssistantTurn | undefined {
    if (saved.currentInputVersionId !== identity.inputVersionId
      || !saved.inputs.some((input) => input.inputVersionId === identity.inputVersionId && input.state === 'active')) return;
    return saved.turns.find((turn) => turn.inputVersionId === identity.inputVersionId && turn.requestKey === identity.requestKey
      && turn.state === 'completed' && turn.reply?.replyRequestId === identity.replyRequestId);
  }

  private current(verification: AssistantProjectionVerification): boolean {
    return verification.boundary === this.boundary
      && verification.scope.connectionGeneration === this.scope.connectionGeneration
      && verification.scope.contactId === this.scope.contactId && verification.scope.scopeRevision === this.scope.scopeRevision
      && (this.scope.sessionId === null || verification.scope.sessionId === this.scope.sessionId);
  }
}
