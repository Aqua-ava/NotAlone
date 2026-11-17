import { createDiagnosticLogBridge } from './diagnostics';
import {createSqliteMemoryManagementBridge} from './sqlite-memory-management';
import { createMessageMediaBridge } from './media';
import { createUsageBridge } from './usage';
import { createWechatSetupBridge } from './wechat-setup';
import { createForegroundBridge } from './foreground';
import { createSourceDeletionBridge } from './source-deletion';
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
import { createBackgroundTaskBridge } from './background-tasks';
import { createHistoryClearBridge } from './history-clear';
import { createContactHistoryBridge } from './contact-history';
import { createContactDeletionBridge } from './contact-deletion';
import { createQuarantineBridge } from './quarantine';

type RendererTransport = typeof ipcRenderer;
/** 主进程在加载页面前登记开发态查询；打包宿主不暴露批量入口。 */
function developmentHost(renderer: RendererTransport): boolean {
  try {
    const sendSync = (renderer as { sendSync?: (channel: string) => unknown }).sendSync;
    return typeof sendSync === 'function' && sendSync.call(renderer, 'notalone:host-mode') === 'development';
  } catch { return false; }
}
export function createAppBridge(renderer: RendererTransport, development = developmentHost(renderer)): AppBridge {
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
    sources: createSourceDeletionBridge(renderer),
    fixedMemoryProcessing: createFixedMemoryProcessingBridge(renderer),
    sqliteMemoryManagement: createSqliteMemoryManagementBridge(renderer),
    backgroundTasks: createBackgroundTaskBridge(renderer),
    traces: createTraceBridge(renderer),
    bindings: createBindingConsentBridge(renderer),
    foreground: createForegroundBridge(renderer),
    syncControl: createSyncControlBridge(renderer),
    historyClear: createHistoryClearBridge(renderer),
    contactHistory: createContactHistoryBridge(renderer),
    contactDeletion: createContactDeletionBridge(renderer),
    quarantine: createQuarantineBridge(renderer),
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
import { createTraceBridge } from './traces';
