import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import type { ReplySession } from '../reply/session';
import { noArguments, type PageCommands } from '../page-commands';
import { isUuid } from '../uuid';
import { StyleSampleController } from './controller';
import type { ContactSelection } from '../../shared/contact-session-bridge';
import type { ReplyCandidateSelection } from '../../shared/reply-bridge';
import type { CandidateTextCopy, CandidateStylePaste, CandidateVersionStyleSampleSave, SavedSampleTextCopy, ManualStyleText, ManualStyleUpdate } from '../../shared/style-sample-bridge';

function selection(args: unknown[], extra: string[] = [], textLimit = 4096): Record<string, unknown> {
  const value = args[0]; const keys = ['contactId', 'scopeRevision', ...extra];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('样本操作无效。');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || !Object.keys(row).every((key) => keys.includes(key))
    || !isUuid(row.contactId) || typeof row.scopeRevision !== 'number' || !Number.isSafeInteger(row.scopeRevision) || row.scopeRevision < 0
    || extra.some((key) => key === 'text' ? typeof row.text !== 'string' || row.text.length > textLimit : !isUuid(row[key]))) throw new Error('样本操作无效。');
  return { ...row, contactId: row.contactId.toLowerCase() };
}
function candidateCopy(args: unknown[]): CandidateTextCopy {
  const value = args[0];
  if (args.length === 1 && value && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'invalidSelection')) {
    const { invalidSelection, ...rest } = value as Record<string, unknown>;
    if (invalidSelection !== true) throw new Error('样本操作无效。');
    return { ...selection([rest], ['replyRequestId', 'candidateId', 'text'], 65_536), invalidSelection: true } as CandidateTextCopy;
  }
  return selection(args, ['replyRequestId', 'candidateId', 'text'], 65_536) as unknown as CandidateTextCopy;
}
function candidateSample(args: unknown[]): ReplyCandidateSelection | CandidateVersionStyleSampleSave {
  const value = args[0];
  const version = value && typeof value === 'object' && !Array.isArray(value)
    && ['sessionId', 'versionId', 'text'].some((key) => Object.hasOwn(value, key));
  const selected = selection(args, ['replyRequestId', 'candidateId', ...(version ? ['sessionId', 'versionId', 'text'] : [])]);
  return selected as unknown as ReplyCandidateSelection | CandidateVersionStyleSampleSave;
}
function candidatePaste(args: unknown[]): CandidateStylePaste {
  const value = args[0];
  const version = value && typeof value === 'object' && !Array.isArray(value)
    && ['sessionId', 'versionId'].some((key) => Object.hasOwn(value, key));
  const selected = selection(args, ['replyRequestId', 'candidateId', 'text', ...(version ? ['sessionId', 'versionId'] : [])], 65_536);
  return selected as unknown as CandidateStylePaste;
}
function manualUpdate(args: unknown[]): ManualStyleUpdate {
  const value = args[0];
  if (args.length === 1 && value && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'cancelPasteId')) {
    const { cancelPasteId, ...rest } = value as Record<string, unknown>;
    if (!isUuid(cancelPasteId)) throw new Error('样本操作无效。');
    return { ...selection([rest], ['text']), cancelPasteId } as ManualStyleUpdate;
  }
  if (args.length === 1 && value && typeof value === 'object' && !Array.isArray(value)
    && (Object.hasOwn(value, 'pasteId') || Object.hasOwn(value, 'pastedText') || Object.hasOwn(value, 'insertedText'))) {
    const { pasteId, pastedText, insertedText, ...rest } = value as Record<string, unknown>;
    if (!isUuid(pasteId) || typeof pastedText !== 'string' || !pastedText.trim() || pastedText.length > 65_536
      || (Object.hasOwn(value, 'insertedText') && (typeof insertedText !== 'string' || !insertedText.trim() || insertedText.length > 4096))) throw new Error('样本操作无效。');
    return { ...selection([rest], ['text']), pasteId, pastedText,
      ...(insertedText === undefined ? {} : { insertedText }) } as ManualStyleUpdate;
  }
  return selection(args, ['text']) as unknown as ManualStyleUpdate;
}
export function installStyleSampleBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession, replies: ReplySession) {
  const samples = new StyleSampleController(backend, contacts, replies);
  samples.onStateChanged((state) => commands.publish('style-samples:state-changed', state));
  commands.handle('style-samples:get-state', (...args) => { noArguments(args); return samples.getState(); }, 'helper');
  commands.handle('style-samples:refresh', (...args) => samples.refresh(selection(args) as unknown as ContactSelection), 'helper');
  commands.handle('style-samples:save-manual', (...args) => samples.saveManual(selection(args, ['text']) as unknown as ContactSelection & { text: string }), 'helper');
  commands.handle('style-samples:save-candidate', (...args) => samples.saveCandidate(candidateSample(args)), 'helper');
  commands.handle('style-samples:save-message', (...args) => samples.saveMessage(selection(args, ['messageId']) as unknown as ContactSelection & { messageId: string }), 'helper');
  commands.handle('style-samples:delete', (...args) => samples.deleteSample(selection(args, ['sampleId']) as unknown as ContactSelection & { sampleId: string }), 'helper');
  commands.handle('style-samples:note-candidate-copy', (...args) => samples.noteCandidateCopy(candidateCopy(args)), 'helper');
  commands.handle('style-samples:note-sample-copy', (...args) => samples.noteSavedSampleCopy(selection(args, ['sampleId', 'text'], 65_536) as unknown as SavedSampleTextCopy), 'helper');
  commands.handle('style-samples:validate-candidate-paste', (...args) => samples.validateCandidatePaste(candidatePaste(args)), 'helper');
  commands.handle('style-samples:update-manual-text', (...args) => samples.updateManualText(manualUpdate(args)), 'helper');
  commands.handle('style-samples:note-manual-paste', (...args) => samples.noteManualPaste(selection(args, ['text'], 65_536) as unknown as ManualStyleText), 'helper');
  return samples;
}
