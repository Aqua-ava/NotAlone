import type { SyncControlRequest } from '../../shared/sync-control-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { noArguments, type PageCommands } from '../page-commands';
import { SyncControlController } from './controller';

function controlRequest(args: unknown[]): SyncControlRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('同步操作不可用。');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 1 || !Object.hasOwn(fields, 'scopeRevision')
    || typeof fields.scopeRevision !== 'number' || !Number.isSafeInteger(fields.scopeRevision)
    || fields.scopeRevision < 0) throw new Error('同步操作不可用。');
  return { scopeRevision: fields.scopeRevision };
}
export function installSyncControlBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession): void {
  const sync = new SyncControlController(backend, contacts);
  sync.onStateChanged((state) => commands.publish('sync-control:state-changed', state));
  commands.handle('sync-control:get-state', (...args: unknown[]) => { noArguments(args); return sync.getState(); }, 'manager');
  commands.handle('sync-control:refresh', (...args: unknown[]) => { noArguments(args); return sync.refresh(); }, 'manager');
  commands.handle('sync-control:enable', (...args: unknown[]) => sync.enable(controlRequest(args)), 'manager');
  commands.handle('sync-control:disable', (...args: unknown[]) => sync.disable(controlRequest(args)), 'manager');
  commands.handle('sync-control:pause', (...args: unknown[]) => sync.pause(controlRequest(args)), 'manager');
  commands.handle('sync-control:retry', (...args: unknown[]) => sync.retry(controlRequest(args)), 'manager');
}
