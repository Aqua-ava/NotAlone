import { isUuid } from '../uuid';
import type { ContactSelection } from '../../shared/contact-session-bridge';
import { noArguments, type PageCommands } from '../page-commands';
import type { AssistantSessionDeletion, GenerateReply, ReplyCandidateEdit, ReplyCandidateSelection, ReplyCorrectionUpdate, ReplyDirectionChoice, ReplyDirectionUpdate, ReplyGenerationBlock, ReplyMessagePageRequest, ReplyMessageSelection, ReplyModeUpdate, RewriteOptions, RewriteOptionsUpdate } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { ReplySession } from './session';
import { ReplyEvidenceSession } from './evidence-session';
import type { AssistantInterruptedRetry, AssistantSessionSelection } from '../../shared/reply-bridge';
import type { ReplyCandidateDraftUpdate, ReplyCandidateVersionDisplay, ReplyCandidateVersionEdit, ReplyCandidateVersionRead, ReplyCandidateVersionSelection } from '../../shared/assistant-candidate-versions';
import type { ReplyContinuation, ReplyContinuationConfirmation } from '../../shared/reply-bridge';
import { ASSISTANT_CONTINUATION_RESPONSE_LIMIT } from '../../shared/assistant-continuation-clarification';
const continuationText = (item: unknown) => typeof item === 'string' && Boolean(item.trim()) && Array.from(item).length <= 4096;

function continuation(args: unknown[]): ReplyContinuation {
  const raw = args[0];
  const optional = ['intentionUpdate', 'requirementChanges'];
  const keys = raw && typeof raw === 'object' ? optional.filter((key) => Object.hasOwn(raw, key)) : [];
  const value = fields(args, ['contactId', 'scopeRevision', 'sessionId', 'instruction', ...keys]);
  if (!isUuid(value.sessionId) || !continuationText(value.instruction)
    || keys.includes('intentionUpdate') && !continuationText(value.intentionUpdate)
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > ASSISTANT_CONTINUATION_RESPONSE_LIMIT) {
    throw new Error('请明确本次继续的要求与助手会话。');
  }
  if (keys.includes('requirementChanges')) requirementChanges(value.requirementChanges);
  return { ...value, sessionId: value.sessionId.toLowerCase() } as unknown as ReplyContinuation;
}
function requirementChanges(value: unknown): void {
    if (!Array.isArray(value)
      || new TextEncoder().encode(JSON.stringify(value)).byteLength > ASSISTANT_CONTINUATION_RESPONSE_LIMIT) {
      throw new Error('本次要求变更无效。');
    }
    for (const change of value) {
      if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('本次要求变更无效。');
      const expected = change.action === 'keep' || change.action === 'remove' ? ['action', 'previous']
        : change.action === 'replace' ? ['action', 'previous', 'replacement'] : change.action === 'add' ? ['action', 'replacement'] : [];
      if (!expected.length || Object.keys(change).length !== expected.length || !expected.every((key) => Object.hasOwn(change, key))
        || expected.filter((key) => key !== 'action').some((key) => !continuationText(change[key]))) throw new Error('本次要求变更无效。');
    }
}

function candidateVersion(args: unknown[], operation: 'read' | 'display' | 'select' | 'edit' | 'draft'): ReplyCandidateVersionRead {
  const additions = operation === 'draft' ? ['versionId', 'messages', 'requirements'] : operation === 'read' ? [] : operation === 'edit'
    ? ['editKey', 'parentVersionId', 'messages', 'requirements']
    : ['versionId', ...(operation === 'select' ? ['selectionKey'] : [])];
  const value = fields(args, ['contactId', 'scopeRevision', 'sessionId', 'candidateId', ...additions]);
  const identifiers = ['sessionId', 'candidateId', ...(operation === 'edit' ? ['editKey', 'parentVersionId']
    : operation === 'read' ? [] : ['versionId', ...(operation === 'select' ? ['selectionKey'] : [])])];
  if (!identifiers.every((key) => isUuid(value[key]))) throw new Error('候选版本操作不可用。');
  for (const key of identifiers) value[key] = (value[key] as string).toLowerCase();
  if (operation === 'edit' || operation === 'draft') {
    const messages = value.messages;
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 8
      || operation === 'draft' && typeof value.requirements !== 'string'
      || (value.requirements !== null && (typeof value.requirements !== 'string'
        || operation === 'edit' && !value.requirements.trim() || value.requirements.length > 4096))) throw new Error('候选版本操作不可用。');
    const known = new Set<string>();
    value.messages = messages.map((message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)
        || Object.keys(message).length !== 2 || !Object.keys(message).every((key) => ['messageId', 'text'].includes(key))) {
        throw new Error('候选版本操作不可用。');
      }
      const item = message as Record<string, unknown>;
      if (!isUuid(item.messageId) || typeof item.text !== 'string' || operation === 'edit' && !item.text.trim()
        || item.text.length > (messages.length === 1 ? 65_536 : 8192)
        || known.has(item.messageId.toLowerCase())) throw new Error('候选版本操作不可用。');
      const messageId = item.messageId.toLowerCase(); known.add(messageId);
      return { messageId, text: item.text };
    });
  }
  return value as unknown as ReplyCandidateVersionRead;
}

function fields(args: unknown[], keys: string[]): Record<string, unknown> {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !Object.keys(value).every((key) => keys.includes(key))) {
    throw new Error('本次表达操作不可用。');
  }
  const record = value as Record<string, unknown>;
  if (!isUuid(record.contactId) || typeof record.scopeRevision !== 'number'
    || !Number.isSafeInteger(record.scopeRevision) || record.scopeRevision < 0) throw new Error('本次表达操作不可用。');
  return { ...record, contactId: record.contactId.toLowerCase() };
}
function candidate(args: unknown[], editing = false): ReplyCandidateSelection | ReplyCandidateEdit {
  const value = fields(args, ['contactId', 'scopeRevision', 'replyRequestId', 'candidateId', ...(editing ? ['text'] : [])]);
  if (!isUuid(value.replyRequestId) || !isUuid(value.candidateId)
    || (editing && (typeof value.text !== 'string' || value.text.length > 65_536))) throw new Error('本次候选操作不可用。');
  return { ...value, replyRequestId: value.replyRequestId.toLowerCase(), candidateId: value.candidateId.toLowerCase() } as unknown as ReplyCandidateEdit;
}
function options(args: unknown[]): RewriteOptionsUpdate {
  const value = fields(args, ['contactId', 'scopeRevision', 'options']);
  const settings = value.options as Record<string, unknown> | undefined;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).length < 3
    || !Object.keys(settings).every((key) => ['tone', 'instruction', 'includeRelationshipContext', 'inputKind', 'pastedDirection'].includes(key))
    || !['original', 'warm', 'concise', 'polite'].includes(settings.tone as string)
    || typeof settings.instruction !== 'string' || settings.instruction.length > 4096
    || typeof settings.includeRelationshipContext !== 'boolean'
    || settings.inputKind !== undefined && !['draft', 'current_chat'].includes(settings.inputKind as string)
    || settings.pastedDirection !== undefined && (typeof settings.pastedDirection !== 'string' || settings.pastedDirection.length > 4096)) throw new Error('本次改写要求不可用。');
  return { contactId: value.contactId as string, scopeRevision: value.scopeRevision as number, options: { ...settings } as unknown as RewriteOptions };
}

export function installReplyBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession,
  generationBlock?: () => ReplyGenerationBlock): ReplySession {
  const replies = new ReplySession(contacts, backend, generationBlock);
  const evidence = new ReplyEvidenceSession(backend, replies);
  evidence.onStateChanged((state) => commands.publish('reply:evidence-changed', state));
  commands.handle('reply:get-evidence-state', (...args: unknown[]) => { noArguments(args); return evidence.getState(); }, 'helper');
  commands.handle('reply:load-evidence', (...args: unknown[]) => evidence.load(candidate(args)), 'helper');
  commands.handle('reply:close-evidence', (...args: unknown[]) => evidence.close(candidate(args)), 'helper');
  replies.onStateChanged((state) => commands.publish('reply:state-changed', state));
  commands.handle('reply:get-state', (...args: unknown[]) => { noArguments(args); return replies.getState(); });
  commands.handle('reply:update-options', (...args: unknown[]) => { return replies.updateOptions(options(args)); }, 'helper');
  commands.handle('reply:set-mode', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'mode']);
    if (!['rewrite_draft', 'reply_to_message', 'initiate_conversation'].includes(value.mode as string)) throw new Error('本次输入方式不可用。');
    return replies.setMode(value as unknown as ReplyModeUpdate);
  }, 'helper');
  commands.handle('reply:load-messages', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'older']);
    if (typeof value.older !== 'boolean') throw new Error('消息列表操作不可用。');
    return replies.loadMessages(value as unknown as ReplyMessagePageRequest);
  }, 'helper');
  commands.handle('reply:retry-source-validation', (...args: unknown[]) =>
    replies.retrySourceValidation(fields(args, ['contactId', 'scopeRevision']) as unknown as ContactSelection), 'helper');
  commands.handle('reply:read-saved-session', (...args: unknown[]) =>
    replies.readSavedSession(fields(args, ['contactId', 'scopeRevision']) as unknown as ContactSelection), 'helper');
  commands.handle('reply:list-saved-sessions', (...args: unknown[]) =>
    replies.listSavedSessions(fields(args, ['contactId', 'scopeRevision']) as unknown as ContactSelection), 'helper');
  commands.handle('reply:new-saved-session', (...args: unknown[]) =>
    replies.newSavedSession(fields(args, ['contactId', 'scopeRevision']) as unknown as ContactSelection), 'helper');
  commands.handle('reply:new-with-candidate', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'sessionId', 'expectedSelectionId', 'candidateId', 'versionId']);
    for (const key of ['sessionId', 'expectedSelectionId', 'candidateId', 'versionId']) {
      if (!isUuid(value[key])) throw new Error('请先明确选用要携入的保存版本。');
      value[key] = (value[key] as string).toLowerCase();
    }
    return replies.newSavedSessionWithCandidate(value as unknown as import('../../shared/reply-bridge').AssistantCandidateCarry);
  }, 'helper');
  commands.handle('reply:select-saved-session', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'sessionId']);
    if (!isUuid(value.sessionId)) throw new Error('助手会话不可用。');
    return replies.selectSavedSession({ ...value, sessionId: value.sessionId.toLowerCase() } as unknown as AssistantSessionSelection);
  }, 'helper');
  commands.handle('reply:delete-saved-session', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'sessionId', 'confirmed']);
    if (!isUuid(value.sessionId) || value.confirmed !== true) throw new Error('助手会话删除尚未确认。');
    return replies.deleteSavedSession({ ...value, sessionId: value.sessionId.toLowerCase() } as unknown as AssistantSessionDeletion);
  }, 'helper');
  commands.handle('reply:reconnect-messages', (...args: unknown[]) =>
    replies.reconnectMessages(fields(args, ['contactId', 'scopeRevision']) as unknown as ContactSelection), 'helper');
  commands.handle('reply:combine-new-messages', (...args: unknown[]) =>
    replies.combineNewMessages(fields(args, ['contactId', 'scopeRevision']) as unknown as ContactSelection), 'helper');
  commands.handle('reply:select-message', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'messageId']);
    if (!isUuid(value.messageId)) throw new Error('待回复消息不可用。');
    return replies.selectMessage({ ...value, messageId: value.messageId.toLowerCase() } as unknown as ReplyMessageSelection);
  }, 'helper');
  commands.handle('reply:update-direction', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'direction']);
    if (typeof value.direction !== 'string' || value.direction.length > 4096) throw new Error('表达方向不可用。');
    return replies.updateDirection(value as unknown as ReplyDirectionUpdate);
  }, 'helper');
  commands.handle('reply:update-purpose', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'purpose']);
    if (typeof value.purpose !== 'string' || value.purpose.length > 4096) throw new Error('主动目的不可用。');
    return replies.updatePurpose(value as unknown as import('../../shared/reply-bridge').ReplyPurposeUpdate);
  }, 'helper');
  commands.handle('reply:generate', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'newRequest']);
    if (typeof value.newRequest !== 'boolean') throw new Error('本次生成操作不可用。');
    return replies.generate(value as unknown as GenerateReply);
  }, 'helper');
  commands.handle('reply:continue-session', (...args: unknown[]) => replies.continueSession(continuation(args)), 'helper');
  commands.handle('reply:confirm-continuation', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'sessionId', 'expectedInputVersionId', 'requirementChanges']);
    if (!isUuid(value.sessionId) || !isUuid(value.expectedInputVersionId)) throw new Error('本次澄清已经失效，请重新提交要求。');
    requirementChanges(value.requirementChanges);
    return replies.confirmContinuation({ ...value, sessionId: value.sessionId.toLowerCase(),
      expectedInputVersionId: value.expectedInputVersionId.toLowerCase() } as unknown as ReplyContinuationConfirmation);
  }, 'helper');
  commands.handle('reply:retry-continuation', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'sessionId']);
    if (!isUuid(value.sessionId)) throw new Error('本次连续修改已失效。');
    return replies.retryContinuation({ ...value, sessionId: value.sessionId.toLowerCase() } as unknown as AssistantSessionSelection);
  }, 'helper');
  commands.handle('reply:retry-interrupted-generation', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'sessionId', 'turnId', 'inputVersionId']);
    for (const key of ['sessionId', 'turnId', 'inputVersionId']) {
      if (!isUuid(value[key])) throw new Error('中断生成暂不可重试。');
      value[key] = (value[key] as string).toLowerCase();
    }
    return replies.retryInterruptedGeneration(value as unknown as AssistantInterruptedRetry);
  }, 'helper');
  commands.handle('reply:update-supplement', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'supplement']);
    if (typeof value.supplement !== 'string' || value.supplement.length > 8193) throw new Error('补充内容最多4096个字符。');
    return replies.updateSupplement(value as unknown as import('../../shared/reply-bridge').ReplySupplementUpdate);
  }, 'helper');
  commands.handle('reply:update-correction', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'correction']);
    if (typeof value.correction !== 'string' || value.correction.length > 4096) throw new Error('纠正内容不可用。');
    return replies.updateCorrection(value as unknown as ReplyCorrectionUpdate);
  }, 'helper');
  commands.handle('reply:explore', (...args: unknown[]) =>
    replies.explore(fields(args, ['contactId', 'scopeRevision']) as unknown as ContactSelection), 'helper');
  commands.handle('reply:change-directions', (...args: unknown[]) =>
    replies.explore(fields(args, ['contactId', 'scopeRevision']) as unknown as ContactSelection, true), 'helper');
  commands.handle('reply:begin-clarification-edit', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'inputVersion', 'questionId']);
    if (!isUuid(value.inputVersion) || !isUuid(value.questionId)) throw new Error('关键问题已经失效，请更新理解。');
    return replies.beginClarificationEdit(value as unknown as import('../../shared/reply-bridge').ReplyClarificationEdit);
  }, 'helper');
  commands.handle('reply:answer-clarification', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'answer', 'inputVersion', 'questionId']);
    if (!isUuid(value.inputVersion) || !isUuid(value.questionId) || typeof value.answer !== 'string'
      || !value.answer.trim() || value.answer.length > 4096) throw new Error('关键问题回答不可用。');
    return replies.answerClarification(value as unknown as import('../../shared/reply-bridge').ReplyClarificationAnswer);
  }, 'helper');
  commands.handle('reply:stop-exploration', (...args: unknown[]) =>
    replies.stopExploration(fields(args, ['contactId', 'scopeRevision']) as unknown as ContactSelection), 'helper');
  commands.handle('reply:retry-exploration', (...args: unknown[]) =>
    replies.retryExploration(fields(args, ['contactId', 'scopeRevision']) as unknown as ContactSelection), 'helper');
  commands.handle('reply:update-requirements', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'requirements']);
    if (typeof value.requirements !== 'string' || value.requirements.length > 4096) throw new Error('本次要求不可用。');
    return replies.updateRequirements(value as unknown as import('../../shared/reply-bridge').ReplyRequirementsUpdate);
  }, 'helper');
  commands.handle('reply:update-skill', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'skill']), skill = value.skill;
    if (!skill || typeof skill !== 'object' || Array.isArray(skill) || Object.keys(skill).length !== 2
      || !Object.keys(skill).every((key) => ['mode', 'versionId'].includes(key))) throw new Error('策略选择不可用。');
    const choice = skill as Record<string, unknown>;
    if (choice.mode === 'user' ? !isUuid(choice.versionId) : !['auto', 'disabled'].includes(choice.mode as string) || choice.versionId !== null) throw new Error('策略版本不可用。');
    return replies.updateSkill(value as unknown as import('../../shared/reply-bridge').ReplySkillUpdate);
  }, 'helper');
  commands.handle('reply:update-scene', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'scene']);
    if (typeof value.scene !== 'string' || value.scene.length > 256) throw new Error('精确场景不可用。');
    return replies.updateScene(value as unknown as import('../../shared/reply-bridge').ReplySceneUpdate);
  }, 'helper');
  commands.handle('reply:select-direction', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'suggestionId', 'inputVersion']);
    if (!isUuid(value.suggestionId) || !isUuid(value.inputVersion)) throw new Error('方向建议不可用。');
    return replies.selectDirection(value as unknown as ReplyDirectionChoice);
  }, 'helper');
  commands.handle('reply:select-candidate', (...args: unknown[]) => { return replies.selectCandidate(candidate(args)); }, 'helper');
  commands.handle('reply:edit-candidate', (...args: unknown[]) => { return replies.editCandidate(candidate(args, true) as ReplyCandidateEdit); }, 'helper');
  commands.handle('reply:update-candidate-version-draft', (...args: unknown[]) =>
    replies.updateCandidateVersionDraft(candidateVersion(args, 'draft') as ReplyCandidateDraftUpdate), 'helper');
  commands.handle('reply:read-candidate-versions', (...args: unknown[]) =>
    replies.readCandidateVersions(candidateVersion(args, 'read')), 'helper');
  commands.handle('reply:save-candidate-version', (...args: unknown[]) =>
    replies.saveCandidateVersion(candidateVersion(args, 'edit') as ReplyCandidateVersionEdit), 'helper');
  commands.handle('reply:select-candidate-version', (...args: unknown[]) =>
    replies.selectCandidateVersion(candidateVersion(args, 'select') as ReplyCandidateVersionSelection), 'helper');
  commands.handle('reply:show-candidate-version', (...args: unknown[]) =>
    replies.showCandidateVersion(candidateVersion(args, 'display') as ReplyCandidateVersionDisplay), 'helper');
  return replies;
}
