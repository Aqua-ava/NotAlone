import { invalidatedSqliteDiscussion } from './sqlite-discussion-read';
import type { SavedAssistantSession } from '../../shared/assistant-session';
import type { readAssistantSession } from './assistant-sessions';

export interface AssistantProjectionScope {
  connectionGeneration: number | undefined;
  contactId: string | null;
  scopeRevision: number;
  sessionId: string | null;
}
type Snapshot = Awaited<ReturnType<typeof readAssistantSession>>;
interface AssistantProjectionVerification {
  readonly scope: AssistantProjectionScope;
  readonly revision: number;
  readonly boundary: number;
}
export interface AssistantProjectionRead extends AssistantProjectionVerification {
  readonly epoch: number;
}
type Rejected = { kind: 'superseded' };

// 只仲裁当前 SQLite 讨论的读取；来源、连接和会话变化立即撤销旧票据。
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

  beginRead(scope: AssistantProjectionScope): AssistantProjectionRead {
    return { scope: { ...scope }, revision: this.revision, boundary: this.boundary, epoch: ++this.readEpoch };
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
    return { kind: 'failed', failure, snapshot: { phase: 'failed', sessionId: read.scope.sessionId, ...invalidatedSqliteDiscussion() } };
  }

  invalidateSource(): void {
    this.boundary += 1; this.readEpoch += 1;
  }

  private ready(saved: Snapshot): SavedAssistantSession {
    return { phase: 'ready', sessionId: saved.sessionId,
      discussionEntries: saved.discussionEntries, runtimeRecovery: saved.runtimeRecovery };
  }

  private current(verification: AssistantProjectionVerification): boolean {
    return verification.boundary === this.boundary
      && verification.scope.connectionGeneration === this.scope.connectionGeneration
      && verification.scope.contactId === this.scope.contactId && verification.scope.scopeRevision === this.scope.scopeRevision
      && (this.scope.sessionId === null || verification.scope.sessionId === this.scope.sessionId);
  }
}
