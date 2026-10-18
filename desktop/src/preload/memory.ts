import type { PageTransport } from './transport';
import type { ContactSelection } from '../shared/contact-session-bridge';
import type { LayeredMemoryReadRequest, LayeredMemoryManagementRequest, MemoryAdditionRequest, MemoryCandidateRequest, MemoryCandidateUpdateRequest, MemoryBridge, OwnerLayeredMemoryManagementRequest, OwnerLayeredMemoryState, MemoryCorrectionRequest, MemoryReadRequest, MemoryReadingState, MemoryRemovalRequest } from '../shared/memory-bridge';

export function createMemoryBridge(ipcRenderer: PageTransport): MemoryBridge {
  return Object.freeze({
    readOwnerMemories: (...args: unknown[]) => args.length === 0 ? ipcRenderer.invoke('memory:read-owner-facts') : Promise.reject(new Error('本人资料读取不可用。')),
    correctOwnerMemory: (...args: [Pick<MemoryCorrectionRequest, 'memoryId' | 'revision' | 'text' | 'category'>]) => args.length === 1 ? ipcRenderer.invoke('memory:correct-owner-fact', args[0]) : Promise.reject(new Error('本人资料修正不可用。')),
    deleteOwnerMemory: (...args: [Pick<MemoryRemovalRequest, 'memoryId' | 'revision'>]) => args.length === 1 ? ipcRenderer.invoke('memory:delete-owner-fact', args[0]) : Promise.reject(new Error('本人资料删除不可用。')),
    addOwnerMemory: (...args: [Pick<MemoryAdditionRequest, 'text' | 'category'>]) => args.length === 1 ? ipcRenderer.invoke('memory:add-owner', args[0]) : Promise.reject(new Error('本人资料补充不可用。')),
    getOwnerLayeredMemoryState: (...args: unknown[]) => args.length === 0 ? ipcRenderer.invoke('memory:owner-layered-state') : Promise.reject(new Error('本人资料读取不可用。')),
    readOwnerLayeredMemory: (...args: [{ mappingCursor?: string | null }]) => args.length === 1 ? ipcRenderer.invoke('memory:read-owner-layered', args[0]) : Promise.reject(new Error('本人资料读取不可用。')),
    manageOwnerLayeredMemory: (...args: [OwnerLayeredMemoryManagementRequest]) => args.length === 1 ? ipcRenderer.invoke('memory:manage-owner-layered', args[0]) : Promise.reject(new Error('本人资料操作不可用。')),
    onOwnerLayeredMemoryChanged: (listener: (state: OwnerLayeredMemoryState) => void) => {
      const receive = (_event: unknown, state: OwnerLayeredMemoryState) => listener(state);
      ipcRenderer.on('memory:owner-layered-changed', receive);
      return () => ipcRenderer.removeListener('memory:owner-layered-changed', receive);
    },
    getState: (...args: unknown[]) => args.length === 0 ? ipcRenderer.invoke('memory:get-state')
      : Promise.reject(new Error('资料读取不可用。')),
    refresh: (...args: [MemoryReadRequest]) => args.length === 1 ? ipcRenderer.invoke('memory:refresh', args[0])
      : Promise.reject(new Error('资料读取不可用。')),
    refreshOverview: (...args: [ContactSelection]) => args.length === 1 ? ipcRenderer.invoke('memory:refresh-overview', args[0])
      : Promise.reject(new Error('概览读取不可用。')),
    refreshOwnerOverview: (...args: [ContactSelection]) => args.length === 1 ? ipcRenderer.invoke('memory:refresh-owner-overview', args[0])
      : Promise.reject(new Error('本人概览读取不可用。')),
    readLayeredMemory: (...args: [LayeredMemoryReadRequest]) => args.length === 1 ? ipcRenderer.invoke('memory:read-layered-memory', args[0])
      : Promise.reject(new Error('主题资料读取不可用。')),
    manageLayeredMemory: (...args: [LayeredMemoryManagementRequest]) => args.length === 1 ? ipcRenderer.invoke('memory:manage-layered-memory', args[0])
      : Promise.reject(new Error('主题资料操作不可用。')),
    add: (...args: [MemoryAdditionRequest]) => args.length === 1 ? ipcRenderer.invoke('memory:add', args[0])
      : Promise.reject(new Error('资料补充不可用。')),
    remove: (...args: [MemoryRemovalRequest]) => args.length === 1 ? ipcRenderer.invoke('memory:remove', args[0])
      : Promise.reject(new Error('资料删除不可用。')),
    discardCandidate: (...args: [MemoryCandidateRequest]) => args.length === 1 ? ipcRenderer.invoke('memory:discard-candidate', args[0])
      : Promise.reject(new Error('候选丢弃不可用。')),
    confirmCandidate: (...args: [MemoryCandidateRequest]) => args.length === 1 ? ipcRenderer.invoke('memory:confirm-candidate', args[0])
      : Promise.reject(new Error('候选确认不可用。')),
    applyCandidateUpdate: (...args: [MemoryCandidateUpdateRequest]) => args.length === 1 ? ipcRenderer.invoke('memory:apply-candidate-update', args[0])
      : Promise.reject(new Error('候选版本更新不可用。')),
    correct: (...args: [MemoryCorrectionRequest]) => args.length === 1 ? ipcRenderer.invoke('memory:correct', args[0])
      : Promise.reject(new Error('资料修正不可用。')),
    openVersions: (...args: [MemoryRemovalRequest]) => args.length === 1 ? ipcRenderer.invoke('memory:open-versions', args[0])
      : Promise.reject(new Error('版本查看不可用。')),
    revertAutoUpdate: (...args: [MemoryRemovalRequest]) => args.length === 1 ? ipcRenderer.invoke('memory:revert-auto-update', args[0])
      : Promise.reject(new Error('自动更新撤销不可用。')),
    onStateChanged: (listener: (state: MemoryReadingState) => void) => {
      if (typeof listener !== 'function') throw new Error('资料读取不可用。');
      const receive = (_event: unknown, state: MemoryReadingState) => listener(state);
      ipcRenderer.on('memory:state-changed', receive);
      return () => ipcRenderer.removeListener('memory:state-changed', receive);
    },
  });
}
