import { noArguments, type PageCommands } from '../page-commands';
import type { ContactDraft, ContactSelection } from '../../shared/contact-session-bridge';
import { contactDraftUpdate } from '../../shared/contact-session-bridge';
import type { BackendHost } from '../backend/host';
import { normalizeUuid } from '../uuid';
import type { ContactDeletionQuiet } from './deletion-quiet';
import { readContactDirectory } from './directory';
import { ContactSession } from './session';
import { readContactAvatar } from './avatar';

export function selectionArguments(args: unknown[], withDraft = false): ContactSelection | ContactDraft {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('联系人操作不可用。');
  const fields = value as Record<string, unknown>;
  const contactId = normalizeUuid(fields.contactId);
  const keys = withDraft ? ['contactId', 'scopeRevision', 'text'] : ['contactId', 'scopeRevision'];
  if(Object.hasOwn(fields,'traceId')){keys.push('traceId');if(normalizeUuid(fields.traceId)===null)throw new Error('联系人操作不可用。');}
  if (Object.keys(fields).length !== keys.length || !Object.keys(fields).every((key) => keys.includes(key))
    || contactId === null
    || typeof fields.scopeRevision !== 'number' || !Number.isSafeInteger(fields.scopeRevision) || fields.scopeRevision < 0
    || (withDraft && (typeof fields.text !== 'string' || fields.text.length > 65_536))) throw new Error('联系人操作不可用。');
  const trace=Object.hasOwn(fields,'traceId')?{traceId:normalizeUuid(fields.traceId)!}:{};
  return withDraft ? { contactId, scopeRevision: fields.scopeRevision, text: fields.text as string,...trace }
    : { contactId, scopeRevision: fields.scopeRevision,...trace };
}

export function installContactSessionBridge(commands: PageCommands, backend: BackendHost,
  quiet?: ContactDeletionQuiet): ContactSession {
  const contacts = new ContactSession(() => readContactDirectory(backend), quiet);
  contacts.onStateChanged((state, kind) => commands.publish('contacts:state-changed', kind === 'draft' ? contactDraftUpdate(state) : state));
  backend.onStateChanged(() => contacts.setConnection(backend.getConnectionGeneration()));
  contacts.setConnection(backend.getConnectionGeneration());
  commands.handle('contacts:get-state', (...args: unknown[]) => {
    noArguments(args);
    return contacts.getState();
  });
  commands.handle('contacts:refresh', (...args: unknown[]) => {
    noArguments(args);
    return contacts.refreshContacts();
  });
  commands.handle('contacts:select', (...args: unknown[]) => {
    return contacts.selectContact(selectionArguments(args));
  });
  commands.handle('contacts:read-avatar', (...args: unknown[]) => {
    return readContactAvatar(backend, contacts, selectionArguments(args));
  }, 'manager');
  commands.handle('contacts:set-draft', (...args: unknown[]) => {
    return contacts.setDraft(selectionArguments(args, true) as ContactDraft);
  });
  return contacts;
}
