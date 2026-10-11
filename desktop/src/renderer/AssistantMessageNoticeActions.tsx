import type { ReplySessionView } from './RewritePanel';

export function AssistantMessageNoticeActions({ replies, hasUnsavedEdits = false }: {
  replies: ReplySessionView;
  hasUnsavedEdits?: boolean;
}) {
  const { state } = replies;
  if (!state.messageNotice.changed || state.mode === 'rewrite_draft') return null;
  const disabled = !state.savedSession?.sessionId || Boolean(state.generationBlock)
    || state.sourceAvailability !== undefined || state.sessionCatalog?.selectionPending
    || state.sessionDeletion === 'deleting' || state.sessionDeletion === 'failed' || hasUnsavedEdits;
  return <section aria-label="采用新消息">
    <p role="status">新消息尚未结合。点击后按当前明确方向或目的重新生成。</p>
    <button disabled={disabled} onClick={() => void replies.combineNewMessages()}>结合新消息继续</button>
    {hasUnsavedEdits && <p role="status">请先保存本组修改，再结合新消息。</p>}
  </section>;
}
