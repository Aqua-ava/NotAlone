import { noArguments, type PageCommands } from '../page-commands';
import type { MemoryReadRequest, MemorySectionName } from '../../shared/memory-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { MemoryReadingController } from './controller';

function requestArguments(args: unknown[]): MemoryReadRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('资料读取不可用。');
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  if ((keys.length !== 2 && keys.length !== 3) || !keys.includes('contactId') || !keys.includes('scopeRevision')
    || !keys.every((key) => ['contactId', 'scopeRevision', 'section'].includes(key))
    || typeof fields.contactId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(fields.contactId)
    || typeof fields.scopeRevision !== 'number' || !Number.isSafeInteger(fields.scopeRevision) || fields.scopeRevision < 0
    || (keys.includes('section') && !['contact', 'owner', 'pending', 'sources'].includes(fields.section as string))) {
    throw new Error('资料读取不可用。');
  }
  return { contactId: fields.contactId.toLowerCase(), scopeRevision: fields.scopeRevision,
    ...(keys.includes('section') ? { section: fields.section as MemorySectionName } : {}) };
}
export function installMemoryBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession): MemoryReadingController {
  const memory = new MemoryReadingController(backend, contacts);
  memory.onStateChanged((state) => commands.publish('memory:state-changed', state));
  contacts.onStateChanged(() => memory.synchronizeScope());
  backend.onStateChanged(() => memory.synchronizeScope());
  memory.synchronizeScope();
  commands.handle('memory:get-state', (...args: unknown[]) => {
    noArguments(args);
    return memory.getState();
  });
  commands.handle('memory:refresh', (...args: unknown[]) => {
    return memory.refresh(requestArguments(args));
  });
  return memory;
}
