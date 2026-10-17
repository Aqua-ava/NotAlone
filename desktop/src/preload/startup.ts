import type { PageTransport } from './transport';
import type { DatabaseUpdateState, StartupBridge, StartupState } from '../shared/startup-bridge';

export function createStartupBridge(ipcRenderer: PageTransport): StartupBridge {
  const invoke = (channel: string, args: unknown[]) => args.length === 0
    ? ipcRenderer.invoke(channel) : Promise.reject(new Error('启动诊断不可用'));
  return Object.freeze({
    getState: (...args: unknown[]) => invoke('startup:get-state', args),
    getPaths: (...args: unknown[]) => invoke('startup:get-paths', args),
    savePaths: (...args: unknown[]) => args.length === 1 ? ipcRenderer.invoke('startup:save-paths', args[0]) : Promise.reject(new Error('启动路径无效')),
    retry: (...args: unknown[]) => invoke('startup:retry', args),
    prepareConfiguration: (...args: unknown[]) => invoke('startup:prepare-configuration', args),
    beginLocalSetup: (...args: unknown[]) => invoke('startup:begin-local-setup', args),
    cancelLocalSetup: (...args: unknown[]) => invoke('startup:cancel-local-setup', args),
    getDataUpdateState: (...args: unknown[]) => invoke('startup:get-data-update-state', args),
    backupAndUpdate: (...args: unknown[]) => invoke('startup:backup-and-update', args),
    revealUpdateBackup: (...args: unknown[]) => invoke('startup:reveal-update-backup', args),
    recheckDataUpdate: (...args: unknown[]) => invoke('startup:recheck-data-update', args),
    revealUpdateRecovery: (...args: unknown[]) => invoke('startup:reveal-update-recovery', args),
    onDataUpdateChanged: (listener: (state: DatabaseUpdateState) => void) => {
      if (typeof listener !== 'function') throw new Error('资料更新不可用');
      const receive = (_event: unknown, state: DatabaseUpdateState) => listener(state);
      ipcRenderer.on('startup:data-update-changed', receive);
      return () => ipcRenderer.removeListener('startup:data-update-changed', receive);
    },
    onStateChanged: (listener: (state: StartupState) => void) => {
      if (typeof listener !== 'function') throw new Error('启动诊断不可用');
      const receive = (_event: unknown, state: StartupState) => listener(state);
      ipcRenderer.on('startup:state-changed', receive);
      return () => ipcRenderer.removeListener('startup:state-changed', receive);
    },
  });
}
