import type { SavedAssistantSession } from '../../shared/assistant-session';
import type { BackendHost } from '../backend/host';
import { readAssistantSession } from './assistant-sessions';
import { readReplyMessages } from './messages';
import { interruptedReplyInput } from './assistant-interrupted-retry';
import { isUuid } from '../uuid';
import type { ReplySessionState } from '../../shared/reply-bridge';

// 仅保留本次输入；权限、请求状态、消息正文和已保存讨论必须重新读取。
export type RetainedContactContent = {
  sessionId: string | null;
  draft: string;
  notice?: string;
  result?: { continuation?: NonNullable<ReplySessionState['result']>['continuation']; replyRequestId: string; selectedCandidateId: string | null; edits: { candidateId: string; text: string }[] };
  directionDerived: boolean;
  inputVersionId: string | null;
  candidateDrafts: NonNullable<ReplySessionState['candidateDrafts']>;
  input: Pick<ReplySessionState, 'options' | 'mode' | 'targetMessageId' | 'direction' | 'purpose'
    | 'correction' | 'requirements' | 'supplementInput' | 'clarificationAnswer' | 'skillChoice' | 'scene'>;
};

export function retainContactContent(state: ReplySessionState, directionDerived: boolean, draft: string): RetainedContactContent | undefined {
  if (state.sessionDeletion === 'deleting' || state.sessionDeletion === 'failed'
    || state.sessionCatalog?.selectionPending || state.sourceAvailability) return;
  const { options, mode, targetMessageId, direction, purpose, correction, requirements, supplementInput, clarificationAnswer, skillChoice, scene } = state;
  return structuredClone({ sessionId: state.savedSession?.sessionId ?? null, draft, directionDerived, inputVersionId: state.savedSession?.currentInputVersionId ?? state.result?.inputVersionId ?? null, candidateDrafts: state.candidateDrafts ?? [],
    result: state.result ? { continuation: state.result.continuation, replyRequestId: state.result.replyRequestId, selectedCandidateId: state.selectedCandidateId,
      edits: state.result.candidates.map((candidate) => ({ candidateId: candidate.original.candidateId, text: candidate.editedText })) } : undefined,
    input: { options, mode, targetMessageId, direction, purpose, correction, requirements, supplementInput, clarificationAnswer, skillChoice, scene } });
}

// 混合补充可能含来源派生理解；只有明确来自旧独立要求入口的内容可继续保留。
export function invalidatedSupplement(input: RetainedContactContent['input']): Partial<RetainedContactContent['input']> {
  return input.supplementInput === true || input.mode !== 'rewrite_draft' && input.supplementInput !== false ? { requirements: '', supplementInput: false } : {};
}

// 只有权威读取确认后的字段可以回到视图；失效引用只清理相关输入。
export async function validateContactInput(backend: BackendHost, contactId: string,
  content: RetainedContactContent, contactDisplayName: string, saved: SavedAssistantSession, signal: AbortSignal,
  current: () => boolean): Promise<Partial<ReplySessionState>> {
  const generation = backend.getConnectionGeneration();
  const update: Partial<ReplySessionState> = structuredClone(content.input);
  const notices: string[] = content.notice ? [content.notice] : [];
  if (content.inputVersionId && !saved.inputs.some((input) => input.inputVersionId === content.inputVersionId && input.state === 'active')) {
    update.correction = ''; update.clarificationAnswer = '';
    Object.assign(update, invalidatedSupplement(content.input));
    if (content.directionDerived) { update.direction = ''; update.purpose = ''; }
    notices.push('原讨论来源已失效，相关理解已清除。');
  }
  if (content.input.targetMessageId) {
    const seen = new Set<string>(); let cursor: string | null = null;
    do {
      const page = await readReplyMessages(backend, contactId, cursor, signal);
      if (!current() || page.generation !== generation) throw new Error('恢复范围已变化。');
      const target = page.messages.find((message) => message.messageId === content.input.targetMessageId);
      if (target) { update.messages = { phase: 'ready', items: page.messages, nextCursor: page.nextCursor }; break; }
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('待回复对象尚未核对。');
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (!update.messages) {
      update.targetMessageId = null; update.correction = ''; update.clarificationAnswer = '';
      Object.assign(update, invalidatedSupplement(content.input));
      if (content.directionDerived) update.direction = '';
      notices.push('待回复对象已不可用，请重新选择。');
    }
  }
  if (content.input.skillChoice.mode === 'user') {
    const response = await backend.requestJson({ method: 'GET', path: '/api/skills', signal, timeoutMs: 10_000 });
    if (!current() || response.generation !== generation) throw new Error('恢复范围已变化。');
    const data = response.data as { skills?: unknown };
    if (!data || !Array.isArray(data.skills)) throw new Error('Skill 列表尚未核对。');
    const choices: ReplySessionState['skillChoices'] = [];
    for (const item of data.skills) {
      if (!item || typeof item !== 'object' || typeof item.enabled !== 'boolean'
        || !(item.contact_id === null || isUuid(item.contact_id))) throw new Error('Skill 列表尚未核对。');
      if (item.status !== 'active' || !item.enabled || item.contact_id !== null && item.contact_id !== contactId) continue;
      if (!isUuid(item.current_version_id) || typeof item.name !== 'string' || !Number.isSafeInteger(item.current_version_number)) {
        throw new Error('Skill 版本尚未核对。');
      }
      choices.push({ name: item.name, versionId: item.current_version_id, versionNumber: item.current_version_number });
    }
    update.skillChoices = choices;
    if (!choices.some((item) => item.versionId === content.input.skillChoice.versionId)) {
      update.skillChoice = { mode: 'auto', versionId: null };
      notices.push('原 Skill 已不可用，已恢复为自动选择。');
    }
  }
  if (content.result) {
    const turn = saved.turns.find((turn) => turn.state === 'completed' && turn.reply?.replyRequestId === content.result!.replyRequestId);
    if (turn?.reply) {
      const input = await interruptedReplyInput(backend, turn, { contactId, displayName: contactDisplayName }, signal, current);
      if (!current()) throw new Error('恢复范围已变化。');
      update.result = { replyRequestId: turn.reply.replyRequestId, assistantSessionId: saved.sessionId!,
        inputVersionId: turn.inputVersionId, input, continuation: content.result.continuation, contextEvidenceIds: turn.reply.contextEvidenceIds,
        styleSampleIds: turn.reply.styleSampleIds, expressionPreferenceIds: turn.reply.expressionPreferenceIds,
        expressionPreferences: turn.reply.expressionPreferences,
        usedSkill: turn.reply.usedSkill, inputBudget: turn.reply.inputBudget,
        basisChanges: turn.basisChanges ?? turn.reply.basisChanges,
        candidates: turn.reply.candidates.map((original) => ({ original,
          editedText: content.result!.edits.find((edit) => edit.candidateId === original.candidateId)?.text ?? original.text })) };
      update.selectedCandidateId = turn.reply.candidates.some((candidate) => candidate.candidateId === content.result!.selectedCandidateId)
        ? content.result.selectedCandidateId : null;
      update.phase = 'ready';
    } else notices.push('原候选来源已不可用，相关编辑未恢复。');
  }
  update.contentRestoreNotice = notices.join(' ') || undefined;
  return update;
}

export function removeDependentContent(content: RetainedContactContent): RetainedContactContent {
  return { ...content, notice: '部分来源尚未核对，相关派生内容已清除，独立输入仍保留。', result: undefined, candidateDrafts: [], inputVersionId: null,
    input: { ...content.input, targetMessageId: null, correction: '', clarificationAnswer: '',
      ...invalidatedSupplement(content.input),
      ...(content.directionDerived ? { direction: '', purpose: '' } : {}) } };
}

// 删除检查点同样清洗非当前联系人；只把权威读取仍认可的依赖留在内存。
export async function revalidateRetainedContent(backend: BackendHost, contactId: string,
  content: RetainedContactContent, signal: AbortSignal, current: () => boolean): Promise<RetainedContactContent> {
  if (!content.sessionId) return content;
  const saved = await readAssistantSession(backend, contactId, content.sessionId, signal);
  if (!current() || saved.generation !== backend.getConnectionGeneration()) throw new Error('删除复验范围已变化。');
  const update = await validateContactInput(backend, contactId, content, '', { ...saved, phase: 'ready' }, signal, current);
  const valid = new Set(saved.turns.flatMap((turn) => turn.reply?.candidates.map((candidate) => candidate.candidateId) ?? []));
  const { options, mode, targetMessageId, direction, purpose, correction, requirements, supplementInput, clarificationAnswer, skillChoice, scene } = { ...content.input, ...update };
  return { ...content, notice: update.contentRestoreNotice, result: update.result ? content.result : undefined,
    candidateDrafts: content.candidateDrafts.filter((draft) => valid.has(draft.candidateId)),
    input: { options, mode, targetMessageId, direction, purpose, correction, requirements, supplementInput, clarificationAnswer, skillChoice, scene } };
}
