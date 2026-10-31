import type { ContactHistoryRequest } from '../../shared/contact-history-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { noArguments, type PageCommands } from '../page-commands';
import { isUuid } from '../uuid';
import { ContactHistoryController } from './controller';

function request(args: unknown[]): ContactHistoryRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('聊天记录不可用。');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 3 || Object.keys(fields).some(key => !['contactId', 'scopeRevision', 'older'].includes(key))
    || !isUuid(fields.contactId) || typeof fields.scopeRevision !== 'number' || !Number.isSafeInteger(fields.scopeRevision)
    || fields.scopeRevision < 0 || typeof fields.older !== 'boolean') throw new Error('聊天记录不可用。');
  return { contactId: (fields.contactId as string).toLowerCase(), scopeRevision: fields.scopeRevision, older: fields.older };
}

export function installContactHistoryBridge(commands: PageCommands, backend: BackendHost,
  contacts: ContactSession): ContactHistoryController {
  const controller = new ContactHistoryController(backend, contacts);
  controller.onStateChanged(state => commands.publish('contact-history:state-changed', state, 'manager'));
  commands.handle('contact-history:get-state', (...args: unknown[]) => { noArguments(args); return controller.getState(); }, 'manager');
  commands.handle('contact-history:load', (...args: unknown[]) => controller.load(request(args)), 'manager');
  return controller;
}
