import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { WindowBridge } from '../shared/window-bridge';
import type { DesktopSettings } from '../shared/desktop-bridge';

const bridge: WindowBridge = {
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
