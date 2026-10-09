import { createCandidateCopyBridge } from '../../src/preload/candidate-copy';
import type { PageTransport } from '../../src/preload/transport';
import { createContactSessionBridge } from '../../src/preload/contact-session';
import { createImportBridge } from '../../src/preload/imports';
import { createMemoryBridge } from '../../src/preload/memory';
import { createReplyBridge } from '../../src/preload/reply';
import { createBindingConsentBridge } from '../../src/preload/binding-consent';
import { createSyncControlBridge } from '../../src/preload/sync-control';
import { createBackendBridge } from '../../src/preload/backend';
import { createStartupBridge } from '../../src/preload/startup';
import type { AppBridge } from '../../src/shared/app-bridge';

const pageWindow = window as unknown as Window & {
  pageCommand(channel: string, args: unknown[]): Promise<unknown>;
  pageEvent(channel: string, state: unknown): void;
};
const listeners = new Map<string, Set<(event: unknown, state: unknown) => void>>();
const transport: PageTransport = {
  invoke: (channel, ...args) => pageWindow.pageCommand(channel, args),
  on(channel, listener) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel)!.add(listener); },
  removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
};
pageWindow.pageEvent = (channel, state) => { for (const listener of listeners.get(channel) ?? []) listener(undefined, state); };
const unsupported = () => Promise.reject(new Error('无头页面未支持此原生或业务入口。'));
const noEvents = () => () => {};
const bridge: AppBridge = {
  candidateCopy: createCandidateCopyBridge(transport),
  backend: createBackendBridge(transport), startup: createStartupBridge(transport),
  contacts: createContactSessionBridge(transport), memory: createMemoryBridge(transport), replies: createReplyBridge(transport),
  openManager: () => transport.invoke('page:open-manager'), openHelper: () => transport.invoke('page:open-helper'), hideWindow: unsupported,
  getDesktopSettings: unsupported, setHelperShortcut: unsupported, setHelperPinned: unsupported, onDesktopSettingsChanged: noEvents,
  setup: { getState: unsupported, refresh: unsupported, initializeOwner: unsupported, saveDeepSeekKey: unsupported,
    retryRestart: unsupported, reloadControlledConfiguration: unsupported, onStateChanged: noEvents },
  imports: createImportBridge(transport),
  bindings: createBindingConsentBridge(transport),
  syncControl: createSyncControlBridge(transport),
};
window.notalone = Object.freeze(bridge);
