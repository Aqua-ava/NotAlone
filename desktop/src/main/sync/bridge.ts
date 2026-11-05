import type { HistoryAuthorizationRequest, SyncControlRequest, SyncScopeRequest } from '../../shared/sync-control-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactDeletionQuiet } from '../contacts/deletion-quiet';
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
function scopeRequest(args: unknown[]): SyncScopeRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('同步范围操作不可用。');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 3 || Object.keys(fields).some((key) => !['scopeRevision', 'mode', 'confirmed'].includes(key)) || fields.confirmed !== true
    || (fields.mode !== 'selected' && fields.mode !== 'all_private')) throw new Error('同步范围需要明确确认。');
  return { ...controlRequest([{ scopeRevision: fields.scopeRevision }]), mode: fields.mode, confirmed: true };
}
function historyAuthorizationRequest(args: unknown[]): HistoryAuthorizationRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('历史读取授权操作不可用。');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 3 || Object.keys(fields).some((key) => !['scopeRevision', 'decision', 'confirmed'].includes(key))
    || fields.confirmed !== true || (fields.decision !== 'accepted' && fields.decision !== 'declined')) {
    throw new Error('历史读取授权需要明确确认。');
  }
  return { ...controlRequest([{ scopeRevision: fields.scopeRevision }]), decision: fields.decision, confirmed: true };
}
export function installSyncControlBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession,
  beginReadingScopeChange?: () => (() => void), quiet?: ContactDeletionQuiet): SyncControlController {
  const sync = new SyncControlController(backend, contacts, beginReadingScopeChange, quiet);
  sync.onStateChanged((state) => commands.publish('sync-control:state-changed', state));
  commands.handle('sync-control:get-state', (...args: unknown[]) => { noArguments(args); return sync.getState(); }, ['manager','helper']);
  commands.handle('sync-control:refresh', (...args: unknown[]) => { noArguments(args); return sync.refresh(); }, ['manager','helper']);
  commands.handle('sync-control:set-scope', (...args: unknown[]) => sync.setScope(scopeRequest(args)), 'manager');
  commands.handle('sync-control:set-history-authorization', (...args: unknown[]) => sync.setHistoryAuthorization(historyAuthorizationRequest(args)), 'manager');
  commands.handle('sync-control:enable', (...args: unknown[]) => sync.enable(controlRequest(args)), 'manager');
  commands.handle('sync-control:disable', (...args: unknown[]) => sync.disable(controlRequest(args)), 'manager');
  commands.handle('sync-control:pause', (...args: unknown[]) => sync.pause(controlRequest(args)), 'manager');
  commands.handle('sync-control:retry', (...args: unknown[]) => sync.retry(controlRequest(args)), 'manager');
  return sync;
}
