import { ipcMain } from 'electron';
import type { BackendHost } from '../backend/host';
import type { AppWindows } from '../windows';
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

export function installBindingConsentBridge(windows: AppWindows, backend: BackendHost, contacts: ContactSession): void {
  const bindings = new BindingConsentController(backend, contacts);
  bindings.onStateChanged((state) => windows.publish('bindings:state-changed', state));
  ipcMain.handle('bindings:get-state', (event, ...args: unknown[]) => {
    windows.validateCaller(event, args); return bindings.getState();
  });
  ipcMain.handle('bindings:refresh', (event, ...args: unknown[]) => {
    const window = windows.validateCaller(event, args);
    if (!window.webContents.getURL().endsWith('#manager')) throw new Error('授权操作不可用。');
    return bindings.refresh();
  });
  ipcMain.handle('bindings:confirm-selections', (event, ...args: unknown[]) => {
    const window = windows.validateCaller(event, []);
    if (!window.webContents.getURL().endsWith('#manager')) throw new Error('授权操作不可用。');
    return bindings.confirmSelections(confirmation(args));
  });
  ipcMain.handle('bindings:revoke-binding', (event, ...args: unknown[]) => {
    const window = windows.validateCaller(event, []);
    if (!window.webContents.getURL().endsWith('#manager')) throw new Error('授权操作不可用。');
    return bindings.revokeBinding(revocation(args));
  });
}
