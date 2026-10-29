import {createSqliteMemoryManagementBridge} from './sqlite-memory-management';
import { createMessageMediaBridge } from './media';
import { createUsageBridge } from './usage';
import { createWechatSetupBridge } from './wechat-setup';
import { createForegroundBridge } from './foreground';
import { createCandidateCopyBridge } from './candidate-copy';
import { createSourceDeletionBridge } from './source-deletion';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AppBridge } from '../shared/app-bridge';
import { createBackendBridge } from './backend';
import { createSetupBridge } from './setup';
import { createStartupBridge } from './startup';
import { createScreenPermissionBridge } from './screen-permission';
import { createContactSessionBridge } from './contact-session';
import { createImportBridge } from './imports';
import { createReplyBridge } from './reply';
import { createSqliteDiscussionBridge } from './sqlite-discussion';
import { createCandidateProvenanceBridge } from './candidate-provenance';
import { createExpressionPreferenceBridge } from './expression-preferences';
import { createSkillLearningBridge } from './skill-learning';
import { createMemoryBridge } from './memory';
import { createFixedMemoryProcessingBridge } from './fixed-memory-processing';
import { createBindingConsentBridge } from './binding-consent';
import { createSyncControlBridge } from './sync-control';
import type { DesktopSettings } from '../shared/desktop-bridge';
import { createBackgroundTaskBridge } from './background-tasks';
import { createHistoryClearBridge } from './history-clear';

const bridge: AppBridge = {
  usage: createUsageBridge(ipcRenderer),
  media: createMessageMediaBridge(ipcRenderer),
  backend: createBackendBridge(ipcRenderer),
  setup: createSetupBridge(),
  wechatSetup: createWechatSetupBridge(ipcRenderer),
  startup: createStartupBridge(ipcRenderer),
  screenPermission: createScreenPermissionBridge(ipcRenderer),
  contacts: createContactSessionBridge(ipcRenderer),
  imports: createImportBridge(ipcRenderer),
  replies: createReplyBridge(ipcRenderer),
  sqliteDiscussion: createSqliteDiscussionBridge(ipcRenderer),
  candidateProvenance: createCandidateProvenanceBridge(ipcRenderer),
  expressionPreferences: createExpressionPreferenceBridge(ipcRenderer),
  skillLearning: createSkillLearningBridge(ipcRenderer),
  candidateCopy: createCandidateCopyBridge(ipcRenderer),
  sources: createSourceDeletionBridge(ipcRenderer),
  memory: createMemoryBridge(ipcRenderer),
  fixedMemoryProcessing: createFixedMemoryProcessingBridge(ipcRenderer),
  sqliteMemoryManagement: createSqliteMemoryManagementBridge(ipcRenderer),
  backgroundTasks: createBackgroundTaskBridge(ipcRenderer),
  traces: createTraceBridge(ipcRenderer),
  bindings: createBindingConsentBridge(ipcRenderer),
  foreground: createForegroundBridge(ipcRenderer),
  syncControl: createSyncControlBridge(ipcRenderer),
  historyClear: createHistoryClearBridge(ipcRenderer),
  openManager: () => ipcRenderer.invoke('window:open-manager'),
  openHelper: () => ipcRenderer.invoke('window:open-helper'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  getDesktopSettings: () => ipcRenderer.invoke('desktop:get-settings'),
  setHelperShortcut: (accelerator) => ipcRenderer.invoke('desktop:set-shortcut', accelerator),
  setHelperPinned: (pinned) => ipcRenderer.invoke('desktop:set-helper-pinned', pinned),
  onDesktopSettingsChanged: (listener) => {
    const changed = (_event: IpcRendererEvent, settings: DesktopSettings) => listener(settings);
    ipcRenderer.on('desktop:settings-changed', changed);
    return () => { ipcRenderer.removeListener('desktop:settings-changed', changed); };
  },
};
contextBridge.exposeInMainWorld('notalone', Object.freeze(bridge));
import { createTraceBridge } from './traces';
