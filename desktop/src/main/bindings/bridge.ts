import { noArguments, type PageCommands } from '../page-commands';
import type { BackendHost } from '../backend/host';
import { BindingConsentController } from './controller';
import { validBindingHistoryChoice, type BindingConfirmation, type BindingRevocation } from '../../shared/binding-consent-bridge';
import type { ContactDeletionQuiet } from '../contacts/deletion-quiet';
import type { ContactSession } from '../contacts/session';
import { isBindingIdentifier, isConversationLocator } from './validation';

function confirmation(args: unknown[]): BindingConfirmation {
  const value = args[0] as Record<string, unknown> | undefined;
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
    || !validBindingHistoryChoice(value) || !Object.keys(value).every((key) => ['scopeRevision', 'selections', 'historyAuthorized', 'startSync'].includes(key))
    || !Number.isSafeInteger(value.scopeRevision) || typeof value.scopeRevision !== 'number' || value.scopeRevision < 0
    || !Array.isArray(value.selections) || !value.selections.length || value.selections.length > 5000) throw new Error('授权操作不可用。');
  const selections = value.selections.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('授权操作不可用。');
    const choice = item as Record<string, unknown>;
    if (Object.keys(choice).length !== 3 || !Object.keys(choice).every((key) => ['locator', 'displayName', 'contactId'].includes(key))
      || !isConversationLocator(choice.locator)
      || typeof choice.displayName !== 'string' || !choice.displayName.trim() || choice.displayName.length > 4096
      || (choice.contactId !== null && !isBindingIdentifier(choice.contactId))) throw new Error('授权操作不可用。');
    return { locator: choice.locator, displayName: choice.displayName, contactId: choice.contactId === null ? null : (choice.contactId as string).toLowerCase() };
  });
  if (new Set(selections.map((item) => item.locator)).size !== selections.length) throw new Error('授权操作不可用。');
  return { scopeRevision: value.scopeRevision, selections,
    ...(Object.hasOwn(value, 'historyAuthorized') ? { historyAuthorized: value.historyAuthorized as boolean } : {}),
    ...(Object.hasOwn(value, 'startSync') ? { startSync: value.startSync as boolean } : {}) };
}

function revocation(args: unknown[]): BindingRevocation {
  const value = args[0] as Record<string, unknown> | undefined;
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3 || !Object.keys(value).every((key) => ['scopeRevision', 'contactId', 'bindingId'].includes(key))
    || typeof value.scopeRevision !== 'number' || !Number.isSafeInteger(value.scopeRevision) || value.scopeRevision < 0
    || ![value.contactId, value.bindingId].every(isBindingIdentifier)) throw new Error('授权操作不可用。');
  return { scopeRevision: value.scopeRevision, contactId: (value.contactId as string).toLowerCase(), bindingId: (value.bindingId as string).toLowerCase() };
}

export function installBindingConsentBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession,
  beginReadingScopeChange?: () => (() => void), quiet?: ContactDeletionQuiet): BindingConsentController {
  const bindings = new BindingConsentController(backend, contacts, beginReadingScopeChange, quiet);
  bindings.onStateChanged((state) => commands.publish('bindings:state-changed', state));
  commands.handle('bindings:get-state', (...args: unknown[]) => {
    noArguments(args); return bindings.getState();
  });
  commands.handle('bindings:refresh', (...args: unknown[]) => {
    noArguments(args); return bindings.refresh();
  }, 'manager');
  commands.handle('bindings:refresh-saved', (...args: unknown[]) => {
    noArguments(args); return bindings.refreshSaved();
  }, 'manager');
  commands.handle('bindings:confirm-selections', (...args: unknown[]) => {
    return bindings.confirmSelections(confirmation(args));
  }, 'manager');
  commands.handle('bindings:revoke-binding', (...args: unknown[]) => {
    return bindings.revokeBinding(revocation(args));
  }, 'manager');
  return bindings;
}
