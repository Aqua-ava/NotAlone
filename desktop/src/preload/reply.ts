import type { PageTransport } from './transport';
import type { GenerateRewrite, ReplyBridge, ReplyCandidateEdit, ReplyCandidateSelection, ReplySessionState, RewriteOptionsUpdate } from '../shared/reply-bridge';

export function createReplyBridge(ipcRenderer: PageTransport): ReplyBridge {
  return Object.freeze({
    getState: (...args: unknown[]) => args.length === 0 ? ipcRenderer.invoke('reply:get-state') : Promise.reject(new Error('本次表达操作不可用。')),
    updateOptions: (update: RewriteOptionsUpdate) => ipcRenderer.invoke('reply:update-options', update),
    generate: (selection: GenerateRewrite) => ipcRenderer.invoke('reply:generate', selection),
    selectCandidate: (selection: ReplyCandidateSelection) => ipcRenderer.invoke('reply:select-candidate', selection),
    editCandidate: (edit: ReplyCandidateEdit) => ipcRenderer.invoke('reply:edit-candidate', edit),
    onStateChanged: (listener: (state: ReplySessionState) => void) => {
      if (typeof listener !== 'function') throw new Error('本次表达操作不可用。');
      const receive = (_event: unknown, state: ReplySessionState) => listener(state);
      ipcRenderer.on('reply:state-changed', receive);
      return () => ipcRenderer.removeListener('reply:state-changed', receive);
    },
  });
}
