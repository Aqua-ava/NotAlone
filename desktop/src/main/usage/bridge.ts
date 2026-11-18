import { noArguments, type PageCommands } from '../page-commands';
import type { UsageController } from './controller';
export function installUsageBridge(commands: PageCommands, usage: UsageController): void {
  commands.handle('usage:get-state', (...args) => { noArguments(args); return usage.getState(); }, 'manager');
  commands.handle('usage:refresh', (...args) => { noArguments(args); return usage.refresh(); }, 'manager');
  usage.onStateChanged((state) => commands.publish('usage:state-changed', state, 'manager'));
}
