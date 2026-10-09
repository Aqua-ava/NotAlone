import { noArguments, type PageCommands } from '../page-commands';
import type { GenerateRewrite, ReplyCandidateEdit, ReplyCandidateSelection, RewriteOptions, RewriteOptionsUpdate } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { ReplySession } from './session';

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
function fields(args: unknown[], keys: string[]): Record<string, unknown> {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !Object.keys(value).every((key) => keys.includes(key))) {
    throw new Error('本次表达操作不可用。');
  }
  const record = value as Record<string, unknown>;
  if (!uuid(record.contactId) || typeof record.scopeRevision !== 'number'
    || !Number.isSafeInteger(record.scopeRevision) || record.scopeRevision < 0) throw new Error('本次表达操作不可用。');
  return { ...record, contactId: record.contactId.toLowerCase() };
}
function candidate(args: unknown[], editing = false): ReplyCandidateSelection | ReplyCandidateEdit {
  const value = fields(args, ['contactId', 'scopeRevision', 'replyRequestId', 'candidateId', ...(editing ? ['text'] : [])]);
  if (!uuid(value.replyRequestId) || !uuid(value.candidateId)
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

export function installReplyBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession): ReplySession {
  const replies = new ReplySession(contacts, backend);
  replies.onStateChanged((state) => commands.publish('reply:state-changed', state));
  commands.handle('reply:get-state', (...args: unknown[]) => { noArguments(args); return replies.getState(); });
  commands.handle('reply:update-options', (...args: unknown[]) => { return replies.updateOptions(options(args)); }, 'helper');
  commands.handle('reply:generate', (...args: unknown[]) => {
    const value = fields(args, ['contactId', 'scopeRevision', 'newRequest']);
    if (typeof value.newRequest !== 'boolean') throw new Error('本次生成操作不可用。');
    return replies.generate(value as unknown as GenerateRewrite);
  }, 'helper');
  commands.handle('reply:select-candidate', (...args: unknown[]) => { return replies.selectCandidate(candidate(args)); }, 'helper');
  commands.handle('reply:edit-candidate', (...args: unknown[]) => { return replies.editCandidate(candidate(args, true) as ReplyCandidateEdit); }, 'helper');
  return replies;
}
