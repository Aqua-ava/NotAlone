import type { ContactSelection } from '../../shared/contact-session-bridge';
import type { ExpressionPreferenceRemoval, ExpressionPreferenceSave, ExpressionPreferenceUpdate } from '../../shared/expression-preference-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { noArguments, type PageCommands } from '../page-commands';
import { isUuid } from '../uuid';
import { ExpressionPreferenceController } from './controller';

function selection(args: unknown[], extra: string[] = []): Record<string, unknown> & ContactSelection {
  const value = args[0];
  const keys = ['contactId', 'scopeRevision', ...extra];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('长期偏好操作无效。');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== keys.length || !Object.keys(fields).every((key) => keys.includes(key))
    || !isUuid(fields.contactId) || !Number.isSafeInteger(fields.scopeRevision) || (fields.scopeRevision as number) < 0) {
    throw new Error('长期偏好操作无效。');
  }
  return { ...fields, contactId: fields.contactId.toLowerCase(), scopeRevision: fields.scopeRevision as number };
}
function save(args: unknown[], update = false): ExpressionPreferenceSave | ExpressionPreferenceUpdate {
  const fields = selection(args, ['text', 'appliesTo', 'replyMode', 'confirmLongTerm',
    ...(update ? ['preferenceId', 'expectedRevision'] : [])]);
  if (typeof fields.text !== 'string' || !fields.text.trim() || fields.text.trim().length > 512
    || !['owner', 'contact'].includes(fields.appliesTo as string) || fields.confirmLongTerm !== true
    || fields.replyMode !== null && !['reply_to_message', 'rewrite_draft', 'initiate_conversation'].includes(fields.replyMode as string)
    || update && (!isUuid(fields.preferenceId) || !Number.isSafeInteger(fields.expectedRevision) || (fields.expectedRevision as number) < 1)) {
    throw new Error('请明确长期保存，并核对偏好内容与适用范围。');
  }
  return fields as unknown as ExpressionPreferenceSave | ExpressionPreferenceUpdate;
}
function removal(args: unknown[]): ExpressionPreferenceRemoval {
  const fields = selection(args, ['preferenceId', 'expectedRevision']);
  if (!isUuid(fields.preferenceId) || !Number.isSafeInteger(fields.expectedRevision) || (fields.expectedRevision as number) < 1) {
    throw new Error('长期偏好操作无效。');
  }
  return fields as unknown as ExpressionPreferenceRemoval;
}
export function installExpressionPreferenceBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession,
  deletion?: { started(): void; settled(): Promise<void> }) {
  const preferences = new ExpressionPreferenceController(backend, contacts, deletion);
  preferences.onStateChanged((state) => commands.publish('expression-preferences:state-changed', state, 'helper'));
  contacts.onStateChanged(() => preferences.synchronizeScope());
  backend.onStateChanged(() => preferences.synchronizeScope());
  preferences.synchronizeScope();
  commands.handle('expression-preferences:get-state', (...args) => { noArguments(args); return preferences.getState(); }, 'helper');
  commands.handle('expression-preferences:refresh', (...args) => preferences.refresh(selection(args)), 'helper');
  commands.handle('expression-preferences:save', (...args) => preferences.save(save(args)), 'helper');
  commands.handle('expression-preferences:update', (...args) => preferences.update(save(args, true) as ExpressionPreferenceUpdate), 'helper');
  commands.handle('expression-preferences:remove', (...args) => preferences.remove(removal(args)), 'helper');
  return preferences;
}
