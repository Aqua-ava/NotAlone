import { subscribePageState, type PageTransport } from './transport';
import type { ForegroundBridge, ForegroundState } from '../shared/foreground-bridge';

export function createForegroundBridge(transport: PageTransport): ForegroundBridge {
  return Object.freeze({
    getState: (...args: unknown[]) => args.length === 0 ? transport.invoke('foreground:get-state')
      : Promise.reject(new Error('前台状态操作不可用。')),
    confirm: (...args: unknown[]) => args.length === 1 ? transport.invoke('foreground:confirm', args[0])
      : Promise.reject(new Error('前台联系人确认不可用。')),
    onStateChanged: (listener: (state: ForegroundState) => void) =>
      subscribePageState(transport, 'foreground:state-changed', listener, '前台状态操作不可用。'),
  });
}
