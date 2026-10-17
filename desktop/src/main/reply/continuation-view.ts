import type { ReplyInputSnapshot, ReplySessionState } from '../../shared/reply-bridge';
import { captureDisplayedCandidateGroup } from './assistant-continuation';
import { sceneSnapshot } from './scene';

// 与公开候选区显示同一组；只捕获已复验的版本身份，不从复制或默认选中推断引用。
export function captureReplyContinuation(state: ReplySessionState, sessionId: string) {
  const saved = state.savedSession;
  const expected = saved?.currentInputVersionId;
  if (state.sourceAvailability || saved?.phase !== 'ready' || saved.sessionId !== sessionId || !expected
    || !saved.turns.some((turn) => turn.inputVersionId === expected && turn.state === 'completed')
    || !saved.inputs.some((input) => input.inputVersionId === expected && input.state === 'active')) {
    throw new Error('请先读取当前会话中已完成且来源有效的讨论。');
  }
  const recovered = !state.result ? saved.turns.filter((turn) => turn.state === 'completed' && turn.reply).at(-1) : undefined;
  const candidates = state.result?.candidates.map((item) => item.original) ?? recovered?.reply?.candidates ?? [];
  const versions = state.candidateVersions;
  if (candidates.length < 1 || versions?.phase !== 'ready' || versions.sessionId !== sessionId) {
    throw new Error('请先显示本会话的一组候选及其版本。');
  }
  let candidateGroupId: string | undefined;
  const shown = candidates.map((candidate, index) => {
    const view = versions.items.find((item) => item.candidateId === candidate.candidateId);
    const history = view?.history;
    if (view?.phase !== 'ready' || !history || history.sessionId !== sessionId
      || history.candidateId !== candidate.candidateId || history.candidateNumber !== index + 1
      || !view.displayVersionId || !history.versions.some((version) => version.versionId === view.displayVersionId)
      || candidateGroupId && history.candidateGroupId !== candidateGroupId) {
      throw new Error('当前展示的候选组或版本尚未可靠核对。');
    }
    candidateGroupId = history.candidateGroupId;
    return { number: history.candidateNumber, candidateId: candidate.candidateId, versionId: view.displayVersionId };
  });
  return { expectedInputVersionId: expected,
    displayedGroup: captureDisplayedCandidateGroup(sessionId, candidateGroupId!, shown) };
}

// 展示后端实际生效输入；编号继续的草稿仍保留整组版本编辑能力。
export function continuationInputSnapshot(value: Record<string, unknown>, state: ReplySessionState,
  contactDisplayName: string, scene?: string | null): ReplyInputSnapshot {
  const common = { contactId: state.contactId!, contactDisplayName, ...sceneSnapshot(scene) };
  if (value.type === 'rewrite_draft' && typeof value.draft_text === 'string'
    && (value.user_instruction === null || typeof value.user_instruction === 'string')
    && typeof value.include_relationship_context === 'boolean') return { ...common, mode: 'rewrite_draft',
    draftText: value.draft_text, userInstruction: value.user_instruction, includeRelationshipContext: value.include_relationship_context };
  const optionalText = (key: string) => value[key] === null || value[key] === undefined ? ''
    : typeof value[key] === 'string' ? value[key] as string : undefined;
  const correction = optionalText('understanding_correction'), userInstruction = optionalText('user_instruction');
  const clarificationAnswer = optionalText('clarification_answer');
  if ([correction, userInstruction, clarificationAnswer].includes(undefined)) throw new Error('本次生效输入格式无效。');
  if (value.type === 'initiate_conversation' && typeof value.purpose === 'string') return { ...common,
    mode: 'initiate_conversation', purpose: value.purpose, correction, userInstruction, clarificationAnswer };
  if (value.type === 'reply_to_message' && typeof value.direction === 'string') {
    const old = state.result?.input;
    const target = state.messages.items.find((message) => message.messageId === value.target_message_id)
      ?? (old?.mode === 'reply_to_message' && old.target.messageId === value.target_message_id ? old.target : undefined);
    if (target) return { ...common, mode: 'reply_to_message', target: structuredClone(target),
      direction: value.direction, correction, userInstruction, clarificationAnswer };
  }
  throw new Error('本次生效输入尚不能可靠展示。');
}
