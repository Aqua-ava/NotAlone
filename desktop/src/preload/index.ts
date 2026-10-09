import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AppBridge } from '../shared/app-bridge';
import { createBackendBridge } from './backend';
import { createSetupBridge } from './setup';
import { createStartupBridge } from './startup';
import { createContactSessionBridge } from './contact-session';
import { createImportBridge } from './imports';
import { createReplyBridge } from './reply';
import { createMemoryBridge } from './memory';
import { createBindingConsentBridge } from './binding-consent';
import type { DesktopSettings } from '../shared/desktop-bridge';

const bridge: AppBridge = {
  backend: createBackendBridge(ipcRenderer),
  setup: createSetupBridge(),
  startup: createStartupBridge(ipcRenderer),
  contacts: createContactSessionBridge(ipcRenderer),
  imports: createImportBridge(),
  replies: createReplyBridge(ipcRenderer),
  memory: createMemoryBridge(ipcRenderer),
  bindings: createBindingConsentBridge(ipcRenderer),
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
