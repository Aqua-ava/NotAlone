import { validWechatSetupConfirmation, type WechatSetupBridge, type WechatSetupConfirmation, type WechatSetupState } from '../shared/wechat-setup-bridge';
import { pageInvokers, subscribePageState, type PageTransport } from './transport';
export function createWechatSetupBridge(transport: PageTransport): WechatSetupBridge {
  const { empty, reject } = pageInvokers(transport, '微信连接操作不可用');
  return Object.freeze({
    getState: (...args: unknown[]) => empty('wechat-setup:get-state', args),
    refresh: (...args: unknown[]) => empty('wechat-setup:refresh', args),
    detect: (...args: unknown[]) => empty('wechat-setup:detect', args),
    retryRestart: (...args: unknown[]) => empty('wechat-setup:retry-restart', args),
    confirm: (...args: [WechatSetupConfirmation]) => args.length === 1 && validWechatSetupConfirmation(args[0])
      ? transport.invoke('wechat-setup:confirm', args[0]) : reject(),
    onStateChanged: (listener: (state: WechatSetupState) => void) =>
      subscribePageState(transport, 'wechat-setup:state-changed', listener, '微信连接操作不可用'),
  });
}
