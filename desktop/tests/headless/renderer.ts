import { createForegroundBridge } from '../../src/preload/foreground';
import { createCandidateCopyBridge } from '../../src/preload/candidate-copy';
import { createSourceDeletionBridge } from '../../src/preload/source-deletion';
import type { PageTransport } from '../../src/preload/transport';
import { createContactSessionBridge } from '../../src/preload/contact-session';
import { createImportBridge } from '../../src/preload/imports';
import { createMemoryBridge } from '../../src/preload/memory';
import { createReplyBridge } from '../../src/preload/reply';
import { createStyleSampleBridge } from '../../src/preload/style-samples';
import { createExpressionPreferenceBridge } from '../../src/preload/expression-preferences';
import { createBindingConsentBridge } from '../../src/preload/binding-consent';
import { createSyncControlBridge } from '../../src/preload/sync-control';
import { createBackendBridge } from '../../src/preload/backend';
import { createStartupBridge } from '../../src/preload/startup';
import { createScreenPermissionBridge } from '../../src/preload/screen-permission';
import type { AppBridge } from '../../src/shared/app-bridge';

// 默认关闭；仅本轮普通页面的公开传输控制观察事件与原Promise，不替换业务处理器。
export type PageTransportControl = {
  receiveEvent(channel: string, state: unknown): boolean;
  observeInvoke(channel: string, args: unknown[], pending: Promise<unknown>): void;
};
const pageWindow = window as unknown as Window & {
  pageCommand(channel: string, args: unknown[]): Promise<unknown>;
  pageEvent(channel: string, state: unknown): void;
  pageTransportControl?: PageTransportControl;
};
const listeners = new Map<string, Set<(event: unknown, state: unknown) => void>>();
const transport: PageTransport = {
  invoke: (channel, ...args) => {
    const pending = pageWindow.pageCommand(channel, args);
    pageWindow.pageTransportControl?.observeInvoke(channel, args, pending);
    return pending;
  },
  on(channel, listener) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel)!.add(listener); },
  removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
};
pageWindow.pageEvent = (channel, state) => {
  if (pageWindow.pageTransportControl?.receiveEvent(channel, state)) return;
  for (const listener of listeners.get(channel) ?? []) listener(undefined, state);
};
const unsupported = () => Promise.reject(new Error('无头页面未支持此原生或业务入口。'));
const noEvents = () => () => {};
const bridge: AppBridge = {
  candidateCopy: createCandidateCopyBridge(transport),
  sources: createSourceDeletionBridge(transport),
  traces: createTraceBridge(transport),
  backend: createBackendBridge(transport), startup: createStartupBridge(transport),
  screenPermission: createScreenPermissionBridge(transport),
  contacts: createContactSessionBridge(transport), memory: createMemoryBridge(transport), replies: createReplyBridge(transport),
  styleSamples: createStyleSampleBridge(transport),
  expressionPreferences: createExpressionPreferenceBridge(transport),
  skillLearning: createSkillLearningBridge(transport),
  openManager: () => transport.invoke('page:open-manager'), openHelper: () => transport.invoke('page:open-helper'), hideWindow: unsupported,
  getDesktopSettings: unsupported, setHelperShortcut: unsupported, setHelperPinned: unsupported, onDesktopSettingsChanged: noEvents,
  setup: { getState: unsupported, refresh: unsupported, initializeOwner: unsupported, saveDeepSeekKey: unsupported, saveOfficialDeepSeekKey: unsupported,
    retryRestart: unsupported, reloadControlledConfiguration: unsupported, onStateChanged: noEvents },
  imports: createImportBridge(transport),
  bindings: createBindingConsentBridge(transport),
  foreground: createForegroundBridge(transport),
  syncControl: createSyncControlBridge(transport),
};
window.notalone = Object.freeze(bridge);
import { createTraceBridge } from '../../src/preload/traces';
import { createSkillLearningBridge } from '../../src/preload/skill-learning';
