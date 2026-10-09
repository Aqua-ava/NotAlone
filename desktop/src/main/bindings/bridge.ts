import { noArguments, type PageCommands } from '../page-commands';
import type { BackendHost } from '../backend/host';
import { BindingConsentController } from './controller';
import type { BindingConfirmation, BindingRevocation } from '../../shared/binding-consent-bridge';
import type { ContactSession } from '../contacts/session';
import { isBindingIdentifier, isConversationLocator } from './validation';

function confirmation(args: unknown[]): BindingConfirmation {
  const value = args[0] as Record<string, unknown> | undefined;
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.keys(value).every((key) => ['scopeRevision', 'selections'].includes(key))
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
  return { scopeRevision: value.scopeRevision, selections };
}

function revocation(args: unknown[]): BindingRevocation {
  const value = args[0] as Record<string, unknown> | undefined;
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3 || !Object.keys(value).every((key) => ['scopeRevision', 'contactId', 'bindingId'].includes(key))
    || typeof value.scopeRevision !== 'number' || !Number.isSafeInteger(value.scopeRevision) || value.scopeRevision < 0
    || ![value.contactId, value.bindingId].every(isBindingIdentifier)) throw new Error('授权操作不可用。');
  return { scopeRevision: value.scopeRevision, contactId: (value.contactId as string).toLowerCase(), bindingId: (value.bindingId as string).toLowerCase() };
}

export function installBindingConsentBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession): void {
  const bindings = new BindingConsentController(backend, contacts);
  bindings.onStateChanged((state) => commands.publish('bindings:state-changed', state));
  commands.handle('bindings:get-state', (...args: unknown[]) => {
    noArguments(args); return bindings.getState();
  });
  commands.handle('bindings:refresh', (...args: unknown[]) => {
    noArguments(args); return bindings.refresh();
  }, 'manager');
  commands.handle('bindings:confirm-selections', (...args: unknown[]) => {
    return bindings.confirmSelections(confirmation(args));
  }, 'manager');
  commands.handle('bindings:revoke-binding', (...args: unknown[]) => {
    return bindings.revokeBinding(revocation(args));
  }, 'manager');
}
