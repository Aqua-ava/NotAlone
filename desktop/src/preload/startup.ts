import type { PageTransport } from './transport';
import type { StartupBridge, StartupState } from '../shared/startup-bridge';

export function createStartupBridge(ipcRenderer: PageTransport): StartupBridge {
  const invoke = (channel: string, args: unknown[]) => args.length === 0
    ? ipcRenderer.invoke(channel) : Promise.reject(new Error('启动诊断不可用'));
  return Object.freeze({
    getState: (...args: unknown[]) => invoke('startup:get-state', args),
    getPaths: (...args: unknown[]) => invoke('startup:get-paths', args),
    savePaths: (...args: unknown[]) => args.length === 1 ? ipcRenderer.invoke('startup:save-paths', args[0]) : Promise.reject(new Error('启动路径无效')),
    retry: (...args: unknown[]) => invoke('startup:retry', args),
    prepareConfiguration: (...args: unknown[]) => invoke('startup:prepare-configuration', args),
    onStateChanged: (listener: (state: StartupState) => void) => {
      if (typeof listener !== 'function') throw new Error('启动诊断不可用');
      const receive = (_event: unknown, state: StartupState) => listener(state);
      ipcRenderer.on('startup:state-changed', receive);
      return () => ipcRenderer.removeListener('startup:state-changed', receive);
    },
  });
}
