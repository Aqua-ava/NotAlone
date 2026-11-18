import type { UsageBridge, UsageState } from '../shared/usage-bridge';
import { pageInvokers, subscribePageState, type PageTransport } from './transport';
export function createUsageBridge(transport: PageTransport): UsageBridge {
  const { empty } = pageInvokers(transport, '用量读取不可用。');
  return Object.freeze({
    getState: (...args: unknown[]) => empty('usage:get-state', args),
    refresh: (...args: unknown[]) => empty('usage:refresh', args),
    onStateChanged: (listener: (state: UsageState) => void) =>
      subscribePageState(transport, 'usage:state-changed', listener, '用量读取不可用。'),
  });
}
