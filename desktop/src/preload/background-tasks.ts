import type {
  BackgroundTaskBridge,
  BackgroundTaskSelection,
  BackgroundTaskState,
} from '../shared/background-task-bridge';
import type { PageTransport } from './transport';

export function createBackgroundTaskBridge(ipcRenderer: PageTransport): BackgroundTaskBridge {
  return Object.freeze({
    read: (...args: [BackgroundTaskSelection]) => args.length === 1
      ? ipcRenderer.invoke('background-tasks:read', args[0])
      : Promise.reject(new Error('后台任务读取不可用。')),
    stop: (...args: [BackgroundTaskSelection & { taskId: string }]) => args.length === 1
      ? ipcRenderer.invoke('background-tasks:stop', args[0])
      : Promise.reject(new Error('后台任务停止不可用。')),
    recover: (...args: [BackgroundTaskSelection & { taskId: string }]) => args.length === 1
      ? ipcRenderer.invoke('background-tasks:recover', args[0])
      : Promise.reject(new Error('后台任务恢复不可用。')),
    cancelRead: (...args: [BackgroundTaskSelection]) => args.length === 1
      ? ipcRenderer.invoke('background-tasks:cancel-read', args[0])
      : Promise.reject(new Error('后台任务读取不可用。')),
    getState: (...args: unknown[]) => args.length === 0
      ? ipcRenderer.invoke('background-tasks:get-state')
      : Promise.reject(new Error('后台任务读取不可用。')),
    onStateChanged: (listener: (state: BackgroundTaskState) => void) => {
      if (typeof listener !== 'function') throw new Error('后台任务读取不可用。');
      const receive = (_event: unknown, state: Parameters<typeof listener>[0]) => listener(state);
      ipcRenderer.on('background-tasks:state-changed', receive);
      return () => ipcRenderer.removeListener('background-tasks:state-changed', receive);
    },
  });
}
