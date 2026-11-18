import { pageInvokers, subscribePageState, type PageTransport } from './transport';
import type { StartupBridge, StartupState } from '../shared/startup-bridge';

export function createStartupBridge(ipcRenderer: PageTransport): StartupBridge {
  const { empty } = pageInvokers(ipcRenderer, '启动诊断不可用');
  return Object.freeze({
    previewDiagnostics: (...args: unknown[]) => empty('startup:preview-diagnostics', args),
    exportDiagnostics: (...args: unknown[]) => args.length === 1 && typeof args[0] === 'string' && args[0].length <= 64
      ? ipcRenderer.invoke('startup:export-diagnostics', args[0]) : Promise.reject(new Error('请先预览诊断')),
    getState: (...args: unknown[]) => empty('startup:get-state', args),
    getPaths: (...args: unknown[]) => empty('startup:get-paths', args),
    savePaths: (...args: unknown[]) => args.length === 1 ? ipcRenderer.invoke('startup:save-paths', args[0]) : Promise.reject(new Error('启动路径无效')),
    retry: (...args: unknown[]) => empty('startup:retry', args),
    revealUpdateBackup: (...args: unknown[]) => empty('startup:reveal-update-backup', args),
    onStateChanged: (listener: (state: StartupState) => void) =>
      subscribePageState(ipcRenderer, 'startup:state-changed', listener, '启动诊断不可用'),
  });
}
