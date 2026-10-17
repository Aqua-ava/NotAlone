import type { ExpressionPreferenceBridge, ExpressionPreferenceState } from '../shared/expression-preference-bridge';
import type { PageTransport } from './transport';

export function createExpressionPreferenceBridge(transport: PageTransport): ExpressionPreferenceBridge {
  return Object.freeze({
    getState: (...args: unknown[]) => args.length ? Promise.reject(new Error('长期偏好操作无效。')) : transport.invoke('expression-preferences:get-state'),
    refresh: (...args: unknown[]) => transport.invoke('expression-preferences:refresh', ...args),
    save: (...args: unknown[]) => transport.invoke('expression-preferences:save', ...args),
    update: (...args: unknown[]) => transport.invoke('expression-preferences:update', ...args),
    remove: (...args: unknown[]) => transport.invoke('expression-preferences:remove', ...args),
    onStateChanged: (listener: (state: ExpressionPreferenceState) => void) => {
      if (typeof listener !== 'function') throw new Error('长期偏好操作无效。');
      const receive = (_event: unknown, state: ExpressionPreferenceState) => listener(state);
      transport.on('expression-preferences:state-changed', receive);
      return () => transport.removeListener('expression-preferences:state-changed', receive);
    },
  });
}
