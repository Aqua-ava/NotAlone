import { pageInvokers, subscribePageState, type PageTransport } from './transport';
import { validBindingHistoryChoice, type BindingConfirmation, type BindingConsentBridge, type BindingConsentState, type BindingRevocation } from '../shared/binding-consent-bridge';

export function createBindingConsentBridge(transport: PageTransport): BindingConsentBridge {
  const { empty, single, reject } = pageInvokers(transport, '授权操作不可用。');
  return Object.freeze({
    getState: (...args: unknown[]) => empty('bindings:get-state', args),
    refresh: (...args: unknown[]) => empty('bindings:refresh', args),
    refreshSaved: (...args: unknown[]) => empty('bindings:refresh-saved', args),
    confirmSelections: (...args: [BindingConfirmation]) => args.length === 1 && validBindingHistoryChoice(args[0]) ? transport.invoke('bindings:confirm-selections', args[0]) : reject(),
    revokeBinding: (...args: [BindingRevocation]) => single('bindings:revoke-binding', args),
    onStateChanged: (listener: (state: BindingConsentState) => void) =>
      subscribePageState(transport, 'bindings:state-changed', listener, '授权操作不可用。'),
  });
}
