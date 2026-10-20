import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import type { ReplySession } from '../reply/session';
import type { PageCommands } from '../page-commands';
import { isUuid } from '../uuid';
import { CandidateProvenanceController } from './controller';
import type { CandidateTextCopy, CandidateTextPaste } from '../../shared/candidate-provenance-bridge';

function selection(args: unknown[], extra: string[] = [], textLimit = 4096): Record<string, unknown> {
  const value = args[0]; const keys = ['contactId', 'scopeRevision', ...extra];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('候选来源操作无效。');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || !Object.keys(row).every((key) => keys.includes(key))
    || !isUuid(row.contactId) || typeof row.scopeRevision !== 'number' || !Number.isSafeInteger(row.scopeRevision) || row.scopeRevision < 0
    || extra.some((key) => key === 'text' ? typeof row.text !== 'string' || row.text.length > textLimit : !isUuid(row[key]))) throw new Error('候选来源操作无效。');
  return { ...row, contactId: row.contactId.toLowerCase() };
}
function candidateCopy(args: unknown[]): CandidateTextCopy {
  const value = args[0];
  if (args.length === 1 && value && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'invalidSelection')) {
    const { invalidSelection, ...rest } = value as Record<string, unknown>;
    if (invalidSelection !== true) throw new Error('候选来源操作无效。');
    return { ...selection([rest], ['replyRequestId', 'candidateId', 'text'], 65_536), invalidSelection: true } as CandidateTextCopy;
  }
  return selection(args, ['replyRequestId', 'candidateId', 'text'], 65_536) as unknown as CandidateTextCopy;
}
function candidatePaste(args: unknown[]): CandidateTextPaste {
  const value = args[0];
  const version = value && typeof value === 'object' && !Array.isArray(value)
    && ['sessionId', 'versionId'].some((key) => Object.hasOwn(value, key));
  const selected = selection(args, ['replyRequestId', 'candidateId', 'text', ...(version ? ['sessionId', 'versionId'] : [])], 65_536);
  return selected as unknown as CandidateTextPaste;
}
export function installCandidateProvenanceBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession, replies: ReplySession) {
  const provenance = new CandidateProvenanceController(backend, contacts, replies);
  commands.handle('candidate-provenance:note-copy', (...args) => provenance.noteCandidateCopy(candidateCopy(args)), 'helper');
  commands.handle('candidate-provenance:validate-paste', (...args) => provenance.validateCandidatePaste(candidatePaste(args)), 'helper');
  return provenance;
}
