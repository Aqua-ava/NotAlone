import { noArguments, type PageCommands } from '../page-commands';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { normalizeUuid } from '../uuid';
import type { ForegroundConfirmation } from '../../shared/foreground-bridge';
import { ForegroundController } from './controller';
import { selectionArguments } from '../contacts/bridge';
import { BackendRequestFailure } from '../backend/json-client';

function confirmationArguments(args: unknown[]): ForegroundConfirmation {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('前台联系人确认不可用。');
  const fields = value as Record<string, unknown>;
  const contactId = normalizeUuid(fields.contactId);
  const keys = ['contactId', 'contactScopeRevision', 'foregroundRevision'];
  if (Object.keys(fields).length !== keys.length || !Object.keys(fields).every((key) => keys.includes(key))
    || contactId === null || typeof fields.contactScopeRevision !== 'number'
    || !Number.isSafeInteger(fields.contactScopeRevision) || fields.contactScopeRevision < 0
    || typeof fields.foregroundRevision !== 'number' || !Number.isSafeInteger(fields.foregroundRevision)
    || fields.foregroundRevision < 0) throw new Error('前台联系人确认不可用。');
  return { contactId, contactScopeRevision: fields.contactScopeRevision, foregroundRevision: fields.foregroundRevision };
}

export function installForegroundBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession): ForegroundController {
  const controller = new ForegroundController(backend, contacts);
  controller.onStateChanged((state) => commands.publish('foreground:state-changed', state));
  commands.handle('foreground:get-state', (...args: unknown[]) => {
    noArguments(args); return controller.getState();
  }, 'helper');
  commands.handle('foreground:confirm', async (...args: unknown[]) => {
    const confirmation = confirmationArguments(args);
    const generation = controller.checkConfirmation(confirmation);
    // 只复验当前联系人已有绑定；不依赖同步服务，也不读取其他联系人的目录。
    let response;
    try {
      response = await backend.requestJson({ method: 'GET',
        path: `/api/contacts/${confirmation.contactId}/assistant-session/binding` });
    } catch (error) {
      if (error instanceof BackendRequestFailure && error.status === 409 && error.code === 'assistant_session_rejected') {
        throw new Error('foreground_binding_required');
      }
      throw error;
    }
    if (response.generation !== generation || backend.getConnectionGeneration() !== generation) {
      throw new Error('联系人确认已失效，请重新选择本次联系人。');
    }
    controller.checkConfirmation(confirmation);
    const data = response.data;
    if (!data || typeof data !== 'object' || Object.keys(data).length !== 1 || !('confirmed' in data) || data.confirmed !== true) {
      throw new Error('微信绑定暂时无法核验，请重试或切换为手动输入。');
    }
    const selected = controller.confirm(confirmation);
    backend.clearManualInput(confirmation.contactId);
    return selected;
  }, 'helper');
  commands.handle('foreground:resume', (...args: unknown[]) => {
    return controller.resume(confirmationArguments(args));
  }, 'helper');
  commands.handle('contacts:confirm-manual', async (...args: unknown[]) => {
    const selection = selectionArguments(args);
    const generation = backend.getConnectionGeneration(), state = contacts.getState();
    if (generation === undefined || selection.scopeRevision !== state.scopeRevision
      || state.directoryPhase !== 'ready' || !state.contacts.some(item => item.contactId === selection.contactId)) throw new Error('联系人选择已失效。');
    const response = await backend.requestJson({ method: 'POST', path: `/api/contacts/${selection.contactId}/manual-confirmation`, body: {}, maxResponseBytes: 4096 });
    if (response.generation !== generation || backend.getConnectionGeneration() !== generation
      || selection.scopeRevision !== contacts.getState().scopeRevision) throw new Error('联系人选择已失效。');
    backend.confirmManualInput(selection.contactId, generation);
    return controller.confirmManual(selection);
  });
  return controller;
}
