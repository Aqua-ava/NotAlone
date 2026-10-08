import { contextBridge, ipcRenderer } from 'electron';
import type { AppBridge } from '../shared/app-bridge';
import { createBackendBridge } from './backend';

const bridge: AppBridge = {
  backend: createBackendBridge(),
  openManager: () => ipcRenderer.invoke('window:open-manager'),
  openHelper: () => ipcRenderer.invoke('window:open-helper'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
};
contextBridge.exposeInMainWorld('notalone', Object.freeze(bridge));
