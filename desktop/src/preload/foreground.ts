import { pageInvokers, subscribePageState, type PageTransport } from './transport';
import type { ForegroundBridge, ForegroundState } from '../shared/foreground-bridge';

export function createForegroundBridge(transport: PageTransport): ForegroundBridge {
  const { empty } = pageInvokers(transport, '前台状态操作不可用。');
  return Object.freeze({
    getState: (...args: unknown[]) => empty('foreground:get-state', args),
    onStateChanged: (listener: (state: ForegroundState) => void) =>
      subscribePageState(transport, 'foreground:state-changed', listener, '前台状态操作不可用。'),
  });
}
