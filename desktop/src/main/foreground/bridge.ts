import { noArguments, type PageCommands } from '../page-commands';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { normalizeUuid } from '../uuid';
import type { ForegroundConfirmation } from '../../shared/foreground-bridge';
import { ForegroundController } from './controller';

function confirmationArguments(args: unknown[]): ForegroundConfirmation {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('前台联系人确认不可用。');
  const fields = value as Record<string, unknown>;
  const contactId = normalizeUuid(fields.contactId);
  const keys = ['contactId', 'contactScopeRevision', 'foregroundRevision'];
  if (Object.keys(fields).length !== keys.length || !Object.keys(fields).every((key) => keys.includes(key))
    || contactId === null || typeof fields.contactScopeRevision !== 'number'
    || !Number.isSafeInteger(fields.contactScopeRevision) || fields.contactScopeRevision < 0
    || typeof fields.foregroundRevision !== 'number' || !Number.isSafeInteger(fields.foregroundRevision)
    || fields.foregroundRevision < 0) throw new Error('前台联系人确认不可用。');
  return { contactId, contactScopeRevision: fields.contactScopeRevision, foregroundRevision: fields.foregroundRevision };
}

export function installForegroundBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession): ForegroundController {
  const controller = new ForegroundController(backend, contacts);
  controller.onStateChanged((state) => commands.publish('foreground:state-changed', state));
  commands.handle('foreground:get-state', (...args: unknown[]) => {
    noArguments(args); return controller.getState();
  }, 'helper');
  commands.handle('foreground:confirm', (...args: unknown[]) => controller.confirm(confirmationArguments(args)), 'helper');
  return controller;
}
