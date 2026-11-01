import type { HistoryClearRequest, HistoryResyncRequest, HistoryRecertifyRequest, HistoryRecertifyCancelRequest } from '../../shared/history-clear-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
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
function resyncRequest(args: unknown[], message = '重新同步需要明确确认。'): HistoryResyncRequest | HistoryRecertifyRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 4 || Object.keys(fields).some(key => !['contactId', 'scopeRevision', 'requestKey', 'confirmed'].includes(key))
    || fields.confirmed !== true || typeof fields.requestKey !== 'string' || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(fields.requestKey)) {
    throw new Error(message);
  }
  return { ...request([{ contactId: fields.contactId, scopeRevision: fields.scopeRevision }]), requestKey: fields.requestKey, confirmed: true };
}
export function installHistoryClearBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession): HistoryClearController {
  const controller = new HistoryClearController(backend, contacts);
  controller.onStateChanged(state => commands.publish('history-clear:state-changed', state));
  commands.handle('history-clear:get-state', (...args: unknown[]) => { noArguments(args); return controller.getState(); }, 'manager');
  commands.handle('history-clear:refresh', (...args: unknown[]) => controller.refresh(request(args)), 'manager');
  commands.handle('history-clear:clear', (...args: unknown[]) => controller.clear(request(args)), 'manager');
  commands.handle('history-clear:resync', (...args: unknown[]) => controller.resync(resyncRequest(args)), 'manager');
  commands.handle('history-clear:recertify', (...args: unknown[]) => controller.recertify(resyncRequest(args, '来源重新认证需要明确确认。')), 'manager');
  commands.handle('history-clear:recertify-cancel', (...args: unknown[]) => {
    const value = args[0] as Record<string, unknown> | undefined;
    if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'contactId,requestKey,scopeRevision'
      || typeof value.requestKey !== 'string' || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(value.requestKey)) throw new Error('停止来源认证需要指定本次操作。');
    const clean: HistoryRecertifyCancelRequest = { ...request([{ contactId: value.contactId, scopeRevision: value.scopeRevision }]), requestKey: value.requestKey };
    return controller.cancelRecertify(clean);
  }, 'manager');
  return controller;
}
