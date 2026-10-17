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
    retrySourceValidation: (...args: unknown[]) => ipcRenderer.invoke('reply:retry-source-validation', ...args),
    readSavedSession: (...args: unknown[]) => ipcRenderer.invoke('reply:read-saved-session', ...args),
    listSavedSessions: (...args: unknown[]) => ipcRenderer.invoke('reply:list-saved-sessions', ...args),
    newSavedSession: (...args: unknown[]) => ipcRenderer.invoke('reply:new-saved-session', ...args),
    newSavedSessionWithCandidate: (...args: unknown[]) => ipcRenderer.invoke('reply:new-with-candidate', ...args),
    selectSavedSession: (...args: unknown[]) => ipcRenderer.invoke('reply:select-saved-session', ...args),
    deleteSavedSession: (...args: unknown[]) => ipcRenderer.invoke('reply:delete-saved-session', ...args),
    reconnectMessages: (...args: unknown[]) => ipcRenderer.invoke('reply:reconnect-messages', ...args),
    combineNewMessages: (...args: unknown[]) => ipcRenderer.invoke('reply:combine-new-messages', ...args),
    selectMessage: (...args: unknown[]) => ipcRenderer.invoke('reply:select-message', ...args),
    updateDirection: (...args: unknown[]) => ipcRenderer.invoke('reply:update-direction', ...args),
    updateCorrection: (...args: unknown[]) => ipcRenderer.invoke('reply:update-correction', ...args),
    explore: (...args: unknown[]) => ipcRenderer.invoke('reply:explore', ...args),
    changeDirections: (...args: unknown[]) => ipcRenderer.invoke('reply:change-directions', ...args),
    beginClarificationEdit: (...args: unknown[]) => ipcRenderer.invoke('reply:begin-clarification-edit', ...args),
    answerClarification: (...args: unknown[]) => ipcRenderer.invoke('reply:answer-clarification', ...args),
    stopExploration: (...args: unknown[]) => ipcRenderer.invoke('reply:stop-exploration', ...args),
    retryExploration: (...args: unknown[]) => ipcRenderer.invoke('reply:retry-exploration', ...args),
    updateRequirements: (...args: unknown[]) => ipcRenderer.invoke('reply:update-requirements', ...args),
    updateSkill: (...args: unknown[]) => ipcRenderer.invoke('reply:update-skill', ...args),
    updateScene: (...args: unknown[]) => ipcRenderer.invoke('reply:update-scene', ...args),
    selectDirection: (...args: unknown[]) => ipcRenderer.invoke('reply:select-direction', ...args),
    updatePurpose: (...args: unknown[]) => ipcRenderer.invoke('reply:update-purpose', ...args),
    retryInterruptedGeneration: (...args: unknown[]) => ipcRenderer.invoke('reply:retry-interrupted-generation', ...args),
    generate: (selection: GenerateReply) => ipcRenderer.invoke('reply:generate', selection),
    continueSession: (...args: unknown[]) => ipcRenderer.invoke('reply:continue-session', ...args),
    confirmContinuation: (...args: unknown[]) => ipcRenderer.invoke('reply:confirm-continuation', ...args),
    retryContinuation: (...args: unknown[]) => ipcRenderer.invoke('reply:retry-continuation', ...args),
    selectCandidate: (selection: ReplyCandidateSelection) => ipcRenderer.invoke('reply:select-candidate', selection),
    editCandidate: (edit: ReplyCandidateEdit) => ipcRenderer.invoke('reply:edit-candidate', edit),
    updateCandidateVersionDraft: (...args: unknown[]) => ipcRenderer.invoke('reply:update-candidate-version-draft', ...args),
    beginCandidateVersionEdit: (...args: unknown[]) => ipcRenderer.invoke('reply:begin-candidate-version-edit', ...args),
    readCandidateVersions: (...args: unknown[]) => ipcRenderer.invoke('reply:read-candidate-versions', ...args),
    saveCandidateVersion: (...args: unknown[]) => ipcRenderer.invoke('reply:save-candidate-version', ...args),
    selectCandidateVersion: (...args: unknown[]) => ipcRenderer.invoke('reply:select-candidate-version', ...args),
    showCandidateVersion: (...args: unknown[]) => ipcRenderer.invoke('reply:show-candidate-version', ...args),
    onStateChanged: (listener: (state: ReplySessionState) => void) => {
      if (typeof listener !== 'function') throw new Error('本次表达操作不可用。');
      const receive = (_event: unknown, state: ReplySessionState) => listener(state);
      ipcRenderer.on('reply:state-changed', receive);
      return () => ipcRenderer.removeListener('reply:state-changed', receive);
    },
  });
}
