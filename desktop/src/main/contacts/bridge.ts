import { ipcMain } from 'electron';
import type { ContactDraft, ContactSelection } from '../../shared/contact-session-bridge';
import type { BackendHost } from '../backend/host';
import type { AppWindows } from '../windows';
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

export function installContactSessionBridge(windows: AppWindows, backend: BackendHost): ContactSession {
  const contacts = new ContactSession(() => readContactDirectory(backend));
  contacts.onStateChanged((state) => windows.publish('contacts:state-changed', state));
  backend.onStateChanged(() => contacts.setConnection(backend.getConnectionGeneration()));
  contacts.setConnection(backend.getConnectionGeneration());
  ipcMain.handle('contacts:get-state', (event, ...args: unknown[]) => {
    windows.validateCaller(event, args);
    return contacts.getState();
  });
  ipcMain.handle('contacts:refresh', (event, ...args: unknown[]) => {
    windows.validateCaller(event, args);
    return contacts.refreshContacts();
  });
  ipcMain.handle('contacts:select', (event, ...args: unknown[]) => {
    windows.validateCaller(event, []);
    return contacts.selectContact(selectionArguments(args));
  });
  ipcMain.handle('contacts:set-draft', (event, ...args: unknown[]) => {
    windows.validateCaller(event, []);
    return contacts.setDraft(selectionArguments(args, true) as ContactDraft);
  });
  return contacts;
}
