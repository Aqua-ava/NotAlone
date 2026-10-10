import { isUuid } from '../uuid';
import type { ContactSelection } from '../../shared/contact-session-bridge';
import { noArguments, type PageCommands } from '../page-commands';
import type { GenerateReply, ReplyCandidateEdit, ReplyCandidateSelection, ReplyDirectionUpdate, ReplyGenerationBlock, ReplyMessagePageRequest, ReplyMessageSelection, ReplyModeUpdate, RewriteOptions, RewriteOptionsUpdate } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { ReplySession } from './session';
import { ReplyEvidenceSession } from './evidence-session';

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
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).length !== 3
    || !Object.keys(settings).every((key) => ['tone', 'instruction', 'includeRelationshipContext'].includes(key))
    || !['original', 'warm', 'concise', 'polite'].includes(settings.tone as string)
    || typeof settings.instruction !== 'string' || settings.instruction.length > 4096
    || typeof settings.includeRelationshipContext !== 'boolean') throw new Error('本次改写要求不可用。');
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
  commands.handle('reply:reconnect-messages', (...args: unknown[]) =>
    replies.reconnectMessages(fields(args, ['contactId', 'scopeRevision']) as unknown as ContactSelection), 'helper');
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
  commands.handle('reply:select-candidate', (...args: unknown[]) => { return replies.selectCandidate(candidate(args)); }, 'helper');
  commands.handle('reply:edit-candidate', (...args: unknown[]) => { return replies.editCandidate(candidate(args, true) as ReplyCandidateEdit); }, 'helper');
  return replies;
}
