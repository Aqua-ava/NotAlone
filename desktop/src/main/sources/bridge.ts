import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { noArguments, type PageCommands } from '../page-commands';
import { isUuid } from '../uuid';
import type { ContactSelection } from '../../shared/contact-session-bridge';
import type { SourceDeletionRequest } from '../../shared/source-deletion-bridge';
import { SourceDeletionController } from './controller';

function selection(args: unknown[], deletion: boolean): ContactSelection | SourceDeletionRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('来源操作不可用。');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== (deletion ? 3 : 2) || !Object.keys(fields).every((key) => ['contactId', 'scopeRevision', ...(deletion ? ['sourceId'] : [])].includes(key))
    || !isUuid(fields.contactId) || typeof fields.scopeRevision !== 'number' || !Number.isSafeInteger(fields.scopeRevision) || fields.scopeRevision < 0
    || (deletion && !isUuid(fields.sourceId))) throw new Error('来源操作不可用。');
  return { contactId: fields.contactId.toLowerCase(), scopeRevision: fields.scopeRevision,
    ...(deletion ? { sourceId: (fields.sourceId as string).toLowerCase() } : {}) };
}
export function installSourceDeletionBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession,
  onSourceChanged: (contactId: string) => Promise<void>) {
  const sources = new SourceDeletionController(backend, contacts, onSourceChanged);
  sources.onStateChanged((state) => commands.publish('sources:state-changed', state));
  commands.handle('sources:get-state', (...args: unknown[]) => { noArguments(args); return sources.getState(); }, 'manager');
  commands.handle('sources:refresh', (...args: unknown[]) => sources.refresh(selection(args, false)), 'manager');
  commands.handle('sources:delete', (...args: unknown[]) => sources.delete(selection(args, true) as SourceDeletionRequest), 'manager');
  return sources;
}
