import { contextBridge, ipcRenderer } from 'electron';
import type { WindowBridge } from '../shared/window-bridge';

const bridge: WindowBridge = {
  openManager: () => ipcRenderer.invoke('window:open-manager'),
  openHelper: () => ipcRenderer.invoke('window:open-helper'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
};
contextBridge.exposeInMainWorld('notalone', Object.freeze(bridge));
