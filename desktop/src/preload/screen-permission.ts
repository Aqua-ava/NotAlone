import type { PageTransport } from './transport';
import type { ScreenPermissionBridge, ScreenPermissionState } from '../shared/screen-permission-bridge';

export function createScreenPermissionBridge(transport: PageTransport): ScreenPermissionBridge {
  const invoke = (channel: string, args: unknown[]) => args.length === 0
    ? transport.invoke(channel) : Promise.reject(new Error('屏幕录制授权操作不可用。'));
  return Object.freeze({
    getState: (...args: unknown[]) => invoke('screen-permission:get-state', args),
    request: (...args: unknown[]) => invoke('screen-permission:request', args),
    recheck: (...args: unknown[]) => invoke('screen-permission:recheck', args),
    onStateChanged: (listener: (state: ScreenPermissionState) => void) => {
      if (typeof listener !== 'function') throw new Error('屏幕录制授权操作不可用。');
      const receive = (_event: unknown, state: ScreenPermissionState) => listener(state);
      transport.on('screen-permission:state-changed', receive);
      return () => transport.removeListener('screen-permission:state-changed', receive);
    },
  });
}
