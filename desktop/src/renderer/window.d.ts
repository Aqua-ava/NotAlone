import type { WindowBridge } from '../shared/window-bridge';

declare global {
  interface Window { notalone: WindowBridge; }
}
