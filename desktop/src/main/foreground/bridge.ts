import { noArguments, type PageCommands } from '../page-commands';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { ForegroundController } from './controller';
import { selectionArguments } from '../contacts/bridge';

export function installForegroundBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession): ForegroundController {
  const controller = new ForegroundController(backend, contacts);
  controller.onStateChanged((state) => commands.publish('foreground:state-changed', state));
  commands.handle('foreground:get-state', (...args: unknown[]) => {
    noArguments(args); return controller.getState();
  }, 'helper');
  commands.handle('contacts:confirm-manual', async (...args: unknown[]) => {
    const selection = selectionArguments(args);
    const generation = backend.getConnectionGeneration(), state = contacts.getState();
    if (generation === undefined || selection.scopeRevision !== state.scopeRevision
      || state.directoryPhase !== 'ready' || !state.contacts.some(item => item.contactId === selection.contactId)) throw new Error('联系人选择已失效。');
    const response = await backend.requestJson({ method: 'POST', path: `/api/contacts/${selection.contactId}/manual-confirmation`, body: {}, maxResponseBytes: 4096 });
    if (response.generation !== generation || backend.getConnectionGeneration() !== generation
      || selection.scopeRevision !== contacts.getState().scopeRevision) throw new Error('联系人选择已失效。');
    return controller.confirmManual(selection);
  });
  return controller;
}
