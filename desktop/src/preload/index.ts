import { createDiagnosticLogBridge } from './diagnostics';
import {createSqliteMemoryManagementBridge} from './sqlite-memory-management';
import { createMessageMediaBridge } from './media';
import { createUsageBridge } from './usage';
import { createWechatSetupBridge } from './wechat-setup';
import { createForegroundBridge } from './foreground';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AppBridge } from '../shared/app-bridge';
import { createBackendBridge } from './backend';
import { createSetupBridge } from './setup';
import { createStartupBridge } from './startup';
import { createScreenPermissionBridge } from './screen-permission';
import { createContactSessionBridge } from './contact-session';
import { createReplyBridge } from './reply';
import { createSqliteDiscussionBridge } from './sqlite-discussion';
import { createSkillLearningBridge } from './skill-learning';
import { createFixedMemoryProcessingBridge } from './fixed-memory-processing';
import { createBindingConsentBridge } from './binding-consent';
import { createSyncControlBridge } from './sync-control';
import type { DesktopSettings } from '../shared/desktop-bridge';
import { createHistoryClearBridge } from './history-clear';
import { createContactHistoryBridge } from './contact-history';
import { createContactDeletionBridge } from './contact-deletion';

type RendererTransport = typeof ipcRenderer;
export function createAppBridge(renderer: RendererTransport): AppBridge {
  return {
    diagnosticLogs: createDiagnosticLogBridge(renderer),
    usage: createUsageBridge(renderer),
    media: createMessageMediaBridge(renderer),
    backend: createBackendBridge(renderer),
    setup: createSetupBridge(),
    wechatSetup: createWechatSetupBridge(renderer),
    startup: createStartupBridge(renderer),
    screenPermission: createScreenPermissionBridge(renderer),
    contacts: createContactSessionBridge(renderer),
    replies: createReplyBridge(renderer),
    sqliteDiscussion: createSqliteDiscussionBridge(renderer),
    skillLearning: createSkillLearningBridge(renderer),
    fixedMemoryProcessing: createFixedMemoryProcessingBridge(renderer),
    sqliteMemoryManagement: createSqliteMemoryManagementBridge(renderer),
    bindings: createBindingConsentBridge(renderer),
    foreground: createForegroundBridge(renderer),
    syncControl: createSyncControlBridge(renderer),
    historyClear: createHistoryClearBridge(renderer),
    contactHistory: createContactHistoryBridge(renderer),
    contactDeletion: createContactDeletionBridge(renderer),
    openManager: () => renderer.invoke('window:open-manager'),
    openHelper: () => renderer.invoke('window:open-helper'),
    hideWindow: () => renderer.invoke('window:hide'),
    getDesktopSettings: () => renderer.invoke('desktop:get-settings'),
    setHelperShortcut: (accelerator) => renderer.invoke('desktop:set-shortcut', accelerator),
    setHelperPinned: (pinned) => renderer.invoke('desktop:set-helper-pinned', pinned),
    onDesktopSettingsChanged: (listener) => {
      const changed = (_event: IpcRendererEvent, settings: DesktopSettings) => listener(settings);
      renderer.on('desktop:settings-changed', changed);
      return () => { renderer.removeListener('desktop:settings-changed', changed); };
    },
  };
}
const bridge = createAppBridge(ipcRenderer);
contextBridge.exposeInMainWorld('notalone', Object.freeze(bridge));
