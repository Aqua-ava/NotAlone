import type { TraceBatchRequest, TraceFindRequest, TraceListRequest, TraceResource } from '../../shared/trace-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { noArguments, type PageCommands } from '../page-commands';
import { isUuid } from '../uuid';
import { TraceController } from './controller';

const recordKinds = {
  'memory-traces': ['message', 'candidate', 'contact_memory', 'owner_memory'],
  'source-processing-traces': ['message', 'source_ref', 'source_document', 'local_wechat_observation'],
};
function request(args: unknown[], action: 'list' | 'find' | 'show' | 'remove'): TraceListRequest | TraceFindRequest | TraceBatchRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('过程操作不可用。');
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  const allowed = ['contactId', 'scopeRevision', 'resource', ...(action === 'list' ? ['older'] : action === 'find' ? ['kind', 'recordId'] : ['batchId'])];
  if (!keys.every((key) => allowed.includes(key)) || !allowed.filter((key) => key !== 'older').every((key) => keys.includes(key))
    || !isUuid(fields.contactId) || !Number.isSafeInteger(fields.scopeRevision) || (fields.scopeRevision as number) < 0
    || !Object.hasOwn(recordKinds, fields.resource as string)
    || (action === 'list' && keys.includes('older') && typeof fields.older !== 'boolean')
    || (action === 'find' && (!isUuid(fields.recordId) || !recordKinds[fields.resource as TraceResource].includes(fields.kind as string)))
    || ((action === 'show' || action === 'remove') && !isUuid(fields.batchId))) throw new Error('过程操作不可用。');
  return { ...fields, contactId: fields.contactId.toLowerCase(), ...(typeof fields.batchId === 'string' ? { batchId: fields.batchId.toLowerCase() } : {}),
    ...(typeof fields.recordId === 'string' ? { recordId: fields.recordId.toLowerCase() } : {}) } as unknown as TraceListRequest | TraceFindRequest | TraceBatchRequest;
}
export function installTraceBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession): TraceController {
  const traces = new TraceController(backend, contacts);
  traces.onStateChanged((state) => commands.publish('traces:state-changed', state, 'manager'));
  contacts.onStateChanged(() => traces.synchronizeScope());
  backend.onStateChanged(() => traces.synchronizeScope());
  traces.synchronizeScope();
  commands.handle('traces:get-state', (...args) => { noArguments(args); return traces.getState(); }, 'manager');
  commands.handle('traces:list', (...args) => traces.list(request(args, 'list') as TraceListRequest), 'manager');
  commands.handle('traces:find', (...args) => traces.find(request(args, 'find') as TraceFindRequest), 'manager');
  commands.handle('traces:show', (...args) => traces.show(request(args, 'show') as TraceBatchRequest), 'manager');
  commands.handle('traces:remove', (...args) => traces.remove(request(args, 'remove') as TraceBatchRequest), 'manager');
  return traces;
}
