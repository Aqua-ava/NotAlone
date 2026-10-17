import { noArguments, type PageCommands } from '../page-commands';
import type { ContactDraft, ContactSelection } from '../../shared/contact-session-bridge';
import type { BackendHost } from '../backend/host';
import { normalizeUuid } from '../uuid';
import { readContactDirectory } from './directory';
import { ContactSession } from './session';
import { randomUUID } from 'node:crypto';

export function selectionArguments(args: unknown[], withDraft = false): ContactSelection | ContactDraft {
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
  let creating = false;
  let creation: { name: string; id: string } | undefined;
  commands.handle('contacts:create', async (...args: unknown[]) => {
    const value = args[0] as Record<string, unknown> | undefined;
    const state = contacts.getState(), generation = backend.getConnectionGeneration();
    if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'displayName,scopeRevision' || typeof value.displayName !== 'string'
      || !value.displayName.trim() || value.displayName.trim().length > 100 || value.scopeRevision !== state.scopeRevision
      || state.directoryPhase !== 'ready' || generation === undefined || creating) throw new Error('联系人创建不可用。');
    const name = value.displayName.trim();
    if (creation?.name !== name) creation = { name, id: randomUUID() };
    creating = true;
    try {
      const response = await backend.requestJson({ method: 'POST', path: '/api/contacts',
        body: { request_id: creation.id, display_name: name }, maxResponseBytes: 4096 });
      if (response.generation !== generation || backend.getConnectionGeneration() !== generation) throw new Error('联系人创建状态已失效。');
      await contacts.refreshContacts();
      creation = undefined;
      return contacts.getState();
    } finally { creating = false; }
  }, 'manager');
  commands.handle('contacts:set-draft', (...args: unknown[]) => {
    return contacts.setDraft(selectionArguments(args, true) as ContactDraft);
  });
  return contacts;
}
