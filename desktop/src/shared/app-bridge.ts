import type { BackendBridge } from './backend-bridge';
import type { DesktopBridge } from './desktop-bridge';
import type { WindowBridge } from './window-bridge';

export type AppBridge = WindowBridge & DesktopBridge & { backend: BackendBridge };
