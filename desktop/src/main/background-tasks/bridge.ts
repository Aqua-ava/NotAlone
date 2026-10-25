import {
  backgroundTaskSelection,
} from './controller';
import { BackgroundTaskController } from './controller';
import { isUuid } from '../uuid';
import type { PageCommands } from '../page-commands';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import type { BackgroundTaskSelection } from '../../shared/background-task-bridge';

function taskArguments(args: unknown[]): BackgroundTaskSelection & { taskId: string } {
  const value = args[0] as Record<string, unknown> | undefined;
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
    || !isUuid(value.taskId)) {
    throw new Error('后台任务操作不可用。');
  }
  const { taskId, ...selection } = value;
  return { ...backgroundTaskSelection(selection), taskId: taskId.toLowerCase() };
}

export function installBackgroundTaskBridge(
  commands: PageCommands,
  backend: BackendHost,
  contacts: ContactSession,
): BackgroundTaskController {
  const controller = new BackgroundTaskController(backend, contacts);
  commands.handle('background-tasks:read', (...args: unknown[]) =>
    controller.read(backgroundTaskSelection(args[0])), 'manager');
  commands.handle('background-tasks:stop', (...args: unknown[]) =>
    controller.stop(taskArguments(args)), 'manager');
  commands.handle('background-tasks:recover', (...args: unknown[]) =>
    controller.recover(taskArguments(args)), 'manager');
  commands.handle('background-tasks:cancel-read', (...args: unknown[]) => {
    backgroundTaskSelection(args[0]);
    controller.cancelRead();
  }, 'manager');
  commands.handle('background-tasks:get-state', (...args: unknown[]) => {
    if (args.length) throw new Error('后台任务读取不可用。');
    return controller.getState();
  }, 'manager');
  controller.onStateChanged(state => commands.publish('background-tasks:state-changed', state, 'manager'));
  contacts.onStateChanged(() => controller.synchronizeScope());
  backend.onStateChanged(() => controller.synchronizeScope());
  controller.synchronizeScope();
  return controller;
}
