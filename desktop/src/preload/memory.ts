import type { PageTransport } from './transport';
import type { MemoryAdditionRequest, MemoryBridge, MemoryCorrectionRequest, MemoryReadRequest, MemoryReadingState } from '../shared/memory-bridge';

export function createMemoryBridge(ipcRenderer: PageTransport): MemoryBridge {
  return Object.freeze({
    getState: (...args: unknown[]) => args.length === 0 ? ipcRenderer.invoke('memory:get-state')
      : Promise.reject(new Error('资料读取不可用。')),
    refresh: (...args: [MemoryReadRequest]) => args.length === 1 ? ipcRenderer.invoke('memory:refresh', args[0])
      : Promise.reject(new Error('资料读取不可用。')),
    add: (...args: [MemoryAdditionRequest]) => args.length === 1 ? ipcRenderer.invoke('memory:add', args[0])
      : Promise.reject(new Error('资料补充不可用。')),
    correct: (...args: [MemoryCorrectionRequest]) => args.length === 1 ? ipcRenderer.invoke('memory:correct', args[0])
      : Promise.reject(new Error('资料修正不可用。')),
    onStateChanged: (listener: (state: MemoryReadingState) => void) => {
      if (typeof listener !== 'function') throw new Error('资料读取不可用。');
      const receive = (_event: unknown, state: MemoryReadingState) => listener(state);
      ipcRenderer.on('memory:state-changed', receive);
      return () => ipcRenderer.removeListener('memory:state-changed', receive);
    },
  });
}
