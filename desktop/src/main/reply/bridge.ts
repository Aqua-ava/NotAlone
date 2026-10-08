import { ipcMain } from 'electron';
import type { GenerateRewrite, ReplyCandidateEdit, ReplyCandidateSelection, RewriteOptions, RewriteOptionsUpdate } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import type { AppWindows } from '../windows';
import { ReplySession } from './session';

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
function fields(args: unknown[], keys: string[]): Record<string, unknown> {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !Object.keys(value).every((key) => keys.includes(key))) {
    throw new Error('本次表达操作不可用。');
  }
  const record = value as Record<string, unknown>;
  if (!uuid(record.contactId) || typeof record.scopeRevision !== 'number'
    || !Number.isSafeInteger(record.scopeRevision) || record.scopeRevision < 0) throw new Error('本次表达操作不可用。');
  return { ...record, contactId: record.contactId.toLowerCase() };
}
function candidate(args: unknown[], editing = false): ReplyCandidateSelection | ReplyCandidateEdit {
  const value = fields(args, ['contactId', 'scopeRevision', 'replyRequestId', 'candidateId', ...(editing ? ['text'] : [])]);
  if (!uuid(value.replyRequestId) || !uuid(value.candidateId)
    || (editing && (typeof value.text !== 'string' || value.text.length > 65_536))) throw new Error('本次候选操作不可用。');
  return { ...value, replyRequestId: value.replyRequestId.toLowerCase(), candidateId: value.candidateId.toLowerCase() } as unknown as ReplyCandidateEdit;
}
function options(args: unknown[]): RewriteOptionsUpdate {
  const value = fields(args, ['contactId', 'scopeRevision', 'options']);
  const settings = value.options as Record<string, unknown> | undefined;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).length !== 3
    || !Object.keys(settings).every((key) => ['tone', 'instruction', 'includeRelationshipContext'].includes(key))
    || !['original', 'warm', 'concise', 'polite'].includes(settings.tone as string)
    || typeof settings.instruction !== 'string' || settings.instruction.length > 4096
    || typeof settings.includeRelationshipContext !== 'boolean') throw new Error('本次改写要求不可用。');
  return { contactId: value.contactId as string, scopeRevision: value.scopeRevision as number, options: { ...settings } as unknown as RewriteOptions };
}

export function installReplyBridge(windows: AppWindows, backend: BackendHost, contacts: ContactSession): ReplySession {
  const replies = new ReplySession(contacts, backend);
  replies.onStateChanged((state) => windows.publish('reply:state-changed', state));
  const helper = (event: Parameters<AppWindows['validateCaller']>[0]) => {
    const window = windows.validateCaller(event, []);
    if (window.webContents.getURL() !== 'notalone://app/index.html#helper') throw new Error('请在输入小窗操作本次表达。');
  };
  ipcMain.handle('reply:get-state', (event, ...args: unknown[]) => { windows.validateCaller(event, args); return replies.getState(); });
  ipcMain.handle('reply:update-options', (event, ...args: unknown[]) => { helper(event); return replies.updateOptions(options(args)); });
  ipcMain.handle('reply:generate', (event, ...args: unknown[]) => {
    helper(event);
    const value = fields(args, ['contactId', 'scopeRevision', 'newRequest']);
    if (typeof value.newRequest !== 'boolean') throw new Error('本次生成操作不可用。');
    return replies.generate(value as unknown as GenerateRewrite);
  });
  ipcMain.handle('reply:select-candidate', (event, ...args: unknown[]) => { helper(event); return replies.selectCandidate(candidate(args)); });
  ipcMain.handle('reply:edit-candidate', (event, ...args: unknown[]) => { helper(event); return replies.editCandidate(candidate(args, true) as ReplyCandidateEdit); });
  return replies;
}
