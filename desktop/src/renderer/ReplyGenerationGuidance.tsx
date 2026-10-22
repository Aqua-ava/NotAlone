import type { ReplySessionState } from '../shared/reply-bridge';

export function needsDirectionClarification(state: ReplySessionState): boolean {
  const result = state.exploration.result;
  return Boolean(result && (result.question || result.ambiguities.length));
}

export function hasChangedReplyInput(state: ReplySessionState, currentDraft?: string): boolean {
  const input = state.result?.input;
  if (!input) return false;
  if (input.mode !== state.mode) return true;
  if (input.mode === 'rewrite_draft') {
    if (input.inputKind !== 'workspace') return false;
    const tones = { original: '', warm: '本次语气自然温和。', concise: '本次表达简洁直接。', polite: '本次语气礼貌克制。' };
    const instruction = [tones[state.options.tone], (state.options.instruction ?? '').trim()].filter(Boolean).join('\n');
    return currentDraft !== undefined && input.draftText.trim() !== currentDraft.trim()
      || (input.userInstruction ?? '').trim() !== instruction
      || input.workspaceAction !== state.options.workspaceAction
      || (input.contextText ?? '').trim() !== (state.options.contextText ?? '').trim()
      || input.includeRelationshipContext !== state.options.includeRelationshipContext
      || JSON.stringify([...(input.excludedMessageIds ?? [])].sort()) !== JSON.stringify([...(state.options.excludedMessageIds ?? [])].sort());
  }
  return (input.mode === 'reply_to_message'
    ? input.target.messageId !== state.targetMessageId || input.direction.trim() !== state.direction.trim()
    : input.purpose.trim() !== state.purpose.trim())
    || (input.correction ?? '').trim() !== state.correction.trim()
    || (input.userInstruction ?? '').trim() !== state.requirements.trim();
}
