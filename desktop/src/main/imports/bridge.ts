import { noArguments, type PageCommands } from '../page-commands';
import type { ImportTarget } from '../../shared/import-bridge';
import { normalizeUuid } from '../uuid';
import type { ImportController } from './controller';

function selectionRevision(args: unknown[]): number {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1 || !('selectionRevision' in value)
    || typeof value.selectionRevision !== 'number' || !Number.isSafeInteger(value.selectionRevision) || value.selectionRevision < 0) throw new Error('历史导入操作不可用。');
  return value.selectionRevision;
}

function target(args: unknown[]): ImportTarget {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2) throw new Error('历史导入操作不可用。');
  if ('kind' in value && value.kind === 'existing' && 'contactId' in value) {
    const contactId = normalizeUuid(value.contactId);
    if (contactId !== null) return { kind: 'existing', contactId };
  }
  if ('kind' in value && value.kind === 'new' && 'displayName' in value && typeof value.displayName === 'string'
    && value.displayName.length <= 100 && !/[\u0000-\u001f]/.test(value.displayName)) return { kind: 'new', displayName: value.displayName };
  throw new Error('历史导入操作不可用。');
}

export function installImportBridge(commands: PageCommands, imports: ImportController): void {
  imports.onStateChanged((state) => commands.publish('imports:state-changed', state));
  commands.handle('imports:get-state', (...args: unknown[]) => { noArguments(args); return imports.getState(); });
  commands.handle('imports:set-target', (...args: unknown[]) => imports.setTarget(target(args)), 'manager');
  for (const action of ['preview', 'confirm-preview', 'cancel-confirmation', 'submit', 'refresh-task', 'retry-task', 'run-task', 'reload-sync-host'] as const) commands.handle(`imports:${action}`, (...args: unknown[]) => {
    const revision = selectionRevision(args);
    if (action === 'preview') return imports.preview(revision);
    if (action === 'confirm-preview') return imports.confirmPreview(revision);
    if (action === 'submit') return imports.submit(revision);
    if (action === 'refresh-task') return imports.refreshTask(revision);
    if (action === 'retry-task') return imports.retryTask(revision);
    if (action === 'run-task') return imports.runTask(revision);
    if (action === 'reload-sync-host') return imports.reloadSyncHost(revision);
    return imports.cancelConfirmation(revision);
  }, 'manager');
}
