import { noArguments, type PageCommands } from '../page-commands';
import type { ContactDraft, ContactSelection } from '../../shared/contact-session-bridge';
import type { BackendHost } from '../backend/host';
import { normalizeUuid } from '../uuid';
import { readContactDirectory } from './directory';
import { ContactSession } from './session';

function selectionArguments(args: unknown[], withDraft = false): ContactSelection | ContactDraft {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('联系人操作不可用。');
  const fields = value as Record<string, unknown>;
  const contactId = normalizeUuid(fields.contactId);
  const keys = withDraft ? ['contactId', 'scopeRevision', 'text'] : ['contactId', 'scopeRevision'];
  if (Object.keys(fields).length !== keys.length || !Object.keys(fields).every((key) => keys.includes(key))
    || contactId === null
    || typeof fields.scopeRevision !== 'number' || !Number.isSafeInteger(fields.scopeRevision) || fields.scopeRevision < 0
    || (withDraft && (typeof fields.text !== 'string' || fields.text.length > 65_536))) throw new Error('联系人操作不可用。');
  return withDraft ? { contactId, scopeRevision: fields.scopeRevision, text: fields.text as string }
    : { contactId, scopeRevision: fields.scopeRevision };
}

export function installContactSessionBridge(commands: PageCommands, backend: BackendHost): ContactSession {
  const contacts = new ContactSession(() => readContactDirectory(backend));
  contacts.onStateChanged((state) => commands.publish('contacts:state-changed', state));
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
  commands.handle('contacts:set-draft', (...args: unknown[]) => {
    return contacts.setDraft(selectionArguments(args, true) as ContactDraft);
  });
  return contacts;
}
