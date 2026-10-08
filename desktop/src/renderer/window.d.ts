import type { AppBridge } from '../shared/app-bridge';

declare global {
  interface Window { notalone: AppBridge; }
}
