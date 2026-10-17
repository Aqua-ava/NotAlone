import type { SavedAssistantTurn } from '../../shared/assistant-session';
import type { ReplyInputSnapshot, ReplySkillChoice } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';
import { isUuid } from '../uuid';
import { readReplyMessages } from './messages';
import { sceneSnapshot } from './scene';
import { pastedInputFields } from './pasted-input';

const text = (value: unknown, limit = 4096): value is string => typeof value === 'string' && Boolean(value.trim()) && Array.from(value).length <= limit;
const optional = (value: unknown): value is string | null | undefined => value == null || typeof value === 'string' && Array.from(value).length <= 4096;

// 只在用户明确重试后读取权威输入；不回填或覆盖当前草稿、临时选项及候选编辑。
export async function interruptedReplyInput(backend: BackendHost, turn: SavedAssistantTurn,
  contact: { contactId: string; displayName: string }, signal: AbortSignal, current: () => boolean): Promise<ReplyInputSnapshot> {
  const content = turn.input?.content;
  const common = { contactId: contact.contactId, contactDisplayName: contact.displayName, ...sceneSnapshot(turn.input?.scene) };
  if (!content) throw new Error('中断生成输入暂不可重试。');
  if (content.type === 'rewrite_draft' && text(content.draft_text, Infinity)
    && (content.user_instruction == null || typeof content.user_instruction === 'string')
    && typeof content.include_relationship_context === 'boolean') {
    return { ...common, mode: 'rewrite_draft', draftText: content.draft_text,
      userInstruction: content.user_instruction ?? null, includeRelationshipContext: content.include_relationship_context,
      ...pastedInputFields(content) };
  }
  if (!['understanding_correction', 'clarification_answer'].every((field) => optional(content[field]))
    || !(content.user_instruction == null || typeof content.user_instruction === 'string')) {
    throw new Error('中断生成输入暂不可重试。');
  }
  let skillChoice: ReplySkillChoice;
  if (turn.input?.skill_disabled === true && turn.input.skill_version_id === null) skillChoice = { mode: 'disabled', versionId: null };
  else if (turn.input?.skill_disabled === false && turn.input.skill_version_id === null) skillChoice = { mode: 'auto', versionId: null };
  else if (turn.input?.skill_disabled === false && isUuid(turn.input.skill_version_id)) {
    skillChoice = { mode: 'user', versionId: turn.input.skill_version_id.toLowerCase() };
  } else throw new Error('中断生成输入暂不可重试。');
  const scenario = { ...common, correction: content.understanding_correction as string | undefined ?? '',
    userInstruction: content.user_instruction as string | undefined ?? '',
    clarificationAnswer: content.clarification_answer as string | undefined ?? '', skillChoice };
  if (content.type === 'initiate_conversation' && ['direct_input', 'confirmed_suggestion'].includes(content.purpose_source as string) && text(content.purpose)) {
    return { ...scenario, mode: 'initiate_conversation', purpose: content.purpose };
  }
  if (content.type === 'reply_to_message' && ['direct_input', 'confirmed_suggestion'].includes(content.direction_source as string)
    && text(content.direction, Infinity) && isUuid(content.target_message_id)) {
    const seen = new Set<string>(); let cursor: string | null = null;
    do {
      if (!current()) throw new Error('中断生成归属已变化。');
      const page = await readReplyMessages(backend, contact.contactId, cursor, signal);
      if (!current() || page.generation !== backend.getConnectionGeneration()) throw new Error('中断生成归属已变化。');
      const target = page.messages.find((item) => item.messageId === content.target_message_id);
      if (target) return { ...scenario, mode: 'reply_to_message', direction: content.direction, target };
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('消息分页暂不可确认。');
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  throw new Error('中断生成输入或来源暂不可重试。');
}
