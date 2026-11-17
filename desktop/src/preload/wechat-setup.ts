import { validWechatSetupConfirmation, type WechatSetupBridge, type WechatSetupConfirmation, type WechatSetupState } from '../shared/wechat-setup-bridge';
import { subscribePageState, type PageTransport } from './transport';
export function createWechatSetupBridge(transport: PageTransport): WechatSetupBridge {
  const empty = (channel: string, args: unknown[]) => args.length === 0
    ? transport.invoke(channel) : Promise.reject(new Error('微信连接操作不可用'));
  return Object.freeze({
    getState: (...args: unknown[]) => empty('wechat-setup:get-state', args),
    refresh: (...args: unknown[]) => empty('wechat-setup:refresh', args),
    detect: (...args: unknown[]) => empty('wechat-setup:detect', args),
    retryRestart: (...args: unknown[]) => empty('wechat-setup:retry-restart', args),
    confirm: (...args: [WechatSetupConfirmation]) => args.length === 1 && validWechatSetupConfirmation(args[0])
      ? transport.invoke('wechat-setup:confirm', args[0]) : Promise.reject(new Error('微信连接操作不可用')),
    onStateChanged: (listener: (state: WechatSetupState) => void) =>
      subscribePageState(transport, 'wechat-setup:state-changed', listener, '微信连接操作不可用'),
  });
}
