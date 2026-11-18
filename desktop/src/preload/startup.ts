import { subscribePageState, type PageTransport } from './transport';
import type { StartupBridge, StartupState } from '../shared/startup-bridge';

export function createStartupBridge(ipcRenderer: PageTransport): StartupBridge {
  const invoke = (channel: string, args: unknown[]) => args.length === 0
    ? ipcRenderer.invoke(channel) : Promise.reject(new Error('启动诊断不可用'));
  return Object.freeze({
    previewDiagnostics: (...args: unknown[]) => invoke('startup:preview-diagnostics', args),
    exportDiagnostics: (...args: unknown[]) => args.length === 1 && typeof args[0] === 'string' && args[0].length <= 64
      ? ipcRenderer.invoke('startup:export-diagnostics', args[0]) : Promise.reject(new Error('请先预览诊断')),
    getState: (...args: unknown[]) => invoke('startup:get-state', args),
    getPaths: (...args: unknown[]) => invoke('startup:get-paths', args),
    savePaths: (...args: unknown[]) => args.length === 1 ? ipcRenderer.invoke('startup:save-paths', args[0]) : Promise.reject(new Error('启动路径无效')),
    retry: (...args: unknown[]) => invoke('startup:retry', args),
    revealUpdateBackup: (...args: unknown[]) => invoke('startup:reveal-update-backup', args),
    onStateChanged: (listener: (state: StartupState) => void) =>
      subscribePageState(ipcRenderer, 'startup:state-changed', listener, '启动诊断不可用'),
  });
}
