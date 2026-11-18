import { pageInvokers, subscribePageState, type PageTransport } from './transport';
import type { ScreenPermissionBridge, ScreenPermissionState } from '../shared/screen-permission-bridge';

export function createScreenPermissionBridge(transport: PageTransport): ScreenPermissionBridge {
  const { empty } = pageInvokers(transport, '屏幕录制授权操作不可用。');
  return Object.freeze({
    getState: (...args: unknown[]) => empty('screen-permission:get-state', args),
    request: (...args: unknown[]) => empty('screen-permission:request', args),
    recheck: (...args: unknown[]) => empty('screen-permission:recheck', args),
    onStateChanged: (listener: (state: ScreenPermissionState) => void) =>
      subscribePageState(transport, 'screen-permission:state-changed', listener, '屏幕录制授权操作不可用。'),
  });
}
