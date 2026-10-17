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
import { createStyleSampleBridge } from './style-samples';
import { createExpressionPreferenceBridge } from './expression-preferences';
import { createSkillLearningBridge } from './skill-learning';
import { createMemoryUpgradeBridge } from './memory-upgrade';
import { createMemoryBridge } from './memory';
import { createBindingConsentBridge } from './binding-consent';
import { createSyncControlBridge } from './sync-control';
import type { DesktopSettings } from '../shared/desktop-bridge';

const bridge: AppBridge = {
  backend: createBackendBridge(ipcRenderer),
  setup: createSetupBridge(),
  startup: createStartupBridge(ipcRenderer),
  screenPermission: createScreenPermissionBridge(ipcRenderer),
  contacts: createContactSessionBridge(ipcRenderer),
  imports: createImportBridge(ipcRenderer),
  replies: createReplyBridge(ipcRenderer),
  styleSamples: createStyleSampleBridge(ipcRenderer),
  expressionPreferences: createExpressionPreferenceBridge(ipcRenderer),
  skillLearning: createSkillLearningBridge(ipcRenderer),
  memoryUpgrade: createMemoryUpgradeBridge(ipcRenderer),
  candidateCopy: createCandidateCopyBridge(ipcRenderer),
  sources: createSourceDeletionBridge(ipcRenderer),
  memory: createMemoryBridge(ipcRenderer),
  traces: createTraceBridge(ipcRenderer),
  bindings: createBindingConsentBridge(ipcRenderer),
  foreground: createForegroundBridge(ipcRenderer),
  syncControl: createSyncControlBridge(ipcRenderer),
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
