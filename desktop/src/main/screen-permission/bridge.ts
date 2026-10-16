import type { PageCommands } from '../page-commands';
import { noArguments } from '../page-commands';
import type { ScreenPermissionController } from './controller';

export function installScreenPermissionBridge(commands: PageCommands, controller: ScreenPermissionController): void {
  commands.handle('screen-permission:get-state', (...args) => { noArguments(args); return controller.getState(); });
  commands.handle('screen-permission:request', (...args) => { noArguments(args); return controller.request(); });
  commands.handle('screen-permission:recheck', (...args) => { noArguments(args); return controller.recheck(); });
  controller.onStateChanged((state) => commands.publish('screen-permission:state-changed', state));
}
