import type { UsageBridge, UsageState } from '../shared/usage-bridge';
import { subscribePageState, type PageTransport } from './transport';
export function createUsageBridge(transport: PageTransport): UsageBridge {
  return Object.freeze({
    getState: (...args: unknown[]) => args.length === 0 ? transport.invoke('usage:get-state') : Promise.reject(new Error('用量读取不可用。')),
    refresh: (...args: unknown[]) => args.length === 0 ? transport.invoke('usage:refresh') : Promise.reject(new Error('用量读取不可用。')),
    onStateChanged: (listener: (state: UsageState) => void) =>
      subscribePageState(transport, 'usage:state-changed', listener, '用量读取不可用。'),
  });
}
