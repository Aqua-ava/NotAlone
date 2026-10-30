import { noArguments, type PageCommands } from '../page-commands';
import type { QuarantineController } from './controller';

export function installQuarantineBridge(commands: PageCommands, controller: QuarantineController): void {
  commands.handle('quarantine:list', (...args) => {
    noArguments(args);
    return controller.list().catch(() => { throw new Error('未能读取本机隔离历史，请重试。'); });
  }, 'manager');
  commands.handle('quarantine:open', (...args) => {
    if (args.length !== 1 || typeof args[0] !== 'string'
      || !/^snapshot-\d{8}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(args[0])) {
      throw new Error('隔离历史选择已失效，请刷新。');
    }
    return controller.open(args[0]).catch(() => { throw new Error('未能打开本机隔离历史，请刷新后重试。'); });
  }, 'manager');
}
