import { validWechatSetupConfirmation, type WechatSetupConfirmation } from '../../shared/wechat-setup-bridge';
import { noArguments, type PageCommands } from '../page-commands';
import type { WechatSetupController } from './wechat-controller';
function confirmation(args: unknown[]): WechatSetupConfirmation {
  const value = args[0];
  if (args.length !== 1 || !validWechatSetupConfirmation(value)) throw new Error('微信连接需要明确确认');
  return { revision: value.revision, confirmed: true, mode: value.mode, historyAuthorized: value.historyAuthorized,
    ...(value.sourceReconfirmed ? { sourceReconfirmed: true } : {}) };
}
export function installWechatSetupBridge(commands: PageCommands, controller: WechatSetupController): void {
  commands.handle('wechat-setup:get-state', (...args) => { noArguments(args); return controller.getState(); }, 'manager');
  commands.handle('wechat-setup:refresh', (...args) => { noArguments(args); return controller.refresh(); }, 'manager');
  commands.handle('wechat-setup:detect', (...args) => { noArguments(args); return controller.detect(); }, 'manager');
  commands.handle('wechat-setup:confirm', (...args) => controller.confirm(confirmation(args)), 'manager');
  commands.handle('wechat-setup:retry-restart', (...args) => { noArguments(args); return controller.retryRestart(); }, 'manager');
  controller.onStateChanged(state => commands.publish('wechat-setup:state-changed', state, 'manager'));
}
