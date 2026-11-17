import { isUuid } from '../uuid';
import type { ContactSelection } from '../../shared/contact-session-bridge';
import { noArguments, type PageCommands } from '../page-commands';
import type { AssistantSessionDeletion, AssistantSessionSelection, ReplyGenerationBlock } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { ReplySession } from './session';

function selection(args: unknown[], session = false, deleting = false): ContactSelection | AssistantSessionSelection | AssistantSessionDeletion {
  const value = args[0];
  const keys = ['contactId', 'scopeRevision', ...(session ? ['sessionId'] : []), ...(deleting ? ['confirmed'] : [])];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !Object.keys(value).every(key => keys.includes(key))) {
    throw new Error('助手讨论操作不可用。');
  }
  const record = value as Record<string, unknown>;
  if (!isUuid(record.contactId) || !Number.isSafeInteger(record.scopeRevision) || (record.scopeRevision as number) < 0
    || session && !isUuid(record.sessionId) || deleting && record.confirmed !== true) {
    throw new Error('助手讨论操作不可用。');
  }
  return { ...record, contactId: record.contactId.toLowerCase(),
    ...(session ? { sessionId: (record.sessionId as string).toLowerCase() } : {}) } as AssistantSessionDeletion;
}

export function installReplyBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession,
  generationBlock?: () => ReplyGenerationBlock): ReplySession {
  const replies = new ReplySession(contacts, backend, generationBlock);
  replies.onStateUpdated(event => commands.publish('reply:state-updated', event, 'helper'));
  commands.handle('reply:subscribe', (...args: unknown[]) => {
    noArguments(args); commands.publish('reply:state-updated', { kind: 'snapshot', state: replies.getState() }, 'helper');
  }, 'helper');
  commands.handle('reply:get-state', (...args: unknown[]) => { noArguments(args); return replies.getState(); });
  for (const [channel, action] of [
    ['reply:retry-source-validation', 'retrySourceValidation'],
    ['reply:read-saved-session', 'readSavedSession'],
    ['reply:list-saved-sessions', 'listSavedSessions'],
    ['reply:new-saved-session', 'newSavedSession'],
  ] as const) {
    commands.handle(channel, (...args: unknown[]) => replies[action](selection(args)), 'helper');
  }
  for (const [channel, action] of [
    ['reply:view-saved-session', 'viewSavedSession'],
    ['reply:resume-saved-session', 'resumeSavedSession'],
  ] as const) {
    commands.handle(channel, (...args: unknown[]) => replies[action](selection(args, true) as AssistantSessionSelection), 'helper');
  }
  commands.handle('reply:delete-saved-session', (...args: unknown[]) =>
    replies.deleteSavedSession(selection(args, true, true) as AssistantSessionDeletion), 'helper');
  return replies;
}
