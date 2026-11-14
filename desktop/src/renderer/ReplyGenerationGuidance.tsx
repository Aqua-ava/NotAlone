import type { ReplySessionState } from '../shared/reply-bridge';

export function hasChangedReplyInput(state: ReplySessionState, currentDraft?: string): boolean {
  const input = state.result?.input;
  if (!input) return false;
  if (input.mode !== state.mode) return true;
  if (input.mode === 'rewrite_draft') {
    if (input.inputKind !== 'workspace') return false;
    return currentDraft !== undefined && input.draftText.trim() !== currentDraft.trim()
      || input.workspaceAction !== state.options.workspaceAction
      || (input.contextText ?? '').trim() !== (state.options.contextText ?? '').trim()
      || input.includeRelationshipContext !== state.options.includeRelationshipContext;
  }
  return (input.mode === 'reply_to_message'
    ? input.target.messageId !== state.targetMessageId || input.direction.trim() !== state.direction.trim()
    : input.purpose.trim() !== state.purpose.trim())
    || (input.correction ?? '').trim() !== state.correction.trim()
    || (input.userInstruction ?? '').trim() !== state.requirements.trim();
}
