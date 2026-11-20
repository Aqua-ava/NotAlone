import type { HistoryClearRequest, HistoryResyncRequest } from '../../shared/history-clear-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import type { DesktopDataLifecycle } from '../data-lifecycle';
import { noArguments, type PageCommands } from '../page-commands';
import { isUuid } from '../uuid';
import { HistoryClearController } from './controller';

function request(args: unknown[]): HistoryClearRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('清空操作不可用。');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 2 || Object.keys(fields).some(key => !['contactId', 'scopeRevision'].includes(key))
    || !isUuid(fields.contactId) || typeof fields.scopeRevision !== 'number' || !Number.isSafeInteger(fields.scopeRevision)
    || fields.scopeRevision < 0) throw new Error('清空操作不可用。');
  return { contactId: (fields.contactId as string).toLowerCase(), scopeRevision: fields.scopeRevision };
}
function resyncRequest(args: unknown[], message = '重新同步需要明确确认。'): HistoryResyncRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 4 || Object.keys(fields).some(key => !['contactId', 'scopeRevision', 'requestKey', 'confirmed'].includes(key))
    || fields.confirmed !== true || typeof fields.requestKey !== 'string' || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(fields.requestKey)) {
    throw new Error(message);
  }
  return { ...request([{ contactId: fields.contactId, scopeRevision: fields.scopeRevision }]), requestKey: fields.requestKey, confirmed: true };
}
export function installHistoryClearBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession,
  lifecycle: Pick<DesktopDataLifecycle, 'beginHistoryClear' | 'historyResyncCompleted'>): HistoryClearController {
  const controller = new HistoryClearController(backend, contacts, lifecycle);
  controller.onStateChanged(state => commands.publish('history-clear:state-changed', state));
  commands.handle('history-clear:get-state', (...args: unknown[]) => { noArguments(args); return controller.getState(); }, 'manager');
  commands.handle('history-clear:refresh', (...args: unknown[]) => controller.refresh(request(args)), 'manager');
  commands.handle('history-clear:clear', (...args: unknown[]) => controller.clear(request(args)), 'manager');
  commands.handle('history-clear:resync', (...args: unknown[]) => controller.resync(resyncRequest(args)), 'manager');
  return controller;
}
