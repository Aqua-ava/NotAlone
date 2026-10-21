import type { WechatSetupConfirmation } from '../../shared/wechat-setup-bridge';
import { noArguments, type PageCommands } from '../page-commands';
import type { WechatSetupController } from './wechat-controller';
function confirmation(args: unknown[]): WechatSetupConfirmation {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('微信连接需要明确确认');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 2 || fields.confirmed !== true || !Object.hasOwn(fields, 'revision')
    || typeof fields.revision !== 'number' || !Number.isSafeInteger(fields.revision) || fields.revision < 0) throw new Error('微信连接需要明确确认');
  return { revision: fields.revision, confirmed: true };
}
export function installWechatSetupBridge(commands: PageCommands, controller: WechatSetupController): void {
  commands.handle('wechat-setup:get-state', (...args) => { noArguments(args); return controller.getState(); }, 'manager');
  commands.handle('wechat-setup:refresh', (...args) => { noArguments(args); return controller.refresh(); }, 'manager');
  commands.handle('wechat-setup:detect', (...args) => { noArguments(args); return controller.detect(); }, 'manager');
  commands.handle('wechat-setup:confirm', (...args) => controller.confirm(confirmation(args)), 'manager');
  commands.handle('wechat-setup:retry-restart', (...args) => { noArguments(args); return controller.retryRestart(); }, 'manager');
  controller.onStateChanged(state => commands.publish('wechat-setup:state-changed', state, 'manager'));
}
