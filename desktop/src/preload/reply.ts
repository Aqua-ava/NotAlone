import type { PageTransport } from './transport';
import type { ReplyBridge, ReplySessionState, ReplyStateUpdate } from '../shared/reply-bridge';

export function createReplyBridge(ipcRenderer: PageTransport): ReplyBridge {
  let current: ReplySessionState | undefined;
  let reading: Promise<void> | undefined;
  let buffered: ReplyStateUpdate[] = [];
  const listeners = new Set<(state: ReplySessionState) => void>();
  const accept = (state: ReplySessionState) => {
    if (current && state.revision <= current.revision) return;
    current = state;
    for (const listener of listeners) listener(state);
  };
  const apply = (event: ReplyStateUpdate): boolean => {
    if (event.kind === 'snapshot') { accept(event.state); return true; }
    if (current && event.revision <= current.revision) return true;
    if (!current || event.baseRevision !== current.revision || event.contactId !== current.contactId
      || event.scopeRevision !== current.scopeRevision) return false;
    accept({ ...current, ...event.changes, revision: event.revision });
    return true;
  };
  const getState = async () => {
    const state: ReplySessionState = await ipcRenderer.invoke('reply:get-state');
    if (listeners.size) {
      accept(state);
      buffered = buffered.filter(event => !apply(event));
    }
    return state;
  };
  const synchronize = () => {
    if (reading) return;
    let succeeded = false;
    reading = getState().then(() => { succeeded = true; }).catch(() => {}).finally(() => {
      reading = undefined;
      if (succeeded && buffered.length && listeners.size) synchronize();
    });
  };
  const receiveUpdate = (_event: unknown, event: ReplyStateUpdate) => {
    if (!apply(event)) { buffered.push(event); synchronize(); }
  };
  return Object.freeze({
    getState: (...args: unknown[]) => args.length === 0 ? getState() : Promise.reject(new Error('本次表达操作不可用。')),
    onStateUpdated: (listener: (update: ReplyStateUpdate) => void) => {
      if (typeof listener !== 'function') throw new Error('本次表达操作不可用。');
      const receive = (_event: unknown, event: ReplyStateUpdate) => listener(event);
      ipcRenderer.on('reply:state-updated', receive);
      return () => ipcRenderer.removeListener('reply:state-updated', receive);
    },
    retrySourceValidation: (...args: unknown[]) => ipcRenderer.invoke('reply:retry-source-validation', ...args),
    readSavedSession: (...args: unknown[]) => ipcRenderer.invoke('reply:read-saved-session', ...args),
    listSavedSessions: (...args: unknown[]) => ipcRenderer.invoke('reply:list-saved-sessions', ...args),
    newSavedSession: (...args: unknown[]) => ipcRenderer.invoke('reply:new-saved-session', ...args),
    viewSavedSession: (...args: unknown[]) => ipcRenderer.invoke('reply:view-saved-session', ...args),
    resumeSavedSession: (...args: unknown[]) => ipcRenderer.invoke('reply:resume-saved-session', ...args),
    deleteSavedSession: (...args: unknown[]) => ipcRenderer.invoke('reply:delete-saved-session', ...args),
    onStateChanged: (listener: (state: ReplySessionState) => void) => {
      if (typeof listener !== 'function') throw new Error('本次表达操作不可用。');
      const first = !listeners.size;
      if (first) {
        buffered = [];
        ipcRenderer.on('reply:state-updated', receiveUpdate);
      }
      listeners.add(listener);
      if (first) void ipcRenderer.invoke('reply:subscribe').catch(() => synchronize());
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { ipcRenderer.removeListener('reply:state-updated', receiveUpdate); buffered = []; current = undefined; }
      };
    },
  });
}
