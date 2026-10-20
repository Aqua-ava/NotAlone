import type { ReplySessionView } from './RewritePanel';

export function AssistantMessageNoticeActions({ replies, hasUnsavedEdits = false }: {
  replies: ReplySessionView;
  hasUnsavedEdits?: boolean;
}) {
  const { state } = replies;
  const workspace = state.mode === 'rewrite_draft' && state.options.inputKind === 'workspace';
  if (!state.messageNotice.changed || state.mode === 'rewrite_draft' && !workspace) return null;
  const contextDisabled = workspace && !state.options.includeRelationshipContext;
  const disabled = !state.savedSession?.sessionId || Boolean(state.generationBlock)
    || state.sourceAvailability !== undefined || state.sessionCatalog?.selectionPending
    || state.sessionDeletion === 'deleting' || state.sessionDeletion === 'failed' || hasUnsavedEdits || contextDisabled;
  return <section aria-label="采用新消息">
    <p role="status">新消息尚未结合。点击后保留本次输入和要求，结合新消息重新生成。</p>
    <button disabled={disabled} onClick={() => void replies.combineNewMessages()}>结合新消息重新生成</button>
    {hasUnsavedEdits && <p role="status">请结束正文编辑，等待自动保存后再结合新消息。</p>}
    {contextDisabled && <p role="status">请先启用联系人上下文，再结合新消息。</p>}
  </section>;
}
