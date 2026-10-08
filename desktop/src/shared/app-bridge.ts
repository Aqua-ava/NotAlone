import type { BackendBridge } from './backend-bridge';
import type { DesktopBridge } from './desktop-bridge';
import type { WindowBridge } from './window-bridge';
import type { SetupBridge } from './setup-bridge';
import type { ContactSessionBridge } from './contact-session-bridge';

export type AppBridge = WindowBridge & DesktopBridge & {
  backend: BackendBridge; setup: SetupBridge; contacts: ContactSessionBridge;
};
