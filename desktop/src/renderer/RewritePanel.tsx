import type { AssistantSessionDeletion, ReplySessionState } from '../shared/reply-bridge';
import { useRevisionedSession } from './use-revisioned-session';
import { AssistantSessionPanel } from './AssistantSessionPanel';
import './rewrite.css';

export function useReplySession(enabled = true) {
  const { state, error, setError, latest, active, receive, retry } = useRevisionedSession<ReplySessionState>({
    revision: -1, scopeRevision: 0, contactId: null, generationBlock: 'foreground-confirmation-required',
  }, window.notalone.replies, enabled);
  async function operate(operation: () => Promise<ReplySessionState | void>) {
    const scopeRevision = latest.current.scopeRevision;
    try {
      const next = await operation(); if (next) receive(next);
      if (active.current && scopeRevision === latest.current.scopeRevision) setError('');
    } catch {
      if (active.current && scopeRevision === latest.current.scopeRevision) setError('本次表达操作暂时不可用，请重新确认联系人。');
    }
  }
  const selection = () => ({ contactId: latest.current.contactId!, scopeRevision: latest.current.scopeRevision });
  return { state, error, retry,
    retrySourceValidation: () => operate(() => window.notalone.replies.retrySourceValidation(selection())),
    readSavedSession: () => operate(() => window.notalone.replies.readSavedSession(selection())),
    listSavedSessions: () => operate(() => window.notalone.replies.listSavedSessions(selection())),
    newSavedSession: () => operate(() => window.notalone.replies.newSavedSession(selection())),
    viewSavedSession: (sessionId: string) => operate(() => window.notalone.replies.viewSavedSession({ ...selection(), sessionId })),
    resumeSavedSession: (sessionId: string) => operate(() => window.notalone.replies.resumeSavedSession({ ...selection(), sessionId })),
    deleteSavedSession: (command: AssistantSessionDeletion) => operate(() => window.notalone.replies.deleteSavedSession(command)),
  };
}
export type ReplySessionView = ReturnType<typeof useReplySession>;

export function ReplyCandidates({ replies, currentDraft, onDraftChange }: {
  replies: ReplySessionView; currentDraft?: string;
  onDraftChange?: (text: string, scope: { contactId: string; scopeRevision: number }) => void;
}) {
  return <>
    <AssistantSessionPanel replies={replies} initialDraft={currentDraft} onDraftChange={onDraftChange} />
    {replies.error && <p className="reply-note" role="alert">{replies.error}<button className="button" onClick={() => void replies.retry()}>重试读取</button></p>}
  </>;
}
