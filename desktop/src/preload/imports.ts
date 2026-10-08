import { ipcRenderer } from 'electron';
import type { ImportBridge, ImportSelectionVersion, ImportState, ImportTarget } from '../shared/import-bridge';

export function createImportBridge(): ImportBridge {
  const noArguments = (channel: string, args: unknown[]) => args.length === 0
    ? ipcRenderer.invoke(channel) : Promise.reject(new Error('历史导入操作不可用。'));
  const oneArgument = (channel: string, args: unknown[]) => args.length === 1
    ? ipcRenderer.invoke(channel, args[0]) : Promise.reject(new Error('历史导入操作不可用。'));
  return Object.freeze({
    getState: (...args: unknown[]) => noArguments('imports:get-state', args),
    chooseFile: (...args: unknown[]) => noArguments('imports:choose-file', args),
    setTarget: (...args: [ImportTarget]) => oneArgument('imports:set-target', args),
    preview: (...args: [ImportSelectionVersion]) => oneArgument('imports:preview', args),
    confirmPreview: (...args: [ImportSelectionVersion]) => oneArgument('imports:confirm-preview', args),
    cancelConfirmation: (...args: [ImportSelectionVersion]) => oneArgument('imports:cancel-confirmation', args),
    onStateChanged: (listener: (state: ImportState) => void) => {
      if (typeof listener !== 'function') throw new Error('历史导入操作不可用。');
      const receive = (_event: unknown, state: ImportState) => listener(state);
      ipcRenderer.on('imports:state-changed', receive);
      return () => ipcRenderer.removeListener('imports:state-changed', receive);
    },
  });
}
