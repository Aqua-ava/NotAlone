import { HelperDraft, type ContactSessionView } from './contact-session';
import type { ReplySessionView } from './RewritePanel';

/** 讨论尚未就绪时只编辑独立想法；就绪后由 SQLite 工作区接收同一联系人草稿。 */
export function AssistantWorkspaceDraft({ contacts, replies }: { contacts: ContactSessionView; replies: ReplySessionView }) {
  const { state } = replies;
  if (state.savedSession?.phase === 'ready' && Boolean(state.savedSession.sessionId) && state.savedSession.discussionEntries !== undefined) return null;
  const sameScope = Boolean(state.contactId) && state.contactId === contacts.state.selectedContactId
    && state.scopeRevision === contacts.state.scopeRevision;
  return <section className="compose-panel unified-workspace" aria-label="表达工作区">
    <header className="compose-heading"><h2>有什么想说的？</h2><p>想法会独立保留，讨论就绪后可以继续表达。</p></header>
    <HelperDraft key={`${contacts.state.selectedContactId}:${contacts.state.scopeRevision}`} session={contacts} workspace
      restoreRevision={state.inputClearRevision}
      disabled={!sameScope || state.sessionDeletion === 'deleting' || state.sessionDeletion === 'failed'} />
    {state.generationBlock && <p role="status">请先在上方确认本次联系人。</p>}
  </section>;
}
