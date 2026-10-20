import type { PageTransport } from './transport';
import type { BindingConfirmation, BindingConsentBridge, BindingConsentState, BindingRevocation } from '../shared/binding-consent-bridge';

export function createBindingConsentBridge(transport: PageTransport): BindingConsentBridge {
  const invoke = (channel: string, args: unknown[]) => args.length === 0 ? transport.invoke(channel) : Promise.reject(new Error('授权操作不可用。'));
  return Object.freeze({
    getState: (...args: unknown[]) => invoke('bindings:get-state', args),
    refresh: (...args: unknown[]) => invoke('bindings:refresh', args),
    refreshSaved: (...args: unknown[]) => invoke('bindings:refresh-saved', args),
    confirmSelections: (...args: [BindingConfirmation]) => args.length === 1 ? transport.invoke('bindings:confirm-selections', args[0]) : Promise.reject(new Error('授权操作不可用。')),
    revokeBinding: (...args: [BindingRevocation]) => args.length === 1 ? transport.invoke('bindings:revoke-binding', args[0]) : Promise.reject(new Error('授权操作不可用。')),
    onStateChanged: (listener: (state: BindingConsentState) => void) => {
      if (typeof listener !== 'function') throw new Error('授权操作不可用。');
      const receive = (_event: unknown, state: BindingConsentState) => listener(state);
      transport.on('bindings:state-changed', receive);
      return () => transport.removeListener('bindings:state-changed', receive);
    },
  });
}
