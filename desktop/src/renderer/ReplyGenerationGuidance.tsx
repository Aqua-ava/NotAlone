import type { ReplySessionState } from '../shared/reply-bridge';

export function needsDirectionClarification(state: ReplySessionState): boolean {
  const result = state.exploration.result;
  return Boolean(result && (result.question || result.ambiguities.length));
}

export function DirectionGenerationNotice({ state }: { state: ReplySessionState }) {
  const result = state.exploration.result;
  if (!result || !needsDirectionClarification(state)) return null;
  return <div className="reply-generation-guidance" role="status">
    <strong>{result.question ? '还有关键问题，尚未生成新候选' : '仍有待澄清的信息，尚未生成新候选'}</strong>
    <p>{result.question?.text ?? '请填写“补充你的想法或要求”，再点击“更新理解”。'}</p>
    {result.question && <button onClick={() => {
      const answer = document.getElementById('reply-clarification-answer');
      answer?.focus();
      answer?.scrollIntoView({ block: 'center' });
    }}>去回答关键问题</button>}
  </div>;
}

export function hasChangedReplyInput(state: ReplySessionState): boolean {
  const input = state.result?.input;
  if (!input) return false;
  if (input.mode !== state.mode) return true;
  if (input.mode === 'rewrite_draft') {
    if (input.inputKind !== 'workspace') return false;
    return input.workspaceAction !== state.options.workspaceAction
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
