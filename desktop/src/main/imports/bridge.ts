import { ipcMain } from 'electron';
import type { ImportTarget } from '../../shared/import-bridge';
import type { AppWindows } from '../windows';
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

export function installImportBridge(windows: AppWindows, imports: ImportController): void {
  imports.onStateChanged((state) => windows.publish('imports:state-changed', state));
  ipcMain.handle('imports:get-state', (event, ...args: unknown[]) => { windows.validateCaller(event, args); return imports.getState(); });
  ipcMain.handle('imports:choose-file', (event, ...args: unknown[]) => {
    const window = windows.validateCaller(event, args);
    if (!window.webContents.getURL().endsWith('#manager')) throw new Error('历史导入操作不可用。');
    return imports.chooseFile(window);
  });
  ipcMain.handle('imports:set-target', (event, ...args: unknown[]) => {
    const window = windows.validateCaller(event, []);
    if (!window.webContents.getURL().endsWith('#manager')) throw new Error('历史导入操作不可用。');
    return imports.setTarget(target(args));
  });
  for (const action of ['preview', 'confirm-preview', 'cancel-confirmation'] as const) ipcMain.handle(`imports:${action}`, (event, ...args: unknown[]) => {
    const window = windows.validateCaller(event, []);
    if (!window.webContents.getURL().endsWith('#manager')) throw new Error('历史导入操作不可用。');
    const revision = selectionRevision(args);
    if (action === 'preview') return imports.preview(revision);
    if (action === 'confirm-preview') return imports.confirmPreview(revision);
    return imports.cancelConfirmation(revision);
  });
}
