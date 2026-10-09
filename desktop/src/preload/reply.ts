import type { PageTransport } from './transport';
import type { GenerateReply, ReplyBridge, ReplyCandidateEdit, ReplyCandidateSelection, ReplySessionState, RewriteOptionsUpdate } from '../shared/reply-bridge';
import type { ReplyEvidenceState } from '../shared/reply-evidence';

export function createReplyBridge(ipcRenderer: PageTransport): ReplyBridge {
  return Object.freeze({
    getEvidenceState: (...args: unknown[]) => args.length === 0 ? ipcRenderer.invoke('reply:get-evidence-state') : Promise.reject(new Error('候选依据不可用。')),
    loadEvidence: (...args: unknown[]) => ipcRenderer.invoke('reply:load-evidence', ...args),
    closeEvidence: (...args: unknown[]) => ipcRenderer.invoke('reply:close-evidence', ...args),
    onEvidenceChanged: (listener: (state: ReplyEvidenceState) => void) => {
      if (typeof listener !== 'function') throw new Error('候选依据不可用。');
      const receive = (_event: unknown, state: ReplyEvidenceState) => listener(state);
      ipcRenderer.on('reply:evidence-changed', receive);
      return () => ipcRenderer.removeListener('reply:evidence-changed', receive);
    },
    getState: (...args: unknown[]) => args.length === 0 ? ipcRenderer.invoke('reply:get-state') : Promise.reject(new Error('本次表达操作不可用。')),
    updateOptions: (update: RewriteOptionsUpdate) => ipcRenderer.invoke('reply:update-options', update),
    setMode: (...args: unknown[]) => ipcRenderer.invoke('reply:set-mode', ...args),
    loadMessages: (...args: unknown[]) => ipcRenderer.invoke('reply:load-messages', ...args),
    reconnectMessages: (...args: unknown[]) => ipcRenderer.invoke('reply:reconnect-messages', ...args),
    selectMessage: (...args: unknown[]) => ipcRenderer.invoke('reply:select-message', ...args),
    updateDirection: (...args: unknown[]) => ipcRenderer.invoke('reply:update-direction', ...args),
    generate: (selection: GenerateReply) => ipcRenderer.invoke('reply:generate', selection),
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
