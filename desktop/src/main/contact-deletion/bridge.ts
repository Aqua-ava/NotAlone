import { validContactDeletionRequest, validContactDeletionRetry } from '../../shared/contact-deletion-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import type { ContactDeletionQuiet } from '../contacts/deletion-quiet';
import { noArguments, type PageCommands } from '../page-commands';
import { ContactDeletionController } from './controller';

export function installContactDeletionBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession,
  beginReadingScopeChange: () => (() => void), invalidateContact: (contactId: string) => void,
  quiet?: ContactDeletionQuiet): ContactDeletionController {
  const deletion = new ContactDeletionController(backend, contacts, beginReadingScopeChange, invalidateContact, quiet);
  deletion.onStateChanged(state => commands.publish('contact-deletion:state-changed', state, 'manager'));
  commands.handle('contact-deletion:get-state', (...args: unknown[]) => { noArguments(args); return deletion.getState(); }, 'manager');
  commands.handle('contact-deletion:refresh', (...args: unknown[]) => { noArguments(args); return deletion.refresh(); }, 'manager');
  commands.handle('contact-deletion:delete', (...args: unknown[]) => {
    if (args.length !== 1 || !validContactDeletionRequest(args[0])) throw new Error('删除联系人需要核对当前对象并明确确认。');
    return deletion.delete({ ...args[0], contactId: args[0].contactId.toLowerCase() });
  }, 'manager');
  commands.handle('contact-deletion:retry', (...args: unknown[]) => {
    if (args.length !== 1 || !validContactDeletionRetry(args[0])) throw new Error('重试删除需要核对原任务并明确确认。');
    return deletion.retry({ ...args[0], id: args[0].id.toLowerCase() });
  }, 'manager');
  return deletion;
}
