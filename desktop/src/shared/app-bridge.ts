import type { BackendBridge } from './backend-bridge';
import type { DesktopBridge } from './desktop-bridge';
import type { WindowBridge } from './window-bridge';
import type { SetupBridge } from './setup-bridge';
import type { StartupBridge } from './startup-bridge';
import type { ContactSessionBridge } from './contact-session-bridge';
import type { BindingConsentBridge } from './binding-consent-bridge';

export type AppBridge = WindowBridge & DesktopBridge & {
  backend: BackendBridge; setup: SetupBridge; startup: StartupBridge;
  contacts: ContactSessionBridge; bindings: BindingConsentBridge;
};
