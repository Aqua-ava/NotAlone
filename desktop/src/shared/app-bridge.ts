import type { BackendBridge } from './backend-bridge';
import type { WindowBridge } from './window-bridge';

export type AppBridge = WindowBridge & { backend: BackendBridge };
