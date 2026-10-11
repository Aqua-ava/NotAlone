import type { DirectionExploration, ReplySkillChoice } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';
import { isUuid } from '../uuid';
import { defaultAssistantSession } from './assistant-sessions';
import { isRecord, readReplyResult } from './result-read';
import { readAssistantGenerationReceipt, type AssistantGenerationReceipt } from './assistant-generation-jobs';

export interface ExplorationRequest {
  contactId: string; sessionId: string; operationKey: string; expectedInputVersionId: string | null;
  previousId: string | null; scene: 'reply_to_message' | 'initiate_conversation';
  targetMessageId: string | null; purposeHint: string; correction: string; requirements: string;
  skill: ReplySkillChoice; changeGroup: boolean; automatic?: boolean;
}
export type ExplorationAction = { contactId: string; sessionId: string; taskId: string; inputVersion: string } & (
  { action: 'confirm'; suggestionId: string; directIntent?: never }
  | { action: 'confirm'; directIntent: string; suggestionId?: never }
  | { action: 'answer'; questionId: string; answer: string; operationKey: string }
  | { action: 'stop' }
);
const shortText = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && Boolean(value.trim());
function ids(value: unknown, maxCount?: number): string[] {
  if (!Array.isArray(value) || maxCount !== undefined && (value.length > maxCount || new Set(value).size !== value.length)
    || !value.every(isUuid)) throw new Error('方向依据格式无效。');
  return value.map((id: string) => id.toLowerCase());
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 4 || !value.every(shortText)) throw new Error('探索文字格式无效。');
  return [...value];
}
function readSkill(value: unknown) {
  if (!isRecord(value) || !shortText(value.name) || !isUuid(value.version_id)
    || !Number.isSafeInteger(value.version_number) || (value.version_number as number) < 1) throw new Error('策略版本格式无效。');
  return { name: value.name, versionId: value.version_id.toLowerCase(), versionNumber: value.version_number as number };
}
function readExploration(value: Record<string, unknown>, sessionId: string): DirectionExploration {
  if (value.session_id !== sessionId || !isUuid(value.exploration_id) || !isUuid(value.input_version_id)
    || !shortText(value.understanding) || !Array.isArray(value.evidence) || value.evidence.length > 7
    || !Array.isArray(value.options) || value.options.length > 4
    || !(value.confirmed_intent === null || shortText(value.confirmed_intent))
    || !Array.isArray(value.skill_choices) || value.skill_choices.length > 100) throw new Error('方向建议格式无效。');
  const evidence = value.evidence.map((item) => {
    if (!isRecord(item) || !isUuid(item.evidence_id) || !shortText(item.text)) throw new Error('方向依据格式无效。');
    return { evidenceId: item.evidence_id.toLowerCase(), text: item.text, sourceIds: ids(item.source_ids) };
  });
  const known = new Set(evidence.map((item) => item.evidenceId));
  const citations = (value: unknown) => { const result = ids(value, 20); if (result.some((id) => !known.has(id))) throw new Error('依据已失效。'); return result; };
  const directions = value.options.map((item) => {
    if (!isRecord(item) || !isUuid(item.suggestion_id) || !shortText(item.label) || !shortText(item.intent)
      || !shortText(item.reason) || typeof item.recommended !== 'boolean' || typeof item.pause !== 'boolean') throw new Error('方向建议格式无效。');
    const citationIds = citations(item.citation_ids);
    if (item.recommended && !citationIds.length) throw new Error('推荐没有当前依据。');
    return { suggestionId: item.suggestion_id.toLowerCase(), title: item.label, direction: item.intent,
      reason: item.reason, citationIds, recommended: item.recommended, pause: item.pause };
  });
  if (new Set(directions.map((item) => item.suggestionId)).size !== directions.length) throw new Error('方向建议格式无效。');
  let question: DirectionExploration['question'] = null;
  if (value.question !== null) {
    if (!isRecord(value.question) || !shortText(value.question.text) || !['stance', 'commitment', 'ambiguity'].includes(value.question.impact as string)
      || !isUuid(value.question_id)) throw new Error('关键问题格式无效。');
    question = { questionId: value.question_id.toLowerCase(), text: value.question.text };
  }
  if (value.kind !== (question ? 'clarification' : 'directions') || !question && directions.length < 2
    || typeof value.current_step !== 'string' || value.current_step.length > 1000) throw new Error('探索结果类型无效。');
  return { taskId: value.exploration_id.toLowerCase(), sessionId, inputVersion: value.input_version_id.toLowerCase(),
    understanding: value.understanding, ambiguities: strings(value.ambiguities), evidence, directions,
    citationIds: citations(value.citation_ids), question, confirmedIntent: value.confirmed_intent as string | null,
    currentStep: value.current_step, tradeoffs: strings(value.tradeoffs),
    usedSkill: value.used_skill === null ? null : readSkill(value.used_skill), skillChoices: value.skill_choices.map(readSkill) };
}
function readOutcome(value: unknown, sessionId: string) {
  if (!isRecord(value) || !isUuid(value.exploration_id)) throw new Error('探索结果格式无效。');
  if (value.kind === 'generated') {
    if (!shortText(value.confirmed_intent) || !isRecord(value.turn) || value.turn.session_id !== sessionId
      || value.turn.state !== 'completed' || !isUuid(value.turn.input_version_id)) throw new Error('候选尚未可靠保存。');
    return { kind: 'generated' as const, confirmedIntent: value.confirmed_intent, taskId: value.exploration_id.toLowerCase(),
      reply: { ...readReplyResult(value.turn), assistantSessionId: sessionId, inputVersionId: value.turn.input_version_id.toLowerCase() } };
  }
  if (value.kind === 'paused') {
    if (!isUuid(value.input_version_id)) throw new Error('暂停结果格式无效。');
    return { kind: 'paused' as const };
  }
  return { kind: 'exploration' as const, result: readExploration(value, sessionId) };
}
export async function explorationIdentity(backend: BackendHost, contactId: string, sessionId: string | undefined, signal: AbortSignal) {
  const selected = sessionId ?? (await defaultAssistantSession(backend, contactId, signal)).sessionId;
  const response = await backend.requestJson({ method: 'GET', path: `/api/contacts/${contactId}/assistant-sessions/${selected}`, signal });
  if (!isRecord(response.data) || response.data.session_id !== selected
    || !(response.data.current_input_version_id === null || isUuid(response.data.current_input_version_id))) throw new Error('助手输入版本暂不可用。');
  return { sessionId: selected, currentInputVersionId: response.data.current_input_version_id as string | null, generation: response.generation };
}
export async function openExploration(backend: BackendHost, input: ExplorationRequest, signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'POST',
    path: `/api/contacts/${input.contactId}/assistant-sessions/${input.sessionId}/explorations`, timeoutMs: 23_000, signal,
    body: { operation_key: input.operationKey, expected_input_version_id: input.expectedInputVersionId,
      previous_id: input.previousId, change_group: input.changeGroup, automatic: Boolean(input.automatic), content: {
        type: input.scene === 'reply_to_message' ? 'response_exploration' : 'purpose_exploration',
        ...(input.scene === 'reply_to_message' ? { target_message_id: input.targetMessageId } : { purpose_hint: input.purposeHint }),
        correction: input.correction, requirements: input.requirements,
        skill_mode: input.skill.mode, skill_version_id: input.skill.versionId,
      } } });
  return { ...readOutcome(response.data, input.sessionId), generation: response.generation };
}
function actionBody(input: ExplorationAction) {
  return { input_version_id: input.inputVersion, ...(input.action === 'confirm' ? input.suggestionId
    ? { suggestion_id: input.suggestionId } : { direct_intent: input.directIntent }
    : input.action === 'answer' ? { question_id: input.questionId, answer: input.answer, operation_key: input.operationKey } : {}) };
}
export async function prepareExplorationAction(backend: BackendHost, input: ExplorationAction, signal: AbortSignal) {
  if (input.action === 'stop') throw new Error('停止方向探索不能领取候选生成。');
  const response = await backend.requestJson({ method: 'POST',
    path: `/api/contacts/${input.contactId}/assistant-sessions/${input.sessionId}/explorations/${input.taskId}/prepare-${input.action}`,
    timeoutMs: 25_000, signal, body: actionBody(input) });
  const value = response.data;
  if (isRecord(value) && value.kind === 'prepared') {
    if (Object.keys(value).length !== 3 || !isUuid(value.exploration_id) || !isRecord(value.generation)
      || !isUuid(value.generation.request_key)) throw new Error('本次探索生成准备回执无效。');
    return { kind: 'prepared' as const, taskId: value.exploration_id.toLowerCase(),
      receipt: readAssistantGenerationReceipt(value.generation, input.sessionId, value.generation.request_key),
      generation: response.generation };
  }
  return { ...readOutcome(value, input.sessionId), generation: response.generation };
}
export async function actOnExploration(backend: BackendHost, input: ExplorationAction, signal: AbortSignal,
  receipt?: AssistantGenerationReceipt) {
  const response = await backend.requestJson({ method: 'POST',
    path: `/api/contacts/${input.contactId}/assistant-sessions/${input.sessionId}/explorations/${input.taskId}/${input.action}`, timeoutMs: 25_000, signal,
    body: actionBody(input) });
  if (receipt && (!isRecord(response.data) || response.data.kind !== 'generated' || !isRecord(response.data.turn)
    || response.data.turn.turn_id !== receipt.turnId || response.data.turn.input_version_id !== receipt.inputVersionId
    || response.data.turn.session_id !== receipt.sessionId || response.data.turn.state !== 'completed')) {
    throw new Error('本次确认结果与准备回执不一致。');
  }
  return { ...readOutcome(response.data, input.sessionId), generation: response.generation };
}
export type ExplorationOutcome = Awaited<ReturnType<typeof actOnExploration>>;
